import { createApp, defineApplication, defineModule, getClientAddress, type AppManifest, type RequestContext } from '@kivin/core';
import { createRateLimitMiddleware, MemoryRateLimitStore, type RateLimitStore } from '../src/index';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';

class Routes {
  fast() {
    return { ok: true };
  }

  async slow() {
    await Bun.sleep(200);
    return { ok: 'late' };
  }

  whoami({ context }: { context: RequestContext }) {
    return { address: getClientAddress(context.request) ?? null };
  }
}

type Route = AppManifest['routes'][number];
const route = (methodName: string, extra: Partial<Route> = {}): Route => ({
  method: 'GET', fullPath: `/${methodName}`, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});
const routes = [route('fast'), route('slow'), route('whoami', { parameters: [{ index: 0, source: 'input', fields: ['context'] }] })];
const makeApp = (middleware: unknown[]) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: middleware as never },
}), { routes });

describe('createRateLimitMiddleware', () => {
  test('allows `limit` requests per window, then 429 with Retry-After; resets after the window', async () => {
    let clock = 1_000_000;
    const app = makeApp([createRateLimitMiddleware({ limit: 2, windowMs: 10_000, key: (request) => request.headers.get('x-client') ?? undefined, now: () => clock })]);
    const call = (client: string) => app.fetch(new Request('http://x/fast', { headers: { 'x-client': client } }));

    const first = await call('a');
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe('2');
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    expect(first.headers.get('ratelimit-reset')).toBe('10');
    expect((await call('a')).headers.get('ratelimit-remaining')).toBe('0');

    clock += 4_000;
    const limited = await call('a');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('6');
    expect(await limited.json()).toEqual({ message: 'Too Many Requests' });

    // Other clients have their own budget.
    expect((await call('b')).status).toBe(200);

    clock += 6_000;
    expect((await call('a')).status).toBe(200);
  });

  test('a key of undefined exempts the request', async () => {
    const app = makeApp([createRateLimitMiddleware({ limit: 1, windowMs: 60_000, key: () => undefined })]);
    for (let index = 0; index < 3; index += 1) {
      const response = await app.fetch(new Request('http://x/fast'));
      expect(response.status).toBe(200);
      expect(response.headers.get('ratelimit-limit')).toBeNull();
    }
  });

  test('by default limits by client address over HTTP', async () => {
    const app = makeApp([createRateLimitMiddleware({ limit: 1, windowMs: 60_000 })]);
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      const who = await (await fetch(`http://127.0.0.1:${server.port}/whoami`)).json() as { address: string };
      expect(who.address).toBe('127.0.0.1');
      expect((await fetch(`http://127.0.0.1:${server.port}/fast`)).status).toBe(429);
    } finally {
      await app.close();
    }
  });

  test('getClientAddress is undefined for in-process requests', async () => {
    const app = makeApp([]);
    expect(await (await app.fetch(new Request('http://x/whoami'))).json()).toEqual({ address: null });
  });

  test('invalid options are rejected', () => {
    expect(() => createRateLimitMiddleware({ limit: 0, windowMs: 1000 })).toThrow('positive');
  });

  test('a shared (async) store: two app instances share one limit', async () => {
    // Stands in for Redis: async, shared between "instances".
    const memory = new MemoryRateLimitStore();
    const calls: string[] = [];
    const shared: RateLimitStore = {
      async increment(key, windowMs, now) {
        calls.push(key);
        await Bun.sleep(1);
        return memory.increment(key, windowMs, now);
      },
    };
    const options = { limit: 3, windowMs: 60_000, key: () => 'client-1', store: shared };
    const first = makeApp([createRateLimitMiddleware(options)]);
    const second = makeApp([createRateLimitMiddleware(options)]);
    const statuses: number[] = [];
    for (const app of [first, second, first, second]) {
      statuses.push((await app.fetch(new Request('http://x/fast'))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(calls).toEqual(['client-1', 'client-1', 'client-1', 'client-1']);
  });

  test('MemoryRateLimitStore opens a new window after the old one ends', () => {
    const store = new MemoryRateLimitStore();
    expect(store.increment('a', 1000, 0)).toEqual({ count: 1, resetAt: 1000 });
    expect(store.increment('a', 1000, 500)).toEqual({ count: 2, resetAt: 1000 });
    expect(store.increment('a', 1000, 1000)).toEqual({ count: 1, resetAt: 2000 });
    expect(store.increment('b', 1000, 1000)).toEqual({ count: 1, resetAt: 2000 });
  });
});
