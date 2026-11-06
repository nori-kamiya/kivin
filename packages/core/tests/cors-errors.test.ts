import { createApp, defineApplication, defineModule, HttpError, type AppManifest, type CanActivate, type ExceptionFilter } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

// Error responses are produced before (validation, guards) or outside (thrown errors, filters) the
// CORS middleware; they must still carry CORS headers or browsers cannot read them.
class DenyGuard implements CanActivate {
  canActivateRaw(request: Request) {
    return request.headers.get('x-key') === 'ok';
  }

  canActivate() {
    return false;
  }
}

class TeapotFilter implements ExceptionFilter {
  catch(error: unknown) {
    return error instanceof RangeError ? Response.json({ message: 'filtered' }, { status: 409 }) : undefined;
  }
}

class Routes {
  echo({ query }: { query: unknown }) {
    return query;
  }

  create({ body }: { body: unknown }) {
    return body;
  }

  teapot() {
    throw new HttpError(418, 'tea');
  }

  crash() {
    throw new Error('boom');
  }

  filtered() {
    throw new RangeError('x');
  }

  async proxied() {
    // A fetched response has immutable headers.
    return (await fetch('data:text/plain,proxied')) as Response;
  }
}

type Route = AppManifest['routes'][number];
const route = (input: Pick<Route, 'method' | 'fullPath' | 'methodName'> & Partial<Route>): Route => ({
  controller: Routes,
  parameters: [],
  guards: [],
  middleware: [],
  filters: [],
  docs: { tags: [], security: [], responses: [] },
  ...input,
});

const routes: Route[] = [
  route({ method: 'GET', fullPath: '/echo', methodName: 'echo', parameters: [{ index: 0, source: 'input', fields: ['query'] }], docs: { tags: [], security: [], responses: [], querySchema: v.object({ n: v.string() }) } }),
  route({ method: 'POST', fullPath: '/create', methodName: 'create', parameters: [{ index: 0, source: 'input', fields: ['body'] }], docs: { tags: [], security: [], responses: [], bodySchema: v.object({ name: v.string() }) } }),
  route({ method: 'GET', fullPath: '/guarded', methodName: 'echo', guards: [DenyGuard] }),
  route({ method: 'GET', fullPath: '/teapot', methodName: 'teapot' }),
  route({ method: 'GET', fullPath: '/crash', methodName: 'crash' }),
  route({ method: 'GET', fullPath: '/filtered', methodName: 'filtered', filters: [TeapotFilter] }),
  route({ method: 'GET', fullPath: '/proxied', methodName: 'proxied' }),
];

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [DenyGuard, TeapotFilter], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  cors: { origin: 'https://app.example', credentials: true },
}), { routes });

const call = (path: string, init: RequestInit = {}, origin = 'https://app.example') =>
  app.fetch(new Request(`http://x${path}`, { ...init, headers: { origin, ...(init.headers as Record<string, string> | undefined) } }));

describe('CORS headers on error responses', () => {
  const cases: Array<[string, () => Promise<Response>, number]> = [
    ['query validation 400', () => call('/echo'), 400],
    ['body validation 400', () => call('/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), 400],
    ['malformed JSON body', () => call('/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), 400],
    ['guard rejection 403', () => call('/guarded'), 403],
    ['thrown HttpError', () => call('/teapot'), 418],
    ['unhandled error 500', () => call('/crash'), 500],
    ['filter response', () => call('/filtered'), 409],
  ];

  for (const [name, request, status] of cases) {
    test(name, async () => {
      const response = await request();
      expect(response.status).toBe(status);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    });
  }

  test('successful responses get the headers once (no duplicated Vary)', async () => {
    const response = await call('/echo?n=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  test('responses with immutable headers are copied instead of failing', async () => {
    const response = await call('/proxied');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('proxied');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  test('disallowed origins get no CORS headers on errors either', async () => {
    const response = await call('/teapot', {}, 'https://evil.example');
    expect(response.status).toBe(418);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
