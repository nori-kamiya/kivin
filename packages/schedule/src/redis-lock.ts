// A `JobLock` on Redis (`SET key token NX PX ttl`), so a scheduled run happens on one instance only.
import type { JobLock } from './scheduler';

/**
 * The part of a Redis client the lock uses. Bun's `RedisClient` (`new RedisClient(url)` from `bun`)
 * and `Bun.redis` have it; another client fits with a small adapter.
 */
export interface RedisCommandClient {
  send(command: string, args: string[]): Promise<unknown>;
}

export interface RedisJobLockOptions {
  /**
   * Prepended to every lock key (`<prefix><job name>:<scheduled time in ms>`). Default `kivin:job:`.
   * Give each application its own prefix when several share one Redis.
   */
  prefix?: string;
}

/**
 * A lock for `SchedulerOptions.lock`: the first instance to `SET … NX` the key of a scheduled run gets
 * it. The value identifies this lock (process) for debugging; the key is never released early, it
 * expires after the TTL.
 *
 * ```ts
 * import { RedisClient } from 'bun';
 * super({ lock: createRedisJobLock(new RedisClient(process.env.REDIS_URL)) });
 * ```
 */
export function createRedisJobLock(client: RedisCommandClient, options: RedisJobLockOptions = {}): JobLock {
  const prefix = options.prefix ?? 'kivin:job:';
  const owner = crypto.randomUUID();
  return {
    async acquire(key: string, ttlMs: number) {
      const reply = await client.send('SET', [prefix + key, owner, 'NX', 'PX', String(Math.max(Math.ceil(ttlMs), 1))]);
      return reply === 'OK';
    },
  };
}
