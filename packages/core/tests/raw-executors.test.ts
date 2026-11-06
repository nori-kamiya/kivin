import { createApp, defineApplication, defineModule, HttpError, type AppManifest, type CanActivate, type ExceptionFilter, type NestLikeMiddleware, type RequestContext, type ResponseState } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

// Behaviour matrix for the raw (context-free) executors: every combination of raw middleware, raw
// guard and exception filter with and without a body must queue middleware headers, map malformed
// JSON to 400, hand errors to filters (which can still read the validated body) and read the body
// once even when a middleware calls `next()` twice.

class Boom extends Error {}

class HeaderMiddleware implements NestLikeMiddleware {
  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    context.setResponseHeader('x-mw', 'ctx');
    return next();
  }

  handleRaw(_request: Request, _params: Record<string, string>, state: ResponseState, next: () => Response | PromiseLike<Response>) {
    state.setResponseHeader('x-mw', 'raw');
    return next();
  }
}

class SecondMiddleware implements NestLikeMiddleware {
  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    context.setResponseHeader('x-mw2', 'ctx');
    return next();
  }

  handleRaw(_request: Request, _params: Record<string, string>, state: ResponseState, next: () => Response | PromiseLike<Response>) {
    state.setResponseHeader('x-mw2', 'raw');
    return next();
  }
}

/** Calls `next()` twice and answers with the second response. */
class RetryMiddleware implements NestLikeMiddleware {
  handle(_context: RequestContext, next: () => Response | PromiseLike<Response>) {
    return next();
  }

  async handleRaw(_request: Request, _params: Record<string, string>, _state: ResponseState, next: () => Response | PromiseLike<Response>) {
    await next();
    return next();
  }
}

class KeyGuard implements CanActivate {
  canActivateRaw(request: Request) {
    return request.headers.get('x-key') === 'ok';
  }

  canActivate(context: RequestContext) {
    return context.request.headers.get('x-key') === 'ok';
  }
}

class EchoBodyFilter implements ExceptionFilter {
  async catch(error: unknown, context: RequestContext) {
    if (error instanceof Boom) {
      return Response.json({ filtered: true, body: context.request.method === 'GET' ? null : await context.jsonBody() }, { status: 418 });
    }
    return undefined;
  }
}

const Body = v.object({ name: v.pipe(v.string(), v.transform((name) => name.toUpperCase())) });
const Params = v.object({ id: v.string() });
const Query = v.object({ q: v.optional(v.string()) });

let handlerCalls = 0;

class Routes {
  noInput() {
    handlerCalls += 1;
    return { ok: true };
  }

  byParam({ params }: { params: { id: string } }) {
    handlerCalls += 1;
    if (params.id === 'boom') {
      throw new Boom();
    }
    return { id: params.id };
  }

  withQuery({ query }: { query: { q?: string } }) {
    handlerCalls += 1;
    return { q: query.q ?? null };
  }

  bodyOnly(body: { name: string }) {
    handlerCalls += 1;
    if (body.name === 'BOOM') {
      throw new Boom();
    }
    return { name: body.name };
  }

  pathBody(id: string, body: { name: string }) {
    handlerCalls += 1;
    if (body.name === 'BOOM') {
      throw new Boom();
    }
    return { id, name: body.name };
  }

  queryBody({ body, query }: { body: { name: string }; query: { q?: string } }) {
    handlerCalls += 1;
    if (body.name === 'BOOM') {
      throw new Boom();
    }
    return { name: body.name, q: query.q ?? null };
  }

  noContent() {
    handlerCalls += 1;
    return undefined;
  }
}

type Route = AppManifest['routes'][number];
const docs = (extra: Partial<Route['docs']> = {}): Route['docs'] => ({ tags: [], security: [], responses: [], ...extra });
const base = (method: Route['method'], fullPath: string, methodName: string, extra: Partial<Route>): Route => ({
  method, fullPath, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [], docs: docs(), ...extra,
});

