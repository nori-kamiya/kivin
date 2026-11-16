import { createApp, defineApplication, defineModule, originalRequest, type AppManifest, type RequestHook } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { afterAll, describe, expect, test } from 'bun:test';

// A request an `onRequest` hook rewrote is routed again by kivin; it must still reach the native
// routes passed to `listen({ routes })`, as Bun would have routed it (exact > param > wildcard).

class Routes {
  item({ params }: { params: { id: string } }) {
    return { from: 'app', id: params.id };
  }

  exactApp() {
    return { from: 'app-exact' };
  }
}

const manifest: AppManifest = {
  routes: [
    { method: 'GET', fullPath: '/api/items/:id', controller: Routes, methodName: 'item', parameters: [{ index: 0, source: 'input', fields: ['params'] }], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
    { method: 'GET', fullPath: '/api/special', controller: Routes, methodName: 'exactApp', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
  ],
};

// Strips a `/v1` prefix and marks the request, so every case below is a rewritten request.
const stripVersion: RequestHook = (request) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/v1/')) {
    return undefined;
  }
  url.pathname = url.pathname.slice(3);
  return new Request(url, request);
};

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  onRequest: [stripVersion],
}), manifest);

let sawServer = false;
let sawOriginal = false;
const server = app.listen({
  port: 0,
  hostname: '127.0.0.1',
  routes: {
    '/graphql': { GET: () => new Response('graphql-get'), POST: async (request: Request) => new Response(`graphql-post:${await request.text()}`) },
    '/trpc/*': (request: Request, bunServer: unknown) => {
      sawServer = typeof (bunServer as { timeout?: unknown } | undefined)?.timeout === 'function';
      sawOriginal = originalRequest(request) !== request;
      return new Response(`trpc:${new URL(request.url).pathname}`);
    },
    '/files/:name': (request: Request & { params?: Record<string, string> }) => new Response(`file:${request.params?.name}`),
    '/api/*': () => new Response('api-wildcard'),
    '/static.txt': new Response('static'),
  },
});

afterAll(() => {
  server.stop(true);
});

const call = async (path: string, init?: RequestInit) => {
  const response = await fetch(new URL(path, server.url), init);
  return { status: response.status, text: await response.text() };
};

describe('rewritten requests and native routes', () => {
  test('given a hook rewrote the path, when it targets an exact native route, then that route answers per method', async () => {
    expect(await call('/v1/graphql')).toEqual({ status: 200, text: 'graphql-get' });
    expect(await call('/v1/graphql', { method: 'POST', body: 'q' })).toEqual({ status: 200, text: 'graphql-post:q' });
  });

  test('given a rewritten request, when it targets a wildcard native route, then the handler gets the Bun server and the rewritten request', async () => {
    expect(await call('/v1/trpc/user.get?input=1')).toEqual({ status: 200, text: 'trpc:/trpc/user.get' });
    expect(sawServer).toBe(true);
    expect(sawOriginal).toBe(true);
  });

  test('given a rewritten request, when it targets a param native route, then request.params is filled', async () => {
    expect(await call('/v1/files/a%20b')).toEqual({ status: 200, text: 'file:a b' });
  });

  test('given a static Response native route, when a rewritten request targets it, then it is served', async () => {
    expect(await call('/v1/static.txt')).toEqual({ status: 200, text: 'static' });
  });

  test('given app routes and a native wildcard over the same prefix, when rewritten, then the more specific app route still wins', async () => {
    expect(await call('/v1/api/special')).toEqual({ status: 200, text: '{"from":"app-exact"}' });
    expect(await call('/v1/api/items/7')).toEqual({ status: 200, text: '{"from":"app","id":"7"}' });
    expect(await call('/v1/api/other/thing')).toEqual({ status: 200, text: 'api-wildcard' });
  });

  test('given a rewritten request that matches nothing, when routed, then it is a 404', async () => {
    expect((await call('/v1/nowhere')).status).toBe(404);
  });

  test('given no rewrite, when native routes are called directly, then they answer as before', async () => {
    expect(await call('/graphql')).toEqual({ status: 200, text: 'graphql-get' });
    expect(await call('/trpc/x')).toEqual({ status: 200, text: 'trpc:/trpc/x' });
  });
});
