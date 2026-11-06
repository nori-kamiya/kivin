import { createApp, defineApplication, defineModule, getClientAddress, HttpError, type AppManifest, type RequestHook } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

// `defineApplication({ onRequest })`: hooks that run before routing, in app.fetch and in the native
// routes `listen()` builds.

let handled: string[] = [];

class Routes {
  health() {
    return { ok: true };
  }

  show({ params }: { params: { id: string } }) {
    handled.push(`show:${params.id}`);
    return { id: params.id };
  }

  remove({ params }: { params: { id: string } }) {
    handled.push(`remove:${params.id}`);
    return { removed: params.id };
  }

  address({ context }: { context: { request: Request } }) {
    return { address: getClientAddress(context.request) ?? null };
  }
}

type Route = AppManifest['routes'][number];
const route = (method: Route['method'], fullPath: string, methodName: string, fields?: Array<'params' | 'context'>): Route => ({
  method, fullPath, controller: Routes, methodName, parameters: fields ? [{ index: 0, source: 'input', fields }] : [],
  guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] },
});
const manifest: AppManifest = {
  routes: [
    { ...route('GET', '/health', 'health'), docs: { tags: [], security: [], responses: [], staticResponse: true } },
    route('GET', '/items/:id', 'show', ['params']),
    route('DELETE', '/items/:id', 'remove', ['params']),
    route('DELETE', '/address', 'address', ['context']),
  ],
};

const build = (onRequest: RequestHook | RequestHook[] | undefined) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  ...(onRequest ? { onRequest } : {}),
}), manifest);

const toDelete: RequestHook = (request) => (request.headers.get('x-method') === 'DELETE' ? new Request(request, { method: 'DELETE' }) : undefined);

afterEach(() => {
  handled = [];
});

describe('onRequest hooks (app.fetch)', () => {
  test('a Response answers before routing', async () => {
    const app = build((request) => (new URL(request.url).pathname === '/items/blocked' ? new Response('blocked', { status: 451 }) : undefined));
    const blocked = await app.fetch(new Request('http://localhost/items/blocked'));
    expect(blocked.status).toBe(451);
    expect(await blocked.text()).toBe('blocked');
    expect(handled).toEqual([]);
    expect(await (await app.fetch(new Request('http://localhost/items/1'))).json()).toEqual({ id: '1' });
  });

  test('a rewritten Request is routed instead (other method)', async () => {
    const app = build(toDelete);
    const response = await app.fetch(new Request('http://localhost/items/7', { method: 'GET', headers: { 'x-method': 'DELETE' } }));
    expect(await response.json()).toEqual({ removed: '7' });
    expect(handled).toEqual(['remove:7']);
  });

  test('hooks run in order, async ones included; later hooks see the rewritten request', async () => {
    const seen: string[] = [];
    const app = build([
      async (request) => {
        await Bun.sleep(1);
        seen.push(`first:${request.method}`);
        return toDelete(request);
      },
      (request) => {
        seen.push(`second:${request.method}`);
      },
    ]);
    await app.fetch(new Request('http://localhost/items/3', { headers: { 'x-method': 'DELETE' } }));
    expect(seen).toEqual(['first:GET', 'second:DELETE']);
    expect(handled).toEqual(['remove:3']);
  });

  test('errors become responses: HttpError keeps its status, a thrown Response is sent, others are 500', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await build(() => { throw new HttpError(418, 'teapot'); }).fetch(new Request('http://localhost/health'))).status).toBe(418);
      expect((await build(() => { throw new Response(null, { status: 429 }); }).fetch(new Request('http://localhost/health'))).status).toBe(429);
      const failed = await build(async () => { throw new Error('hook failed'); }).fetch(new Request('http://localhost/health'));
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ message: 'Internal Server Error' });
      expect(error.mock.calls.some((call) => String(call[1]).includes('hook failed'))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});

describe('onRequest hooks (listen / native routes)', () => {
  test('run once per request on native routes, precomputed responses, extra routes and the 404 fallback', async () => {
    const calls: string[] = [];
    const app = build([(request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
    }, toDelete]);
    const server = app.listen({ port: 0, hostname: '127.0.0.1', routes: { '/extra': Response.json({ extra: true }) } });
    try {
      expect(await (await fetch(new URL('/health', server.url))).json()).toEqual({ ok: true });
      expect(await (await fetch(new URL('/items/2', server.url))).json()).toEqual({ id: '2' });
      expect(await (await fetch(new URL('/extra', server.url))).json()).toEqual({ extra: true });
      expect((await fetch(new URL('/nope', server.url))).status).toBe(404);
      expect(await (await fetch(new URL('/items/9', server.url), { headers: { 'x-method': 'DELETE' } })).json()).toEqual({ removed: '9' });
      expect(calls).toEqual(['GET /health', 'GET /items/2', 'GET /extra', 'GET /nope', 'GET /items/9']);
      expect(handled).toEqual(['show:2', 'remove:9']);
    } finally {
      await app.close();
    }
  });

  test('a rewritten request keeps the client address', async () => {
    const app = build(toDelete);
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      const response = await fetch(new URL('/address', server.url), { headers: { 'x-method': 'DELETE' } });
      expect(await response.json()).toEqual({ address: '127.0.0.1' });
    } finally {
      await app.close();
    }
  });
});