/** Route shapes that select the different raw executors. */
const shapes = (prefix: string, enhancers: Partial<Route>): Route[] => [
  base('GET', `${prefix}/no-input`, 'noInput', enhancers),
  base('GET', `${prefix}/param/:id`, 'byParam', { ...enhancers, parameters: [{ index: 0, source: 'input', fields: ['params'] }], docs: docs({ paramSchema: Params }) }),
  base('GET', `${prefix}/query`, 'withQuery', { ...enhancers, parameters: [{ index: 0, source: 'input', fields: ['query'] }], docs: docs({ querySchema: Query }) }),
  base('POST', `${prefix}/body`, 'bodyOnly', { ...enhancers, parameters: [{ index: 0, source: 'body' }], docs: docs({ bodySchema: Body }) }),
  base('POST', `${prefix}/created`, 'bodyOnly', { ...enhancers, parameters: [{ index: 0, source: 'body' }], docs: docs({ bodySchema: Body, responses: [{ status: 201, description: 'created' }] }) }),
  base('PATCH', `${prefix}/path-body/:id`, 'pathBody', { ...enhancers, parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }], docs: docs({ bodySchema: Body, paramSchema: Params }) }),
  base('POST', `${prefix}/query-body`, 'queryBody', { ...enhancers, parameters: [{ index: 0, source: 'input', fields: ['body', 'query'] }], docs: docs({ bodySchema: Body, querySchema: Query }) }),
  base('DELETE', `${prefix}/no-content`, 'noContent', { ...enhancers, docs: docs({ responses: [{ status: 204, description: 'gone' }] }) }),
];

const variants: Array<{ name: string; enhancers: Partial<Route>; guarded: boolean; filtered: boolean; header?: string }> = [
  { name: 'mw', enhancers: { middleware: [HeaderMiddleware] as never }, guarded: false, filtered: false, header: 'raw' },
  { name: 'mw-guard', enhancers: { middleware: [HeaderMiddleware] as never, guards: [KeyGuard] as never }, guarded: true, filtered: false, header: 'raw' },
  { name: 'mw-guard-filter', enhancers: { middleware: [HeaderMiddleware] as never, guards: [KeyGuard] as never, filters: [EchoBodyFilter] as never }, guarded: true, filtered: true, header: 'raw' },
  { name: 'mw-filter', enhancers: { middleware: [HeaderMiddleware] as never, filters: [EchoBodyFilter] as never }, guarded: false, filtered: true, header: 'raw' },
  { name: 'guard-filter', enhancers: { guards: [KeyGuard] as never, filters: [EchoBodyFilter] as never }, guarded: true, filtered: true },
  { name: 'guard', enhancers: { guards: [KeyGuard] as never }, guarded: true, filtered: false },
  { name: 'two-mw-guard', enhancers: { middleware: [HeaderMiddleware, SecondMiddleware] as never, guards: [KeyGuard] as never, filters: [EchoBodyFilter] as never }, guarded: true, filtered: true, header: 'raw' },
];

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [HeaderMiddleware, SecondMiddleware, RetryMiddleware, KeyGuard, EchoBodyFilter], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), {
  routes: [
    ...variants.flatMap((variant) => shapes(`/${variant.name}`, variant.enhancers)),
    ...shapes('/retry', { middleware: [RetryMiddleware] as never }),
  ],
});

const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, {
  ...init,
  headers: { 'x-key': 'ok', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) },
}));
const json = (method: string, body: string) => ({ method, body });

