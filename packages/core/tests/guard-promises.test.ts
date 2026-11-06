import { createApp, defineApplication, defineModule, unauthorized, type AppManifest, type CanActivate, type RequestContext } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

// Guards whose methods are plain functions (not `async`) but return promises, e.g. delegating to an
// async service. A promise is truthy: treating it as a boolean would let every request through.
const check = async (request: Request) => {
  await Bun.sleep(1);
  return request.headers.get('x-ok') === '1';
};

class PromiseRawGuard implements CanActivate {
  canActivateRaw(request: Request) {
    return check(request);
  }

  canActivate(context: RequestContext) {
    return check(context.request);
  }
}

class RejectingRawGuard implements CanActivate {
  canActivateRaw(request: Request) {
    return check(request).then((ok) => {
      if (!ok) {
        throw unauthorized('nope');
      }
      return true;
    });
  }

  canActivate() {
    return true;
  }
}

class PromiseContextGuard implements CanActivate {
  canActivate(context: RequestContext) {
    return check(context.request);
  }
}

class AlwaysRaw implements CanActivate {
  canActivateRaw() {
    return true;
  }

  canActivate() {
    return true;
  }
}

class Routes {
  open() {
    return { ok: true };
  }

  param({ params }: { params: Record<string, string> }) {
    return params;
  }
}

type Route = AppManifest['routes'][number];
const route = (fullPath: string, guards: unknown[], extra: Partial<Route> = {}): Route => ({
  method: 'GET', fullPath, controller: Routes, methodName: 'open', parameters: [], guards: guards as never, middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});
const routes = [
  route('/single', [PromiseRawGuard]),
  route('/rejecting', [RejectingRawGuard]),
  route('/context', [PromiseContextGuard]),
  route('/two', [AlwaysRaw, PromiseRawGuard]),
  route('/param/:id', [PromiseRawGuard], { methodName: 'param', parameters: [{ index: 0, source: 'input', fields: ['params'] }] }),
  route('/post', [PromiseRawGuard], { method: 'POST' }),
];
const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), { routes });

const cases: Array<[string, string, number]> = [
  ['/single', 'GET', 403],
  ['/rejecting', 'GET', 401],
  ['/context', 'GET', 403],
  ['/two', 'GET', 403],
  ['/param/7', 'GET', 403],
  ['/post', 'POST', 403],
];

describe('guards returning promises from non-async methods', () => {
  test.each(cases)('%s denies without the header (%s → %d)', async (path, method, status) => {
    expect((await app.fetch(new Request(`http://x${path}`, { method }))).status).toBe(status);
    expect((await app.fetch(new Request(`http://x${path}`, { method, headers: { 'x-ok': '1' } }))).status).toBe(200);
  });

  test('over Bun native routes too', async () => {
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      for (const [path, method, status] of cases) {
        expect((await fetch(`http://127.0.0.1:${server.port}${path}`, { method })).status).toBe(status);
        expect((await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { 'x-ok': '1' } })).status).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
