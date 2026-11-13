// Against a real Redis: runs when REDIS_URL is set (CI's Linux job starts one), skipped otherwise.
import { createRedisJobLock, createScheduler } from '@kivinjs/schedule';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';

const redisUrl = process.env.REDIS_URL;
const prefix = `kivin-test:job:${crypto.randomUUID()}:`;

const waitFor = async (condition: () => boolean, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting');
    }
    await Bun.sleep(20);
  }
};

describe.skipIf(!redisUrl)('createRedisJobLock on Redis', () => {
  // The describe body runs even when skipped; hooks do not, so the clients are only made with a URL.
  // Two connections stand in for two instances.
  let first: RedisClient;
  let second: RedisClient;
  beforeAll(() => {
    first = new RedisClient(redisUrl);
    second = new RedisClient(redisUrl);
  });

  afterAll(async () => {
    const keys = (await first.send('KEYS', [`${prefix}*`])) as string[];
    if (keys.length > 0) {
      await first.send('DEL', keys);
    }
    first.close();
    second.close();
  });

  test('one of two instances gets a key; it expires after the TTL', async () => {
    const a = createRedisJobLock(first, { prefix });
    const b = createRedisJobLock(second, { prefix });
    const results = await Promise.all([a.acquire('job:1', 200), b.acquire('job:1', 200)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await b.acquire('job:2', 200)).toBe(true);
    const ttl = Number(await first.send('PTTL', [`${prefix}job:1`]));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(200);
    await Bun.sleep(250);
    expect(await b.acquire('job:1', 200)).toBe(true);
  });

  test('two schedulers sharing the Redis lock run each scheduled time once', async () => {
    const runs: string[] = [];
    const instance = (name: string, client: RedisClient) => createScheduler({ timeZone: 'UTC', lock: createRedisJobLock(client, { prefix }), lockTtlMs: 10_000 })
      .cron('tick', '* * * * * *', () => {
        runs.push(name);
      });
    const a = instance('a', first);
    const b = instance('b', second);
    a.start();
    b.start();
    await waitFor(() => runs.length >= 3, 6000);
    await Promise.all([a.stop(), b.stop()]);
    // One key per scheduled time, still held (the lock is not released after the run).
    const keys = (await first.send('KEYS', [`${prefix}tick:*`])) as string[];
    expect(keys.every((key) => /:tick:\d+000$/.test(key))).toBe(true);
    expect(runs).toHaveLength(keys.length);
    const ttl = Number(await first.send('PTTL', [keys[0]!]));
    expect(ttl).toBeGreaterThan(5_000);
    expect(ttl).toBeLessThanOrEqual(10_000);
  }, 10_000);
});
