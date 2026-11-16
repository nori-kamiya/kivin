import { createApp, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivinjs/core';
import { createEtagMiddleware, createResponseCache, MemoryCacheStore, type CacheRecord } from '../src/index';
import { createValibotAdapter } from '@kivinjs/valibot';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

let calls = 0;
const PUBLIC = { 'cache-control': 'public, max-age=60' };

class Routes {
  open() {
    calls += 1;
    return new Response(`open ${calls}`, { headers: PUBLIC });
  }

  noHeader() {
    calls += 1;
    return { calls };
  }

  me({ context }: { context: RequestContext }) {
    calls += 1;
    const who = context.request.headers.get('authorization') ?? context.cookie('user') ?? 'anonymous';
    return new Response(`hello ${who}`, { headers: PUBLIC });
  }

  lang({ context }: { context: RequestContext }) {
    calls += 1;
    return new Response(`lang ${context.request.headers.get('accept-language') ?? '-'}`, { headers: { ...PUBLIC, vary: 'Accept-Language' } });
  }

  cookie() {
    calls += 1;
    return new Response('with cookie', { headers: { ...PUBLIC, 'set-cookie': 'sid=secret' } });
  }

  private() {
    calls += 1;
    return new Response('private', { headers: { 'cache-control': 'private, max-age=60' } });
  }

  star() {
    calls += 1;
    return new Response('star', { headers: { ...PUBLIC, vary: '*' } });
  }

  events() {
    calls += 1;
    return new Response('data: 1\n\n', { headers: { ...PUBLIC, 'content-type': 'text/event-stream' } });
  }

  missing() {
    calls += 1;
    return new Response('nope', { status: 404, headers: PUBLIC });
  }

  big() {
    calls += 1;
    return new Response('x'.repeat(2048), { headers: PUBLIC });
  }

  i18n({ context }: { context: RequestContext }) {
    calls += 1;
    return new Response(`i18n ${context.request.headers.get('accept-language') ?? '-'}`, { headers: PUBLIC });
  }

  tagged() {
    calls += 1;
    return new Response(`tagged ${calls}`, { headers: PUBLIC });
  }

  update() {
    calls += 1;
    return new Response(`updated ${calls}`, { headers: PUBLIC });
  }
}

const cache = createResponseCache({ statusHeader: 'x-cache' });
const Cached = cache.middleware();
const CachedFor30 = cache.middleware({ ttl: 30 });
const CachedSmall = cache.middleware({ maxSize: 1024 });
const CachedTagged = cache.middleware({ tags: ['products'] });
const CachedByLanguage = cache.middleware({ vary: ['Accept-Language'] });
const Etag = createEtagMiddleware();

type Route = AppManifest['routes'][number];
const route = (methodName: string, middleware: Route['middleware'], extra: Partial<Route> = {}): Route => ({
  method: 'GET', fullPath: `/${methodName}`, controller: Routes, methodName, parameters: [{ index: 0, source: 'input', fields: ['context'] }], guards: [], middleware, filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});
const app = createApp(defineApplication({
  modules: [defineModule({ providers: [Cached, CachedFor30, CachedSmall, CachedTagged, CachedByLanguage, Etag], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), {
  routes: [
    route('open', [Cached, Etag]), route('noHeader', [Cached]), route('me', [Cached]), route('lang', [Cached]), route('cookie', [Cached]),
    route('private', [Cached]), route('star', [Cached]), route('events', [Cached]), route('missing', [Cached]), route('big', [CachedSmall]),
    route('tagged', [CachedTagged]), route('i18n', [CachedByLanguage]),
    route('noHeader', [CachedFor30], { fullPath: '/forced' }),
    route('update', [Cached], { method: 'POST', fullPath: '/open' }),
  ],
});

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => app.fetch(new Request(`http://x${path}`, { method, headers }));
const twice = async (path: string, first: Record<string, string> = {}, second: Record<string, string> = first) => {
  const before = calls;
  const a = await get(path, first);
  const b = await get(path, second);
  return { a, b, textA: await a.text(), textB: await b.text(), handlerCalls: calls - before };
};

afterEach(() => {
  setSystemTime();
});

describe('createResponseCache: responses never reach another user', () => {
  test('given two users with different Authorization headers, when they request the same URL, then each gets their own response', async () => {
    const { textA, textB, handlerCalls } = await twice('/me', { authorization: 'Bearer alice' }, { authorization: 'Bearer bob' });

    expect(textA).toBe('hello Bearer alice');
    expect(textB).toBe('hello Bearer bob');
    expect(handlerCalls).toBe(2);
  });

  test('given an anonymous response is cached, when a user with credentials or a cookie asks, then they bypass it', async () => {
    await cache.invalidate('http://x/me');
    await get('/me');
    const withAuth = await get('/me', { authorization: 'Bearer carol' });
    const withCookie = await get('/me', { cookie: 'user=dave' });

    expect(await withAuth.text()).toBe('hello Bearer carol');
    expect(await withCookie.text()).toBe('hello dave');
    expect(withAuth.headers.get('x-cache')).toBeNull();
  });

  test('given a response that varies by Accept-Language, when two languages ask, then each language has its own entry', async () => {
    const ja = await twice('/lang', { 'accept-language': 'ja' });
    const en = await twice('/lang', { 'accept-language': 'en' });

    expect([ja.textA, ja.textB]).toEqual(['lang ja', 'lang ja']);
    expect([en.textA, en.textB]).toEqual(['lang en', 'lang en']);
    expect(ja.handlerCalls + en.handlerCalls).toBe(2);
  });

  test('given a route varied on a header outside the middleware, when vary names it, then each value has its own entry', async () => {
    const ja = await twice('/i18n', { 'accept-language': 'ja' });
    const en = await twice('/i18n', { 'accept-language': 'en' });

    expect([ja.textA, ja.textB, en.textA, en.textB]).toEqual(['i18n ja', 'i18n ja', 'i18n en', 'i18n en']);
    expect(ja.handlerCalls + en.handlerCalls).toBe(2);
  });

  test('given Set-Cookie, Cache-Control private or Vary *, when requested twice, then nothing is cached', async () => {
    for (const path of ['/cookie', '/private', '/star']) {
      expect((await twice(path)).handlerCalls).toBe(2);
    }
  });
});

describe('createResponseCache: what is cached and for how long', () => {
  test('given a public response, when requested again, then it is served from the cache with Age and the hit header', async () => {
    setSystemTime(new Date('2026-11-16T00:00:00Z'));
    const first = await get('/open');
    setSystemTime(new Date('2026-11-16T00:00:07Z'));
    const second = await get('/open');

    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(second.headers.get('age')).toBe('7');
    expect(await second.text()).toBe(await first.text());
  });

  test('given max-age has passed, when requested, then the handler runs again', async () => {
    setSystemTime(new Date('2026-11-16T01:00:00Z'));
    const first = await (await get('/open')).text();
    setSystemTime(new Date('2026-11-16T01:01:01Z'));
    const second = await (await get('/open')).text();

    expect(second).not.toBe(first);
  });

  test('given no Cache-Control, when no ttl is set, then it is not cached; with a route ttl it is', async () => {
    expect((await twice('/noHeader')).handlerCalls).toBe(2);
    expect((await twice('/forced')).handlerCalls).toBe(1);
  });

  test('given a HEAD request, when the GET response is cached, then HEAD is answered from it without a body', async () => {
    await get('/forced');
    const before = calls;
    const head = await get('/forced', {}, 'HEAD');

    expect(head.headers.get('x-cache')).toBe('HIT');
    expect(await head.text()).toBe('');
    expect(calls).toBe(before);
  });

  test('given non-GET methods, error statuses, streams and oversized bodies, when requested twice, then they are not cached', async () => {
    const before = calls;
    await get('/open', {}, 'POST');
    await get('/open', {}, 'POST');
    expect(calls - before).toBe(2);
    for (const path of ['/missing', '/events', '/big']) {
      expect((await twice(path)).handlerCalls).toBe(2);
    }
  });

  test('given the ETag middleware inside the cache, when If-None-Match matches a cached entry, then the cache answers 304', async () => {
    await cache.invalidate('http://x/open');
    const first = await get('/open');
    const etag = first.headers.get('etag')!;
    const before = calls;
    const revalidated = await get('/open', { 'if-none-match': etag });

    expect(etag).toMatch(/^W\//);
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('x-cache')).toBe('HIT');
    expect(calls).toBe(before);
  });
});

describe('createResponseCache: invalidation', () => {
  test('given a cached URL, when invalidated by key, then the next request runs the handler', async () => {
    await get('/open');
    await cache.invalidate(new Request('http://x/open'));
    const before = calls;
    await get('/open');

    expect(calls - before).toBe(1);
  });

  test('given a tagged response, when its tag is invalidated, then it is dropped', async () => {
    const { handlerCalls } = await twice('/tagged');
    await cache.invalidateTag('products');
    const before = calls;
    await get('/tagged');

    expect(handlerCalls).toBe(1);
    expect(calls - before).toBe(1);
  });
});

describe('MemoryCacheStore', () => {
  const record = (size: number): CacheRecord => ({ kind: 'response', status: 200, statusText: '', headers: [], body: new Uint8Array(size), storedAt: 0 });

  test('given more entries than maxEntries, when stored, then the least recently used goes first', () => {
    const store = new MemoryCacheStore({ maxEntries: 2 });
    store.set('a', record(1), 60_000, []);
    store.set('b', record(1), 60_000, []);
    store.get('a');
    store.set('c', record(1), 60_000, []);

    expect(store.get('a')).toBeDefined();
    expect(store.get('b')).toBeUndefined();
    expect(store.get('c')).toBeDefined();
  });

  test('given maxBytes, when bodies exceed it, then old entries are evicted and an oversized one is not stored', () => {
    const store = new MemoryCacheStore({ maxBytes: 10 });
    store.set('a', record(6), 60_000, ['t']);
    store.set('b', record(6), 60_000, []);
    store.set('huge', record(11), 60_000, []);

    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
    expect(store.get('huge')).toBeUndefined();
  });

  test('given tags, when a tag is deleted, then only its keys go', () => {
    const store = new MemoryCacheStore();
    store.set('a', record(1), 60_000, ['x']);
    store.set('b', record(1), 60_000, ['y']);
    store.deleteTag('x');

    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
  });
});
