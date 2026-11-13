// #65: a route that finishes synchronously must reach Bun as a Response or an already-resolved
// promise, never a pending one (a pending promise costs ~10% more server CPU per request).
import { afterResponse, createApp, defineApplication, defineModule, enableAfterResponse, type AppManifest, type NestLikeMiddleware, type RequestContext } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { afterAll, describe, expect, test } from 'bun:test';
import { finishAfterResponse } from '../src/after-response';
import { NOT_SETTLED, settledValue, thenNow } from '../src/runtime/utils';

class Routes {
  item() {
    return { ok: true };
  }
  async slow() {
    await Bun.sleep(1);
    return { ok: 'slow' };
  }
}

const routes: AppManifest['routes'] = [
  { method: 'GET', fullPath: '/item', controller: Routes, methodName: 'item', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
  { method: 'GET', fullPath: '/slow', controller: Routes, methodName: 'slow', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
];

type NativeHandler = (request: Request, server?: unknown) => Response | Promise<Response>;

/** Starts `app.listen` and captures the native `routes` table passed to `Bun.serve`. */
function captureRoutes(app: { listen: (options: number) => { stop: (force?: boolean) => Promise<void> } }) {
  const serve = Bun.serve;
  let captured: Record<string, Record<string, NativeHandler>> = {};
  Bun.serve = ((options: { routes: Record<string, Record<string, NativeHandler>> }) => {
    captured = options.routes;
    return serve(options as never);
  }) as typeof Bun.serve;
  try {
    const server = app.listen(0);
    servers.push(server);
  } finally {
    Bun.serve = serve;
  }
  return captured;
}

const servers: Array<{ stop: (force?: boolean) => Promise<void> }> = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
});

const isNotPending = (value: unknown) => !(value instanceof Promise) || Bun.peek.status(value) === 'fulfilled';

describe('settled results reach Bun without a pending promise (#65)', () => {
  test('thenNow / settledValue', async () => {
    const resolved = Promise.resolve(2);
    const doubled = thenNow(resolved, (value) => value * 2);
    expect(Bun.peek.status(doubled)).toBe('fulfilled');
    expect(await doubled).toBe(4);
    const pending = thenNow(Bun.sleep(1).then(() => 3), (value) => value * 2);
    expect(Bun.peek.status(pending)).toBe('pending');
    expect(await pending).toBe(6);
    const thrown = thenNow(resolved, () => {
      throw new Error('boom');
    });
    expect(thrown).rejects.toThrow('boom');
    expect(settledValue(resolved)).toBe(2);
    expect(settledValue(Bun.sleep(1))).toBe(NOT_SETTLED);
    expect(settledValue({ then: () => undefined })).toBe(NOT_SETTLED);
  });

  test('finishAfterResponse runs the callbacks at once on a settled result', async () => {
    const request = new Request('http://x/');
    const seen: number[] = [];
    afterResponse(request, (response) => {
      seen.push(response.status);
    });
    const finished = finishAfterResponse(request, Promise.resolve(new Response(null, { status: 201 })));
    expect(Bun.peek.status(finished)).toBe('fulfilled');
    expect(seen).toEqual([201]);
    expect((await finished).status).toBe(201);
  });

  test('CORS + afterResponse route: the native handler returns a settled result', async () => {
    enableAfterResponse();
    class Observe implements NestLikeMiddleware {
      handle(context: RequestContext, next: () => Promise<Response>) {
        afterResponse(context.request, () => undefined);
        return next();
      }
      handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | Promise<Response>) {
        afterResponse(request, () => undefined);
        return next();
      }
    }
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      cors: { origin: '*' },
      globals: { middleware: [Observe] },
    }), { routes });
    const native = captureRoutes(app);
    const result = native['/item']!.GET!(new Request('http://x/item', { headers: { origin: 'https://a.example' } }));
    expect(isNotPending(result)).toBe(true);
    const response = await result;
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({ ok: true });
    // A handler that really waits still works (pending is fine there).
    expect(await (await native['/slow']!.GET!(new Request('http://x/slow'))).json()).toEqual({ ok: 'slow' });
  });

  test('onRequest hooks (sync and already-resolved async) do not wrap the route in a pending promise', async () => {
    const seen: string[] = [];
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      onRequest: [
        (request) => {
          seen.push(`sync ${new URL(request.url).pathname}`);
        },
        async (request) => {
          seen.push(`async ${new URL(request.url).pathname}`);
        },
      ],
    }), { routes });
    const native = captureRoutes(app);
    const result = native['/item']!.GET!(new Request('http://x/item'));
    expect(isNotPending(result)).toBe(true);
    expect(await (await result).json()).toEqual({ ok: true });
    expect(seen).toEqual(['sync /item', 'async /item']);

    // app.fetch keeps returning a promise.
    const fetched = app.fetch(new Request('http://x/item'));
    expect(fetched).toBeInstanceOf(Promise);
    expect((await fetched).status).toBe(200);
  });

  test('a hook that really waits, rewrites or answers still works', async () => {
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      onRequest: [
        async (request) => {
          await Bun.sleep(1);
          return new URL(request.url).pathname === '/old' ? new Request('http://x/item', request) : undefined;
        },
        (request) => (request.headers.has('x-deny') ? Response.json({ message: 'denied' }, { status: 403 }) : undefined),
        async (request) => {
          if (request.headers.has('x-fail')) {
            throw new Error('hook failed');
          }
        },
      ],
    }), { routes });
    const native = captureRoutes(app);
    expect(await (await native['/item']!.GET!(new Request('http://x/item'))).json()).toEqual({ ok: true });
    expect(await (await app.fetch(new Request('http://x/old'))).json()).toEqual({ ok: true });
    expect((await native['/item']!.GET!(new Request('http://x/item', { headers: { 'x-deny': '1' } }))).status).toBe(403);
    const original = console.error;
    console.error = () => undefined;
    try {
      expect((await native['/item']!.GET!(new Request('http://x/item', { headers: { 'x-fail': '1' } }))).status).toBe(500);
    } finally {
      console.error = original;
    }
  });
});
