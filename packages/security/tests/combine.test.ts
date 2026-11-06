import { createApp, defineApplication, defineModule, setInjectableMetadata, type AppManifest, type CanActivate, type RequestContext } from '@kivinjs/core';
import { anyGuard, createBasicAuthGuard, createBearerAuthGuard } from '@kivinjs/security';
import { describe, expect, test } from 'bun:test';

class Routes {
  secret() {
    return { ok: true };
  }
}

const manifestWith = (guard: unknown): AppManifest => ({
  routes: [{ method: 'GET', fullPath: '/secret', controller: Routes, methodName: 'secret', parameters: [], guards: [guard] as never, middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } }],
});
const appWith = (guard: unknown) => createApp(defineApplication({ modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })] }), manifestWith(guard));
const get = (app: ReturnType<typeof appWith>, authorization?: string) => app.fetch(new Request('http://localhost/secret', authorization ? { headers: { authorization } } : {}));

describe('anyGuard', () => {
  const Either = anyGuard(createBearerAuthGuard({ tokens: ['tok'] }), createBasicAuthGuard({ users: { ada: 'pw' } }));

  test('passes when any guard passes (raw fast path kept)', async () => {
    const app = appWith(Either);
    expect((await get(app, 'Bearer tok')).status).toBe(200);
    expect((await get(app, `Basic ${btoa('ada:pw')}`)).status).toBe(200);
    expect(typeof (Either.prototype as CanActivate).canActivateRaw).toBe('function');
  });

  test('when all refuse, the first HttpError survives (401 + WWW-Authenticate)', async () => {
    const app = appWith(Either);
    const denied = await get(app, 'Bearer wrong');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('Bearer');
    expect((await get(app)).status).toBe(401);
  });

  test('plain false everywhere is 403; context-only guards use the context path', async () => {
    class No implements CanActivate {
      canActivate() {
        return false;
      }
    }
    class HeaderOk implements CanActivate {
      canActivate(context: RequestContext) {
        return context.request.headers.get('x-ok') === '1';
      }
    }
    const Combined = anyGuard(No, HeaderOk);
    expect((Combined.prototype as CanActivate).canActivateRaw).toBeUndefined();
    const app = appWith(Combined);
    expect((await get(app)).status).toBe(403);
    expect((await app.fetch(new Request('http://localhost/secret', { headers: { 'x-ok': '1' } }))).status).toBe(200);
  });

  test('rejects fewer than two guards and guards with dependencies', () => {
    class Dep {}
    class NeedsDep implements CanActivate {
      constructor(readonly dep: Dep) {}
      canActivate() {
        return true;
      }
    }
    setInjectableMetadata(NeedsDep, { deps: [Dep] });
    expect(() => anyGuard(createBearerAuthGuard({ tokens: ['x'] }))).toThrow(TypeError);
    expect(() => anyGuard(createBearerAuthGuard({ tokens: ['x'] }), NeedsDep as never)).toThrow(/dependencies/);
  });
});
