import { createApp, defineApplication, defineModule, setInjectableMetadata, unauthorized, type AppManifest, type CanActivate, type ProviderDefinition, type RequestContext } from '@kivinjs/core';
import { anyGuard, createBasicAuthGuard, createBearerAuthGuard, everyGuard, exceptGuard } from '@kivinjs/security';
import { describe, expect, test } from 'bun:test';

class Routes {
  secret() {
    return { ok: true };
  }
}

const routeAt = (fullPath: string, guards: unknown[]) => ({ method: 'GET' as const, fullPath, controller: Routes, methodName: 'secret', parameters: [], guards: guards as never, middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } });
const manifestWith = (guard: unknown): AppManifest => ({ routes: [routeAt('/secret', [guard])] });
const appWith = (guard: unknown, providers: ProviderDefinition[] = []) => createApp(defineApplication({ modules: [defineModule({ providers, controllers: [Routes], imports: [] })] }), manifestWith(guard));
const get = (app: { fetch: (request: Request) => Promise<Response> }, authorization?: string, path = '/secret') => app.fetch(new Request(`http://localhost${path}`, authorization ? { headers: { authorization } } : {}));

/** A service a guard receives through DI. */
class TokenService {
  readonly checked: string[] = [];
  valid(token: string | undefined) {
    this.checked.push(token ?? '');
    return token === 'Bearer db-token';
  }
}

class DbTokenGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}
  canActivateRaw(request: Request) {
    return this.tokens.valid(request.headers.get('authorization') ?? undefined);
  }
  canActivate(context: RequestContext) {
    return this.tokens.valid(context.request.headers.get('authorization') ?? undefined);
  }
}
setInjectableMetadata(DbTokenGuard, { deps: [TokenService] });

class AsyncDbTokenGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}
  async canActivate(context: RequestContext) {
    await Bun.sleep(0);
    if (!this.tokens.valid(context.request.headers.get('authorization') ?? undefined)) {
      throw unauthorized('token required');
    }
    return true;
  }
}
setInjectableMetadata(AsyncDbTokenGuard, { deps: [TokenService] });

describe('anyGuard', () => {
  const Either = anyGuard(createBearerAuthGuard({ tokens: ['tok'] }), createBasicAuthGuard({ users: { ada: 'pw' } }));

  test('passes when any guard passes (raw fast path kept)', async () => {
    const app = appWith(Either);
    expect((await get(app, 'Bearer tok')).status).toBe(200);
    expect((await get(app, `Basic ${btoa('ada:pw')}`)).status).toBe(200);
    expect(typeof app.get(Either).canActivateRaw).toBe('function');
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
    const app = appWith(Combined);
    expect(app.get(Combined).canActivateRaw).toBeUndefined();
    expect((await get(app)).status).toBe(403);
    expect((await app.fetch(new Request('http://localhost/secret', { headers: { 'x-ok': '1' } }))).status).toBe(200);
  });

  test('composes guards with constructor dependencies without listing them in providers', async () => {
    const Combined = anyGuard(DbTokenGuard, createBasicAuthGuard({ users: { ada: 'pw' } }));
    const app = appWith(Combined, [TokenService]);
    expect((await get(app, 'Bearer db-token')).status).toBe(200);
    expect((await get(app, `Basic ${btoa('ada:pw')}`)).status).toBe(200);
    expect((await get(app, 'Bearer nope')).status).toBe(401);
    // The guard is the container's singleton, with the module's service injected.
    expect(app.get(TokenService).checked).toEqual(['Bearer db-token', `Basic ${btoa('ada:pw')}`, 'Bearer nope']);
    expect(app.get(Combined).canActivateRaw).toBeFunction();
  });

  test('async guards with dependencies: the first refusal (HttpError) is answered', async () => {
    class No implements CanActivate {
      canActivate() {
        return false;
      }
    }
    const app = appWith(anyGuard(AsyncDbTokenGuard, No), [TokenService]);
    expect((await get(app, 'Bearer db-token')).status).toBe(200);
    const denied = await get(app, 'Bearer nope');
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ message: 'token required' });
  });

  test('a guard the module already provides is shared, not registered twice', async () => {
    const shared = new DbTokenGuard(new TokenService());
    const Combined = anyGuard(DbTokenGuard, createBearerAuthGuard({ tokens: ['tok'] }));
    const app = appWith(Combined, [{ provide: DbTokenGuard, useValue: shared }]);
    expect((await get(app, 'Bearer db-token')).status).toBe(200);
    expect(app.get(DbTokenGuard)).toBe(shared);
  });

  test('a request-scoped composed guard makes the combination request-scoped', async () => {
    let created = 0;
    class PerRequest implements CanActivate {
      constructor() {
        created += 1;
      }
      canActivate() {
        return false;
      }
    }
    const app = appWith(anyGuard(PerRequest, createBearerAuthGuard({ tokens: ['tok'] })), [{ provide: PerRequest, useClass: PerRequest, scope: 'request' }]);
    expect((await get(app, 'Bearer tok')).status).toBe(200);
    expect((await get(app, 'Bearer tok')).status).toBe(200);
    expect(created).toBe(2);
  });

  test('nested combinators resolve their dependencies too', async () => {
    const Combined = anyGuard(everyGuard(DbTokenGuard, createBearerAuthGuard({ tokens: ['db-token'] })), createBasicAuthGuard({ users: { ada: 'pw' } }));
    const app = appWith(Combined, [TokenService]);
    expect((await get(app, 'Bearer db-token')).status).toBe(200);
    expect((await get(app, `Basic ${btoa('ada:pw')}`)).status).toBe(200);
    expect((await get(app)).status).toBe(401);
  });

  test('stays synchronous while the guards answer synchronously', () => {
    class Header implements CanActivate {
      canActivateRaw(request: Request) {
        return request.headers.has('x-ok');
      }
      canActivate() {
        return false;
      }
    }
    class Never implements CanActivate {
      canActivateRaw() {
        return false;
      }
      canActivate() {
        return false;
      }
    }
    const guard = new (anyGuard(Never, Header))();
    const route = manifestWith(Header).routes[0]!;
    expect(guard.canActivateRaw!(new Request('http://localhost/', { headers: { 'x-ok': '1' } }), {}, route)).toBe(true);
    expect(() => guard.canActivateRaw!(new Request('http://localhost/'), {}, route)).toThrow('Forbidden');
  });

  test('rejects fewer than two guards; standalone `new` refuses guards with dependencies', () => {
    expect(() => anyGuard(createBearerAuthGuard({ tokens: ['x'] }))).toThrow(TypeError);
    const Combined = anyGuard(DbTokenGuard, createBearerAuthGuard({ tokens: ['x'] }));
    expect(() => new Combined()).toThrow(/dependencies/);
    expect(Combined.name).toBe('anyGuard(DbTokenGuard, BearerAuthGuard)');
  });
});

