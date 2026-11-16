// Redis-backed response cache store. Takes any client with `send(command, args)`, such as Bun's `RedisClient`.
import type { CacheRecord, ResponseCacheStore } from './cache';

/**
 * The part of a Redis client the store uses. Bun's `RedisClient` (`new RedisClient(url)` from `bun`)
 * and `Bun.redis` have it; another client fits with a small adapter.
 */
export interface RedisCommandClient {
  send(command: string, args: string[]): Promise<unknown>;
}

export interface RedisCacheStoreOptions {
  /** Prepended to every key (`<prefix>entry:…` and `<prefix>tag:…`). Default `kivin:cache:`. */
  prefix?: string;
}

// SET the entry with its expiry and file it under each tag, keeping every tag set alive at least as
// long as its longest-lived entry. One script so a crash cannot leave an entry outside its tags.
const SET_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
local ttl = tonumber(ARGV[2])
for i = 2, #KEYS do
  redis.call('SADD', KEYS[i], KEYS[1])
  if redis.call('PTTL', KEYS[i]) < ttl then
    redis.call('PEXPIRE', KEYS[i], ttl)
  end
end
return 1
`;

// DEL every key in the tag set (in batches: unpack has a stack limit) and the set itself.
const DELETE_TAG_SCRIPT = `
local keys = redis.call('SMEMBERS', KEYS[1])
for i = 1, #keys, 500 do
  redis.call('DEL', unpack(keys, i, math.min(i + 499, #keys)))
end
redis.call('DEL', KEYS[1])
return #keys
`;

type Serialized =
  | { kind: 'vary'; names: string[] }
  | { kind: 'response'; status: number; statusText: string; headers: Array<[string, string]>; body: string; storedAt: number };

/**
 * Cached responses in Redis, shared by every instance: one string key per entry (JSON, body in
 * base64) expiring with the entry, and one set per tag listing its keys.
 *
 * ```ts
 * import { RedisClient } from 'bun';
 * createResponseCache({ store: new RedisCacheStore(new RedisClient(process.env.REDIS_URL)) });
 * ```
 */
export class RedisCacheStore implements ResponseCacheStore {
  private readonly prefix: string;

  constructor(private readonly client: RedisCommandClient, options: RedisCacheStoreOptions = {}) {
    this.prefix = options.prefix ?? 'kivin:cache:';
  }

  async get(key: string): Promise<CacheRecord | undefined> {
    const value = await this.client.send('GET', [this.entryKey(key)]);
    if (value === null || value === undefined) {
      return undefined;
    }
    const record = JSON.parse(String(value)) as Serialized;
    return record.kind === 'vary' ? record : { ...record, body: new Uint8Array(Buffer.from(record.body, 'base64')) };
  }

  async set(key: string, record: CacheRecord, ttlMs: number, tags: readonly string[]) {
    const ms = Math.ceil(ttlMs);
    if (ms <= 0) {
      return;
    }
    const serialized: Serialized = record.kind === 'vary' ? record : { ...record, body: Buffer.from(record.body).toString('base64') };
    const keys = [this.entryKey(key), ...tags.map((tag) => this.tagKey(tag))];
    await this.client.send('EVAL', [SET_SCRIPT, String(keys.length), ...keys, JSON.stringify(serialized), String(ms)]);
  }

  async deleteTag(tag: string) {
    await this.client.send('EVAL', [DELETE_TAG_SCRIPT, '1', this.tagKey(tag)]);
  }

  private entryKey(key: string) {
    return `${this.prefix}entry:${key}`;
  }

  private tagKey(tag: string) {
    return `${this.prefix}tag:${tag}`;
  }
}
