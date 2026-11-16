// Redis-backed session store. Takes any client with `send(command, args)`, such as Bun's `RedisClient`.
import type { SessionData, SessionStore } from './index';

/**
 * The part of a Redis client the store uses. Bun's `RedisClient` (`new RedisClient(url)` from `bun`)
 * and `Bun.redis` have it; another client fits with a small adapter.
 */
export interface RedisCommandClient {
  send(command: string, args: string[]): Promise<unknown>;
}

export interface RedisSessionStoreOptions {
  /** Prepended to every session ID to form the key. Default `kivin:sess:`. */
  prefix?: string;
}

/**
 * Sessions in Redis, shared by every instance. Each session is one string key holding the JSON data,
 * with the session lifetime as its expiry (`SET … PX`); Redis drops expired sessions itself.
 *
 * ```ts
 * import { RedisClient } from 'bun';
 * createSessionMiddleware({ secret, store: new RedisSessionStore(new RedisClient(process.env.REDIS_URL)) });
 * ```
 */
export class RedisSessionStore implements SessionStore {
  private readonly prefix: string;

  constructor(private readonly client: RedisCommandClient, options: RedisSessionStoreOptions = {}) {
    this.prefix = options.prefix ?? 'kivin:sess:';
  }

  async get(id: string) {
    const value = await this.client.send('GET', [this.prefix + id]);
    return value === null || value === undefined ? undefined : (JSON.parse(String(value)) as SessionData);
  }

  async set(id: string, data: SessionData, ttlSeconds: number) {
    const ms = toMilliseconds(ttlSeconds);
    // `SET … PX` rejects a non-positive expiry; such a session is already expired, as in MemorySessionStore.
    await (ms > 0 ? this.client.send('SET', [this.prefix + id, JSON.stringify(data), 'PX', String(ms)]) : this.client.send('DEL', [this.prefix + id]));
  }

  async touch(id: string, _data: SessionData, ttlSeconds: number) {
    // A missing (expired) session stays missing; a non-positive expiry deletes it.
    await this.client.send('PEXPIRE', [this.prefix + id, String(toMilliseconds(ttlSeconds))]);
  }

  async delete(id: string) {
    await this.client.send('DEL', [this.prefix + id]);
  }
}

function toMilliseconds(seconds: number) {
  return Math.ceil(seconds * 1000);
}
