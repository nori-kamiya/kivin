import { createApp, defineApplication, defineModule, type AppManifest, type NestLikeMiddleware, type RequestContext } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

class Routes {
  item() {
    return { ok: true };
  }
}

const routes: AppManifest['routes'] = [
  { method: 'GET', fullPath: '/items', controller: Routes, methodName: 'item', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
  { method: 'GET', fullPath: '/items/:id', controller: Routes, methodName: 'item', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
];

const seen: Array<[string, string, number]> = [];

class Observer implements NestLikeMiddleware {
  handle(_context: RequestContext, next: () => Promise<Response>) {
    return next();
  }
  handleUnmatched(request: Request, response: Response) {
    seen.push([request.method, new URL(request.url).pathname, response.status]);
  }
}

class Replacer implements NestLikeMiddleware {
  handle(_context: RequestContext, next: () => Promise<Response>) {
    return next();
  }
  handleUnmatched(_request: Request, response: Response) {
    return response.status === 404 ? Response.json({ message: 'nothing here' }, { status: 404, headers: { 'x-replaced': '1' } }) : undefined;
  }
}

class Throws implements NestLikeMiddleware {
  handle(_context: RequestContext, next: () => Promise<Response>) {
    return next();
  }
  handleUnmatched(): void {
    throw new Error('observer failed');
  }
}

const appWith = (middleware: unknown[], extra: Partial<Parameters<typeof defineApplication>[0]> = {}) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: middleware as never },
  ...extra,
}), { routes });

describe('handleUnmatched on global middleware', () => {
  test('sees 404, 405 (static and parametric paths), automatic OPTIONS and onRequest answers, not routed requests', async () => {
    seen.length = 0;
    const app = appWith([Observer], { onRequest: (request) => (request.headers.has('x-block') ? new Response(null, { status: 403 }) : undefined) });
    await app.fetch(new Request('http://x/items'));
    await app.fetch(new Request('http://x/items/1'));
    await app.fetch(new Request('http://x/nope'));
    await app.fetch(new Request('http://x/items', { method: 'POST' }));
    await app.fetch(new Request('http://x/items/1', { method: 'DELETE' }));
    await app.fetch(new Request('http://x/items', { method: 'OPTIONS' }));
    await app.fetch(new Request('http://x/items', { headers: { 'x-block': '1' } }));
    expect(seen).toEqual([
      ['GET', '/nope', 404],
      ['POST', '/items', 405],
      ['DELETE', '/items/1', 405],
      ['OPTIONS', '/items', 204],
      ['GET', '/items', 403],
    ]);
  });

  test('a thrown onRequest error is observed as the response it becomes', async () => {
    seen.length = 0;
    const original = console.error;
    console.error = () => undefined;
    try {
      const app = appWith([Observer], { onRequest: () => { throw new Error('hook failed'); } });
      expect((await app.fetch(new Request('http://x/items'))).status).toBe(500);
    } finally {
      console.error = original;
    }
    expect(seen).toEqual([['GET', '/items', 500]]);
  });

  test('can replace the response; errors are logged and ignored; CORS headers are already applied', async () => {
    seen.length = 0;
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const app = appWith([Throws, Replacer, Observer], { cors: { origin: 'https://app.example' } });
      const response = await app.fetch(new Request('http://x/nope', { headers: { origin: 'https://app.example' } }));
      expect(response.status).toBe(404);
      expect(response.headers.get('x-replaced')).toBe('1');
      expect(await response.json()).toEqual({ message: 'nothing here' });
      expect(errors).toHaveLength(1);
      // The observer after the replacer sees the replacement.
      expect(seen).toEqual([['GET', '/nope', 404]]);

      const preflight = await app.fetch(new Request('http://x/items', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' } }));
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example');
      expect(seen.at(-1)).toEqual(['OPTIONS', '/items', 204]);
    } finally {
      console.error = original;
    }
  });

  test('request-scoped middleware is skipped (it cannot be created outside a request)', async () => {
    seen.length = 0;
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [{ provide: Observer, useClass: Observer, scope: 'request' }], controllers: [Routes], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      globals: { middleware: [Observer] },
    }), { routes });
    expect((await app.fetch(new Request('http://x/nope'))).status).toBe(404);
    expect(seen).toEqual([]);
  });
});