describe.each(variants)('raw executor: $name', ({ name, guarded, filtered, header }) => {
  const expectHeader = (response: Response) => expect(response.headers.get('x-mw')).toBe(header ?? null);

  test('answers with the handler result and the middleware header', async () => {
    const cases: Array<[string, RequestInit, number, unknown]> = [
      [`/${name}/no-input`, {}, 200, { ok: true }],
      [`/${name}/param/7`, {}, 200, { id: '7' }],
      [`/${name}/query?q=x`, {}, 200, { q: 'x' }],
      [`/${name}/body`, json('POST', '{"name":"ada"}'), 200, { name: 'ADA' }],
      [`/${name}/created`, json('POST', '{"name":"ada"}'), 201, { name: 'ADA' }],
      [`/${name}/path-body/3`, json('PATCH', '{"name":"ada"}'), 200, { id: '3', name: 'ADA' }],
      [`/${name}/query-body?q=y`, json('POST', '{"name":"ada"}'), 200, { name: 'ADA', q: 'y' }],
    ];
    for (const [path, init, status, body] of cases) {
      const response = await call(path, init);
      expect({ path, status: response.status }).toEqual({ path, status });
      expect(await response.json()).toEqual(body);
      expectHeader(response);
    }

    const gone = await call(`/${name}/no-content`, { method: 'DELETE' });
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe('');
    expectHeader(gone);
  });

  test('maps malformed JSON to 400 and invalid bodies to 400', async () => {
    for (const path of ['body', 'created', 'path-body/3', 'query-body']) {
      const method = path.startsWith('path-body') ? 'PATCH' : 'POST';
      const malformed = await call(`/${name}/${path}`, json(method, '{"name":'));
      expect({ path, status: malformed.status }).toEqual({ path, status: 400 });
      expect(await malformed.json()).toEqual({ message: 'Invalid JSON body' });
      expectHeader(malformed);

      const invalid = await call(`/${name}/${path}`, json(method, '{"name":1}'));
      expect({ path, status: invalid.status }).toEqual({ path, status: 400 });
    }
  });

  test.if(guarded)('rejects without the key (403) and does not run the handler', async () => {
    handlerCalls = 0;
    for (const [path, init] of [[`/${name}/no-input`, {}], [`/${name}/body`, json('POST', '{"name":"ada"}')]] as const) {
      const response = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { 'content-type': 'application/json' } }));
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toBe('application/json;charset=utf-8');
      expect(await response.json()).toEqual({ message: 'Forbidden' });
    }
    expect(handlerCalls).toBe(0);
  });

  test('hands handler errors to the filter, which sees the validated body', async () => {
    const thrown = await call(`/${name}/param/boom`);
    const withBody = await call(`/${name}/body`, json('POST', '{"name":"boom"}'));
    const pathBody = await call(`/${name}/path-body/1`, json('PATCH', '{"name":"boom"}'));
    const queryBody = await call(`/${name}/query-body`, json('POST', '{"name":"boom"}'));
    if (!filtered) {
      for (const response of [thrown, withBody, pathBody, queryBody]) {
        expect(response.status).toBe(500);
        expectHeader(response);
      }
      return;
    }
    expect(thrown.status).toBe(418);
    expect(await thrown.json()).toMatchObject({ filtered: true });
    for (const response of [withBody, pathBody, queryBody]) {
      expect(response.status).toBe(418);
      expect(await response.json()).toEqual({ filtered: true, body: { name: 'BOOM' } });
    }
  });
});

describe('raw executor: middleware calling next() twice', () => {
  test('reads the body once and runs the handler again', async () => {
    for (const [path, method, expected] of [
      ['/retry/body', 'POST', { name: 'ADA' }],
      ['/retry/created', 'POST', { name: 'ADA' }],
      ['/retry/path-body/2', 'PATCH', { id: '2', name: 'ADA' }],
      ['/retry/query-body?q=z', 'POST', { name: 'ADA', q: 'z' }],
    ] as const) {
      handlerCalls = 0;
      const response = await call(path, json(method, '{"name":"ada"}'));
      expect({ path, status: response.status }).toEqual({ path, status: method === 'POST' && path === '/retry/created' ? 201 : 200 });
      expect(await response.json()).toEqual(expected);
      expect(handlerCalls).toBe(2);
    }
  });
});

describe('HttpError responses', () => {
  test('without custom headers: native JSON content type, the body, or an empty body', async () => {
    const plain = new HttpError(409, 'Conflict').toResponse();
    expect(plain.status).toBe(409);
    expect(plain.headers.get('content-type')).toBe('application/json;charset=utf-8');
    expect(await plain.json()).toEqual({ message: 'Conflict' });

    const custom = new HttpError(422, 'Bad', { body: { issues: [1] } }).toResponse();
    expect(await custom.json()).toEqual({ issues: [1] });

    const empty = new HttpError(304, 'Not Modified', { body: undefined }).toResponse();
    expect(empty.status).toBe(304);
    expect(empty.headers.get('content-type')).toBeNull();
    expect(await empty.text()).toBe('');
  });

  test('with custom headers: headers kept, JSON content type unless overridden', async () => {
    const withHeader = new HttpError(429, 'Slow down', { headers: { 'retry-after': '3' } }).toResponse();
    expect(withHeader.headers.get('retry-after')).toBe('3');
    expect(withHeader.headers.get('content-type')).toBe('application/json;charset=utf-8');
    expect(await withHeader.json()).toEqual({ message: 'Slow down' });

    const text = new HttpError(400, 'x', { body: 'plain', headers: { 'content-type': 'text/plain' } }).toResponse();
    expect(text.headers.get('content-type')).toBe('text/plain');
    expect(await text.text()).toBe('"plain"');
  });
});
