import { createApp, defineApplication, defineModule, type AppManifest } from '@kivinjs/core';
import { createRateLimitMiddleware, RedisRateLimitStore, type RedisCommandClient } from '../src/index';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

/** Runs the store's script the way Redis would (INCR, then PEXPIRE when the key has no TTL), in memory. */
class FakeRedis implements RedisCommandClient {
  readonly commands: string[][] = [];
  clock = 0;
  private readonly counters = new Map<string, { count: number; expiresAt: number | undefined }>();

  async send(command: string, args: string[]) {
    this.commands.push([command, ...args]);
    expect(command).toBe('EVAL');
    const [script = '', keyCount, key = '', windowMs] = args;
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(keyCount).toBe('1');
    let counter = this.counters.get(key);
    if (!counter || (counter.expiresAt !== undefined && counter.expiresAt <= this.clock)) {
      counter = { count: 0, expiresAt: undefined };
      this.counters.set(key, counter);
    }
    counter.count += 1;
    if (counter.expiresAt === undefined) {
      counter.expiresAt = this.clock + Number(windowMs);
    }
    return [counter.count, counter.expiresAt - this.clock];
  }
}

class Routes {
  fast() {
    return { ok: true };
  }
}

type Route = AppManifest['routes'][number];
const routes: Route[] = [{
  method: 'GET', fullPath: '/fast', controller: Routes, methodName: 'fast', parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] },
}];
const makeApp = (middleware: unknown) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: [middleware as never] },
}), { routes });

describe('RedisRateLimitStore', () => {
  test('one EVAL per request under the prefix; the window end comes from the TTL Redis reports', async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);
    expect(await store.increment('1.2.3.4', 60_000, 5_000_000)).toEqual({ count: 1, resetAt: 5_060_000 });
    expect(redis.commands[0]!.slice(3)).toEqual(['kivin:rl:1.2.3.4', '60000']);
    redis.clock = 20_000;
    // This instance's clock is 3 s behind; the window still ends 40 s after Redis's "now".
    expect(await store.increment('1.2.3.4', 60_000, 5_017_000)).toEqual({ count: 2, resetAt: 5_057_000 });
    redis.clock = 60_000;
    expect(await store.increment('1.2.3.4', 60_000, 5_060_000)).toEqual({ count: 1, resetAt: 5_120_000 });

    const prefixed = new RedisRateLimitStore(redis, { prefix: 'app:rl:' });
    await prefixed.increment('k', 1500.5, 0);
    expect(redis.commands.at(-1)!.slice(3)).toEqual(['app:rl:k', '1501']);
  });

  test('an unexpected reply is an error, not a silent pass', async () => {
    const store = new RedisRateLimitStore({ send: async () => 'OK' });
    await expect(store.increment('k', 1000, 0)).rejects.toThrow(/unexpected reply/);
  });

  test('two app instances share one limit; headers use the Redis TTL', async () => {
    const redis = new FakeRedis();
    const options = { limit: 3, windowMs: 60_000, key: () => 'client-1', now: () => 1_000_000, store: new RedisRateLimitStore(redis) };
    const first = makeApp(createRateLimitMiddleware(options));
    const second = makeApp(createRateLimitMiddleware(options));
    const responses: Response[] = [];
    for (const app of [first, second, first, second]) {
      redis.clock += 10_000;
      responses.push(await app.fetch(new Request('http://x/fast')));
    }
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 429]);
    expect(responses.map((response) => response.headers.get('ratelimit-reset'))).toEqual(['60', '50', '40', '30']);
    expect(responses[3]!.headers.get('retry-after')).toBe('30');
  });
});
