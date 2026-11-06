import { afterResponse, createApp, defineApplication, defineModule, type AppManifest, type ExceptionFilter, type NestLikeMiddleware, type RequestContext, type ResponseState } from '@kivin/core';
import { describe, expect, spyOn, test } from 'bun:test';

class Teapot extends Error {}

class TeapotFilter implements ExceptionFilter {
  catch(error: unknown) {
    return error instanceof Teapot ? new Response('short and stout', { status: 418 }) : undefined;
  }
}

const seen: Array<{ status: number; cors: string | null; body?: string }> = [];

class ObserveMiddleware implements NestLikeMiddleware {
  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    return this.handleRaw(context.request, {}, undefined as never, next);
  }

  handleRaw(request: Request, _params: Record<string, string>, _state: ResponseState, next: () => Response | PromiseLike<Response>) {
    afterResponse(request, (response) => {
      seen.push({ status: response.status, cors: response.headers.get('access-control-allow-origin') });
    });
    if (request.headers.has('x-replace')) {
      afterResponse(request, (response) => {
        const copy = new Response(response.body, response);
        copy.headers.set('x-replaced', '1');
        return copy;
      });
    }
    if (request.headers.has('x-throw')) {
      afterResponse(request, () => {
        throw new Error('callback failed');
      });
    }
    return next();
  }
}

class Routes {
  ok() {
    return { ok: true };
  }

  teapot() {
    throw new Teapot();
  }

  echo(body: unknown) {
    return body;
  }
}

type Route = AppManifest['routes'][number];
const route = (method: Route['method'], fullPath: string, methodName: string, extra: Partial<Route> = {}): Route => ({
  method, fullPath, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  globals: { middleware: [ObserveMiddleware], filters: [TeapotFilter] },
  cors: { origin: '*' },
  bodyLimit: 1024,
}), {
  routes: [
    route('GET', '/ok', 'ok'),
    route('GET', '/teapot', 'teapot'),
    route('POST', '/echo', 'echo', { parameters: [{ index: 0, source: 'body' }] }),
  ],
});

describe('afterResponse', () => {
  test('sees the final response: after exception filters and CORS', async () => {
    seen.length = 0;
    await app.fetch(new Request('http://localhost/ok', { headers: { origin: 'https://a.example' } }));
    await app.fetch(new Request('http://localhost/teapot', { headers: { origin: 'https://a.example' } }));
    expect(seen).toEqual([{ status: 200, cors: '*' }, { status: 418, cors: '*' }]);
  });

  test('a callback can replace the response; failing callbacks are logged and ignored', async () => {
    const response = await app.fetch(new Request('http://localhost/ok', { headers: { 'x-replace': '1' } }));
    expect(response.headers.get('x-replaced')).toBe('1');
    expect(await response.json()).toEqual({ ok: true });

    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const survived = await app.fetch(new Request('http://localhost/ok', { headers: { 'x-throw': '1' } }));
      expect(survived.status).toBe(200);
      expect(error.mock.calls.some((call) => String(call[1]).includes('callback failed'))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  test('runs once per request, also for chunked bodies the body limit re-wraps', async () => {
    seen.length = 0;
    const chunked = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}'));
        controller.close();
      },
    });
    const response = await app.fetch(new Request('http://localhost/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: chunked, duplex: 'half' } as RequestInit));
    expect(await response.json()).toEqual({ a: 1 });
    expect(seen).toEqual([{ status: 200, cors: null }]);
    await app.fetch(new Request('http://localhost/ok'));
    expect(seen).toHaveLength(2);
  });
});

describe('afterResponse with onRequest rewrites', () => {
  test('a request rewritten by a hook still runs its callbacks (app.fetch and listen)', async () => {
    seen.length = 0;
    const rewriting = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      globals: { middleware: [ObserveMiddleware] },
      onRequest: (request) => (new URL(request.url).pathname === '/alias' ? new Request(new URL('/ok', request.url), request) : undefined),
    }), { routes: [route('GET', '/ok', 'ok')] });
    await rewriting.fetch(new Request('http://localhost/alias'));
    expect(seen).toEqual([{ status: 200, cors: null }]);

    const server = rewriting.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      await fetch(new URL('/alias', server.url));
      await fetch(new URL('/ok', server.url));
      expect(seen).toHaveLength(3);
    } finally {
      await rewriting.close();
    }
  });
});

describe('afterResponse in a fresh process', () => {
  test('the first request of the process runs the callback its own middleware registered', () => {
    const fixture = new URL('./fixtures/after-response-first-request.ts', import.meta.url).pathname;
    const result = Bun.spawnSync(['bun', 'run', fixture], { cwd: import.meta.dir });
    expect(result.stderr.toString()).toBe('');
    expect(JSON.parse(result.stdout.toString())).toEqual([200]);
  });

  test('enableAfterResponse covers a first request whose middleware runs after an async guard', () => {
    const fixture = new URL('./fixtures/after-response-enabled-before-async-guard.ts', import.meta.url).pathname;
    const result = Bun.spawnSync(['bun', 'run', fixture], { cwd: import.meta.dir });
    expect(result.stderr.toString()).toBe('');
    expect(JSON.parse(result.stdout.toString())).toEqual([200]);
  });
});