describe('everyGuard', () => {
  test('passes only when all guards pass; the first refusal wins', async () => {
    class HeaderOk implements CanActivate {
      canActivateRaw(request: Request) {
        return request.headers.get('x-ok') === '1';
      }
      canActivate(context: RequestContext) {
        return context.request.headers.get('x-ok') === '1';
      }
    }
    const app = appWith(everyGuard(createBearerAuthGuard({ tokens: ['tok'] }), HeaderOk));
    expect((await get(app, 'Bearer tok')).status).toBe(403);
    expect((await get(app)).status).toBe(401);
    expect((await app.fetch(new Request('http://localhost/secret', { headers: { authorization: 'Bearer tok', 'x-ok': '1' } }))).status).toBe(200);
  });

  test('rejects fewer than two guards', () => {
    expect(() => everyGuard(createBearerAuthGuard({ tokens: ['x'] }))).toThrow(TypeError);
  });
});

describe('exceptGuard', () => {
  const appWithRoutes = (guard: unknown, paths: string[], providers: ProviderDefinition[] = []) => createApp(
    defineApplication({ modules: [defineModule({ providers, controllers: [Routes], imports: [] })], globals: { guards: [guard as never] } }),
    { routes: paths.map((path) => routeAt(path, [])) },
  );

  test('skips the guard on matching route templates (exact and prefix)', async () => {
    const app = appWithRoutes(exceptGuard(['/health', '/public/*'], createBearerAuthGuard({ tokens: ['tok'] })), ['/health', '/public', '/public/:file', '/secret', '/healthz']);
    expect((await get(app, undefined, '/health')).status).toBe(200);
    expect((await get(app, undefined, '/public')).status).toBe(200);
    expect((await get(app, undefined, '/public/logo.png')).status).toBe(200);
    expect((await get(app, undefined, '/secret')).status).toBe(401);
    expect((await get(app, undefined, '/healthz')).status).toBe(401);
    expect((await get(app, 'Bearer tok', '/secret')).status).toBe(200);
  });

  test('a predicate decides per request; guards with dependencies work', async () => {
    const app = appWithRoutes(exceptGuard((request) => request.headers.get('x-internal') === '1', DbTokenGuard), ['/secret'], [TokenService]);
    expect((await get(app)).status).toBe(403);
    expect((await app.fetch(new Request('http://localhost/secret', { headers: { 'x-internal': '1' } }))).status).toBe(200);
    expect((await get(app, 'Bearer db-token')).status).toBe(200);
  });

  test('validates patterns', () => {
    const Guard = createBearerAuthGuard({ tokens: ['x'] });
    expect(() => exceptGuard('health', Guard)).toThrow(/start with/);
    expect(() => exceptGuard('/a/*/b', Guard)).toThrow(/only allowed at the end/);
    expect(() => exceptGuard('/health')).toThrow(/at least one guard/);
  });
});
