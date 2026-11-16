// Against a real Redis: runs when REDIS_URL is set (CI's Linux job starts one), skipped otherwise.
import { createResponseCache, RedisCacheStore, type CacheRecord } from '../src/index';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';

const redisUrl = process.env.REDIS_URL;
const prefix = `kivin-test:cache:${crypto.randomUUID()}:`;

describe.skipIf(!redisUrl)('RedisCacheStore on Redis', () => {
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

  const response = (bytes: number[]): CacheRecord => ({ kind: 'response', status: 200, statusText: 'OK', headers: [['content-type', 'application/octet-stream'], ['etag', 'W/"1"']], body: new Uint8Array(bytes), storedAt: 1234 });

  test('given a response with binary body, when stored and read, then it round-trips with an expiry', async () => {
    const store = new RedisCacheStore(client, { prefix });
    await store.set('http://x/a', response([0, 255, 10, 13]), 60_000, []);

    expect(await store.get('http://x/a')).toEqual(response([0, 255, 10, 13]));
    expect(await store.get('http://x/missing')).toBeUndefined();
    const ttl = (await client.send('PTTL', [`${prefix}entry:http://x/a`])) as number;
    expect(ttl).toBeGreaterThan(59_000);
  });

  test('given tagged entries, when a tag is deleted, then only its entries go and the tag set lives as long as its longest entry', async () => {
    const store = new RedisCacheStore(client, { prefix });
    await store.set('one', response([1]), 1_000, ['t']);
    await store.set('two', response([2]), 120_000, ['t']);
    await store.set('three', response([3]), 60_000, ['u']);

    expect((await client.send('PTTL', [`${prefix}tag:t`])) as number).toBeGreaterThan(119_000);
    await store.deleteTag('t');
    expect(await store.get('one')).toBeUndefined();
    expect(await store.get('two')).toBeUndefined();
    expect(await store.get('three')).toBeDefined();
  });

  test('given the cache middleware on Redis, when the same URL is asked twice, then the second answer comes from Redis', async () => {
    const cache = createResponseCache({ store: new RedisCacheStore(client, { prefix }), statusHeader: 'x-cache' });
    const Middleware = cache.middleware({ ttl: 60, tags: ['r'] });
    const middleware = new Middleware();
    let calls = 0;
    const next = () => {
      calls += 1;
      return new Response(`body ${calls}`, { headers: { vary: 'Accept-Language' } });
    };
    const request = () => new Request('http://x/redis', { headers: { 'accept-language': 'ja' } });

    const first = await middleware.handleRaw(request(), {}, undefined, next);
    const second = await middleware.handleRaw(request(), {}, undefined, next);
    await cache.invalidateTag('r');
    const third = await middleware.handleRaw(request(), {}, undefined, next);

    expect([await first.text(), await second.text(), await third.text()]).toEqual(['body 1', 'body 1', 'body 2']);
    expect(second.headers.get('x-cache')).toBe('HIT');
  });
});
