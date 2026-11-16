// Redis-backed counters for createRateLimitMiddleware, so the limit holds across instances.
import type { RateLimitHit, RateLimitStore } from './rate-limit';

/**
 * The part of a Redis client the store uses. Bun's `RedisClient` (`new RedisClient(url)` from `bun`)
 * and `Bun.redis` have it; another client fits with a small adapter.
 */
export interface RedisCommandClient {
  send(command: string, args: string[]): Promise<unknown>;
}

export interface RedisRateLimitStoreOptions {
  /** Prepended to every rate-limit key. Default `kivin:rl:`. */
  prefix?: string;
}

// One script, so INCR and PEXPIRE are atomic: a failure between them cannot leave a counter that never
// expires. PTTL < 0 covers the first request of a window (and repairs a key that lost its expiry).
// Returns the count and the milliseconds left in the window.
const INCREMENT_SCRIPT = `local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  ttl = tonumber(ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ttl)
end
return {count, ttl}`;

/**
 * Fixed windows in Redis, shared by every instance. Each key is one counter that expires when its
 * window ends; the window end comes from Redis (`PTTL`), so clock differences between instances do not
 * move it.
 *
 * ```ts
 * import { RedisClient } from 'bun';
 * createRateLimitMiddleware({ limit: 100, windowMs: 60_000, store: new RedisRateLimitStore(new RedisClient(process.env.REDIS_URL)) });
 * ```
 */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly prefix: string;

  constructor(private readonly client: RedisCommandClient, options: RedisRateLimitStoreOptions = {}) {
    this.prefix = options.prefix ?? 'kivin:rl:';
  }

  async increment(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const reply = await this.client.send('EVAL', [INCREMENT_SCRIPT, '1', this.prefix + key, String(Math.max(Math.ceil(windowMs), 1))]);
    if (!Array.isArray(reply) || reply.length !== 2) {
      throw new TypeError(`RedisRateLimitStore: unexpected reply from EVAL: ${String(reply)}`);
    }
    return { count: Number(reply[0]), resetAt: now + Number(reply[1]) };
  }
}
