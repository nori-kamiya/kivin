import { createApp, createCompressMiddleware, createEtagMiddleware, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';
import { brotliDecompressSync } from 'node:zlib';

const users = Array.from({ length: 50 }, (_, index) => ({ id: String(index), name: `User ${index}`, email: `user${index}@example.com` }));

class Routes {
  list() {
    return users;
  }

  small() {
    return { ok: true };
  }

  png() {
    return new Blob([new Uint8Array(4096)], { type: 'image/png' });
  }

  events() {
    return new Response('data: 1\n\n'.repeat(500), { headers: { 'content-type': 'text/event-stream' } });
  }

  ndjson() {
    return new Response(users.map((user) => JSON.stringify(user)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
  }

  noTransform({ context }: { context: RequestContext }) {
    context.setResponseHeader('cache-control', 'no-transform');
    return users;
  }

  created() {
    return users;
  }
}

type Route = AppManifest['routes'][number];
const route = (methodName: string, extra: Partial<Route> = {}): Route => ({
  method: 'GET', fullPath: `/${methodName}`, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});
const routes = [
  route('list'), route('small'), route('png'), route('events'), route('ndjson'),
  route('noTransform', { parameters: [{ index: 0, source: 'input', fields: ['context'] }] }),
  route('created', { method: 'POST', docs: { tags: [], security: [], responses: [{ status: 201, description: 'created' }] } }),
];
const makeApp = (middleware: unknown[]) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: middleware as never },
}), { routes });

describe('createCompressMiddleware', () => {
  const app = makeApp([createCompressMiddleware()]);
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => app.fetch(new Request(`http://x${path}`, { method, headers }));
  const json = JSON.stringify(users);

  test('brotli is preferred and decodes to the original body', async () => {
    const response = await get('/list', { 'accept-encoding': 'gzip, deflate, br' });
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(response.headers.get('content-type')).toBe('application/json;charset=utf-8');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(json.length / 4);
    expect(new TextDecoder().decode(brotliDecompressSync(bytes))).toBe(json);
  });

  test('gzip when brotli is not accepted (q=0 or absent)', async () => {
    for (const accept of ['gzip', 'br;q=0, gzip;q=0.8']) {
      const response = await get('/list', { 'accept-encoding': accept });
      expect(response.headers.get('content-encoding')).toBe('gzip');
      expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())))).toBe(json);
    }
  });

  test('status, queued headers and method are preserved', async () => {
    const response = await app.fetch(new Request('http://x/created', { method: 'POST', headers: { 'accept-encoding': 'br' } }));
    expect(response.status).toBe(201);
    expect(response.headers.get('content-encoding')).toBe('br');
  });

  test.each([
    ['no Accept-Encoding', '/list', {}],
    ['identity only', '/list', { 'accept-encoding': 'identity' }],
    ['below the threshold', '/small', { 'accept-encoding': 'br' }],
    ['not compressible', '/png', { 'accept-encoding': 'br' }],
    ['server-sent events', '/events', { 'accept-encoding': 'br' }],
    ['no-transform', '/noTransform', { 'accept-encoding': 'br' }],
  ])('passes through: %s', async (_name, path, headers) => {
    const response = await get(path, headers as Record<string, string>);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  test('compressible responses vary on Accept-Encoding even when sent as-is', async () => {
    expect((await get('/list')).headers.get('vary')).toBe('Accept-Encoding');
    expect((await get('/png')).headers.get('vary')).toBeNull();
  });

  test('NDJSON is compressed as a stream', async () => {
    const response = await get('/ndjson', { 'accept-encoding': 'gzip' });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await response.arrayBuffer())));
    expect(text.split('\n')).toHaveLength(50);
  });

  test('HEAD is not compressed', async () => {
    const response = await get('/list', { 'accept-encoding': 'br' }, 'HEAD');
    expect(response.headers.get('content-encoding')).toBeNull();
  });
});

describe('createEtagMiddleware', () => {
  const app = makeApp([createCompressMiddleware(), createEtagMiddleware()]);
  const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://x${path}`, { headers }));

  test('adds a stable weak ETag and answers 304 when it matches', async () => {
    const first = await get('/list');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+"$/);
    expect((await get('/list')).headers.get('etag')).toBe(etag);
    const notModified = await get('/list', { 'if-none-match': etag });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');
    expect(notModified.headers.get('etag')).toBe(etag);
    expect((await get('/list', { 'if-none-match': '"stale"' })).status).toBe(200);
  });

  test('the same ETag is used for compressed and identity responses (computed before compression)', async () => {
    const identity = await get('/list');
    const compressed = await get('/list', { 'accept-encoding': 'br' });
    expect(compressed.headers.get('content-encoding')).toBe('br');
    expect(compressed.headers.get('etag')).toBe(identity.headers.get('etag'));
    expect((await get('/list', { 'accept-encoding': 'br', 'if-none-match': identity.headers.get('etag')! })).status).toBe(304);
  });

  test('streams and non-GET requests get no ETag', async () => {
    expect((await get('/events')).headers.get('etag')).toBeNull();
    expect((await app.fetch(new Request('http://x/created', { method: 'POST' }))).headers.get('etag')).toBeNull();
  });
});
