// Against a real Redis: runs when REDIS_URL is set (CI's Linux job starts one), skipped otherwise.
import { RedisRateLimitStore } from '../src/index';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';

const redisUrl = process.env.REDIS_URL;
const prefix = `kivin-test:rl:${crypto.randomUUID()}:`;

describe.skipIf(!redisUrl)('RedisRateLimitStore on Redis', () => {
  // The describe body runs even when skipped; hooks do not, so the client is only made with a URL.
  let client: RedisClient;
  beforeAll(() => {
    client = new RedisClient(redisUrl);
  });

  afterAll(async () => {
    const keys = (await client.send('KEYS', [`${prefix}*`])) as string[];
    if (keys.length > 0) {
      await client.send('DEL', keys);
    }
    client.close();
  });

  test('counts within a window that Redis expires; resetAt follows the key TTL', async () => {
    const store = new RedisRateLimitStore(client, { prefix });
    const now = Date.now();
    const first = await store.increment('a', 60_000, now);
    expect(first.count).toBe(1);
    expect(first.resetAt).toBeGreaterThan(now + 59_000);
    expect(first.resetAt).toBeLessThanOrEqual(now + 60_000);
    const second = await store.increment('a', 60_000, now);
    expect(second.count).toBe(2);
    expect(second.resetAt).toBeLessThanOrEqual(first.resetAt);
    expect(Number(await client.send('PTTL', [`${prefix}a`]))).toBeGreaterThan(59_000);
    expect((await store.increment('b', 60_000, now)).count).toBe(1);
  });

  test('a new window starts after the old one expires', async () => {
    const store = new RedisRateLimitStore(client, { prefix });
    expect((await store.increment('short', 100, Date.now())).count).toBe(1);
    expect((await store.increment('short', 100, Date.now())).count).toBe(2);
    await Bun.sleep(150);
    expect((await store.increment('short', 100, Date.now())).count).toBe(1);
  });

  test('concurrent increments from two clients are atomic and every counter gets an expiry', async () => {
    const other = new RedisClient(redisUrl);
    try {
      const stores = [new RedisRateLimitStore(client, { prefix }), new RedisRateLimitStore(other, { prefix })];
      const hits = await Promise.all(Array.from({ length: 50 }, (_, index) => stores[index % 2]!.increment('burst', 60_000, Date.now())));
      expect(hits.map((hit) => hit.count).sort((left, right) => left - right)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
      expect(Number(await client.send('PTTL', [`${prefix}burst`]))).toBeGreaterThan(0);
    } finally {
      other.close();
    }
  });

  test('a counter that lost its expiry gets one again on the next request', async () => {
    const store = new RedisRateLimitStore(client, { prefix });
    await client.send('SET', [`${prefix}stuck`, '7']);
    expect(Number(await client.send('PTTL', [`${prefix}stuck`]))).toBe(-1);
    const hit = await store.increment('stuck', 30_000, 0);
    expect(hit).toEqual({ count: 8, resetAt: 30_000 });
    expect(Number(await client.send('PTTL', [`${prefix}stuck`]))).toBeGreaterThan(29_000);
  });
});
