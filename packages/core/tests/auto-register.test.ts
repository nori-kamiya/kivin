import { createApp, defineApplication, defineModule, setInjectableMetadata, type AppManifest, type CanActivate, type ExceptionFilter, type NestLikeMiddleware, type RequestContext } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

class Config {
  readonly key = 'secret';
}

class Stamp implements NestLikeMiddleware {
  handle(context: RequestContext, next: () => Promise<Response>) {
    context.setResponseHeader('x-stamp', '1');
    return next();
  }
}

// Needs Config, which only the module provides.
class KeyGuard implements CanActivate {
  constructor(private readonly config: Config) {}
  canActivate(context: RequestContext) {
    return context.request.headers.get('x-key') === this.config.key;
  }
}
setInjectableMetadata(KeyGuard, { deps: [Config] });

class RangeFilter implements ExceptionFilter {
  catch(error: unknown) {
    return error instanceof RangeError ? Response.json({ message: 'range' }, { status: 409 }) : undefined;
  }
}

class Routes {
  open() {
    return { ok: true };
  }

  guarded() {
    return { ok: 'guarded' };
  }

  fails() {
    throw new RangeError('x');
  }
}

const route = (methodName: string, extra: Partial<AppManifest['routes'][number]> = {}): AppManifest['routes'][number] => ({
  method: 'GET', fullPath: `/${methodName}`, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});

describe('enhancer classes without a provider entry', () => {
  const app = createApp(defineApplication({
    modules: [defineModule({ providers: [Config], controllers: [Routes], imports: [] })],
    schemaAdapter: createValibotAdapter(),
    // Only middleware: guards / filters may be left out.
    globals: { middleware: [Stamp] },
  }), { routes: [route('open'), route('guarded', { guards: [KeyGuard] }), route('fails', { filters: [RangeFilter] })] });

  test('global middleware runs', async () => {
    const response = await app.fetch(new Request('http://x/open'));
    expect(response.headers.get('x-stamp')).toBe('1');
    expect(await response.json()).toEqual({ ok: true });
  });

  test('route guards get their dependencies from the modules', async () => {
    expect((await app.fetch(new Request('http://x/guarded'))).status).toBe(403);
    expect((await app.fetch(new Request('http://x/guarded', { headers: { 'x-key': 'secret' } }))).status).toBe(200);
  });

  test('route filters run', async () => {
    expect((await app.fetch(new Request('http://x/fails'))).status).toBe(409);
  });

  test('a class that is also a provider keeps its module registration (one instance)', () => {
    const shared = createApp(defineApplication({
      modules: [defineModule({ providers: [Config, Stamp], controllers: [Routes], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      globals: { middleware: [Stamp] },
    }), { routes: [route('open')] });
    expect(shared.get(Stamp)).toBe(shared.get(Stamp));
  });
});
