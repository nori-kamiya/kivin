import {
    conflict,
    createApp,
    createSecureHeadersMiddleware,
    defineApplication,
    defineModule,
    notModified,
    preconditionFailed,
    RequestContext,
    SecureHeadersMiddleware,
    serviceUnavailable,
    setInjectableMetadata,
    tooManyRequests,
    type AppManifest,
    type CanActivate,
    type ExceptionFilter,
    type NestLikeMiddleware,
    type ResponseState,
} from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

const EchoSchema = v.object({
  name: v.string(),
});

const SearchQuerySchema = v.object({
  search: v.pipe(v.string(), v.minLength(2)),
});

const OptionalSearchQuerySchema = v.object({
  search: v.optional(v.string()),
});

const IdParamSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^\d+$/)),
});

const SecureSchema = v.object({
  ok: v.boolean(),
  stamp: v.string(),
});

const REQUEST_TRACE = Symbol.for('test.requestTrace');
let requestTraceInstances = 0;

class HeaderGuard implements CanActivate {
  canActivate(context: RequestContext) {
    return context.req.raw.headers.get('x-auth') === 'ok';
  }
}

class RawHeaderGuard implements CanActivate {
  canActivate() {
    throw new Error('raw guard fallback should not be used');
  }

  canActivateRaw(request: Request) {
    return request.headers.get('x-raw-auth') === 'ok';
  }
}

class AsyncRawHeaderGuard implements CanActivate {
  canActivate() {
    throw new Error('raw guard fallback should not be used');
  }

  async canActivateRaw(request: Request) {
    await Promise.resolve();
    return request.headers.get('x-raw-auth') === 'ok';
  }
}

class StampMiddleware implements NestLikeMiddleware {
  async handle(context: RequestContext, next: () => Promise<Response>) {
    context.set('stamp', 'seen');
    const response = await next();
    response.headers.set('x-stamp', context.get('stamp') ?? 'missing');
    return response;
  }
}

class StopMiddleware implements NestLikeMiddleware {
  handle(context: RequestContext) {
    return context.json({ stopped: true }, { status: 202 });
  }
}

class QueuedHeaderMiddleware implements NestLikeMiddleware {
  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    context.setResponseHeader('x-request-id', context.request.headers.get('x-request-id') ?? 'generated');
    return next();
  }
}

class RawQueuedHeaderMiddleware implements NestLikeMiddleware {
  handle() {
    throw new Error('raw middleware fallback should not be used');
  }

  handleRaw(request: Request, _params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>) {
    responseState.setResponseHeader('x-request-id', request.headers.get('x-request-id') ?? 'raw-generated');
    return next();
  }
}

class RawTraceMiddleware implements NestLikeMiddleware {
  handle() {
    throw new Error('raw middleware fallback should not be used');
  }

  handleRaw(_request: Request, _params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>) {
    responseState.setResponseHeader('x-raw-trace', 'trace-1');
    return next();
  }
}

class RawQueuedHeaderUseMiddleware implements NestLikeMiddleware {
  handle() {
    throw new Error('raw middleware fallback should not be used');
  }

  useRaw(request: Request, _params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>) {
    responseState.setResponseHeader('x-request-id', request.headers.get('x-request-id') ?? 'raw-generated');
    return next();
  }
}

class RawTraceUseMiddleware implements NestLikeMiddleware {
  handle() {
    throw new Error('raw middleware fallback should not be used');
  }

  useRaw(_request: Request, _params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>) {
    responseState.setResponseHeader('x-raw-trace', 'trace-use');
    return next();
  }
}

class RawFailureMiddleware implements NestLikeMiddleware {
  handle() {
    throw new Error('raw middleware fallback should not be used');
  }

  handleRaw(_request: Request, _params: Record<string, string>, responseState: ResponseState) {
    responseState.setResponseHeader('x-request-id', 'raw-error');
    throw new Error('raw-middleware-boom');
  }
}

class RawStopMiddleware implements NestLikeMiddleware {
  handle() {
    throw new Error('raw middleware fallback should not be used');
  }

  handleRaw() {
    return new Response(JSON.stringify({ stopped: true }), {
      status: 202,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}

class BoomFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'boom') {
      return undefined;
    }

    return context.json({ message: 'handled' }, { status: 418 });
  }
}

class OuterBoomFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'boom') {
      return undefined;
    }

    return context.json({ message: 'outer' }, { status: 409 });
  }
}

class InnerBoomFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'boom') {
      return undefined;
    }

    return context.json({ message: 'inner' }, { status: 410 });
  }
}

class GlobalOrderMiddleware implements NestLikeMiddleware {
  async handle(context: RequestContext, next: () => Promise<Response>) {
    const order = context.get<string[]>('middleware-order') ?? [];
    order.push('global:before');
    context.set('middleware-order', order);

    const response = await next();
    order.push('global:after');
    response.headers.set('x-middleware-order', order.join('>'));
    return response;
  }
}

class RouteOrderMiddleware implements NestLikeMiddleware {
  async handle(context: RequestContext, next: () => Promise<Response>) {
    const order = context.get<string[]>('middleware-order') ?? [];
    order.push('route:before');
    context.set('middleware-order', order);

    const response = await next();
    order.push('route:after');
    return response;
  }
}

class GlobalOuterOrderMiddleware implements NestLikeMiddleware {
  async handle(context: RequestContext, next: () => Promise<Response>) {
    const order = context.get<string[]>('middleware-order') ?? [];
    order.push('global-outer:before');
    context.set('middleware-order', order);

    const response = await next();
    order.push('global-outer:after');
    response.headers.set('x-middleware-order', order.join('>'));
    return response;
  }
}

class GlobalInnerOrderMiddleware implements NestLikeMiddleware {
  async handle(context: RequestContext, next: () => Promise<Response>) {
    const order = context.get<string[]>('middleware-order') ?? [];
    order.push('global-inner:before');
    context.set('middleware-order', order);

    const response = await next();
    order.push('global-inner:after');
    return response;
  }
}

class RouteOuterOrderMiddleware implements NestLikeMiddleware {
  async handle(context: RequestContext, next: () => Promise<Response>) {
    const order = context.get<string[]>('middleware-order') ?? [];
    order.push('route-outer:before');
    context.set('middleware-order', order);

    const response = await next();
    order.push('route-outer:after');
    return response;
  }
}

class RouteInnerOrderMiddleware implements NestLikeMiddleware {
  async handle(context: RequestContext, next: () => Promise<Response>) {
    const order = context.get<string[]>('middleware-order') ?? [];
    order.push('route-inner:before');
    context.set('middleware-order', order);

    const response = await next();
    order.push('route-inner:after');
    return response;
  }
}

class GlobalFallbackFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'boom') {
      return undefined;
    }

    return context.json({ message: 'global-fallback' }, { status: 452 });
  }
}

class RouteInnerPassFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'boom') {
      return undefined;
    }

    const order = context.get<string[]>('filter-order') ?? [];
    order.push('route-inner:pass');
    context.set('filter-order', order);
    return undefined;
  }
}

class RouteOuterPassFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'boom') {
      return undefined;
    }

    const order = context.get<string[]>('filter-order') ?? [];
    order.push('route-outer:pass');
    context.set('filter-order', order);
    return undefined;
  }
}

class GlobalInnerPassFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'boom') {
      return undefined;
    }

    const order = context.get<string[]>('filter-order') ?? [];
    order.push('global-inner:pass');
    context.set('filter-order', order);
    return undefined;
  }
}

class GlobalOuterHandleFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'boom') {
      return undefined;
    }

    const order = context.get<string[]>('filter-order') ?? [];
    order.push('global-outer:handle');
    context.set('filter-order', order);
    return context.json({ order }, { status: 453 });
  }
}

class RequestScopedGuard implements CanActivate {
  constructor(private readonly trace: { instance: number; requestId: string }) {}

  canActivate(context: RequestContext) {
    context.set('request-guard-instance', this.trace.instance);
    return this.trace.requestId === context.req.raw.headers.get('x-allow-request-id');
  }
}

class RequestScopedMiddleware implements NestLikeMiddleware {
  constructor(private readonly trace: { instance: number; requestId: string }) {}

  async handle(context: RequestContext, next: () => Promise<Response>) {
    context.set('request-middleware-instance', this.trace.instance);
    const response = await next();
    response.headers.set('x-request-middleware-instance', String(this.trace.instance));
    return response;
  }
}

class RequestScopedFilter implements ExceptionFilter {
  constructor(private readonly trace: { instance: number; requestId: string }) {}

  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'request-scoped-boom') {
      return undefined;
    }

    return context.json({
      filterInstance: this.trace.instance,
      requestId: this.trace.requestId,
    }, { status: 419 });
  }
}

class RequestScopedController {
  constructor(private readonly trace: { instance: number; requestId: string }) {}

  stack(context: RequestContext) {
    return {
      controllerInstance: this.trace.instance,
      guardInstance: context.get('request-guard-instance'),
      middlewareInstance: context.get('request-middleware-instance'),
      requestId: this.trace.requestId,
    };
  }

  boom() {
    throw new Error('request-scoped-boom');
  }
}

setInjectableMetadata(RequestScopedGuard, { deps: [REQUEST_TRACE] });
setInjectableMetadata(RequestScopedMiddleware, { deps: [REQUEST_TRACE] });
setInjectableMetadata(RequestScopedFilter, { deps: [REQUEST_TRACE] });
setInjectableMetadata(RequestScopedController, { deps: [REQUEST_TRACE] });

class TestController {
  staticHealth() {
    return { ok: true };
  }

  secure(context: RequestContext) {
    return { ok: true, stamp: context.get('stamp') ?? 'missing' };
  }

  invalidSecure() {
    return { ok: 'invalid', stamp: 123 };
  }

  secureHead(context: RequestContext) {
    return context.text('explicit head', { status: 204, headers: { 'x-head-handler': 'yes' } });
  }

  secureOptions(context: RequestContext) {
    return context.text('explicit options', { status: 200, headers: { allow: 'GET, HEAD, OPTIONS', 'x-options-handler': 'yes' } });
  }

  customSecurityHeaders(context: RequestContext) {
    return context.text('secured', {
      headers: {
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-frame-options': 'SAMEORIGIN',
      },
    });
  }

  contextHealth(context: RequestContext) {
    return context.json({ ok: true, stamp: context.get('stamp') ?? 'none' });
  }

  queuedHealth() {
    return { ok: true, stamp: 'queued' };
  }

  queuedCreated(context: RequestContext) {
    context.setResponseStatus(201);
    return { ok: true, stamp: context.get('stamp') ?? 'created' };
  }

  queuedNoContentViaStatus(context: RequestContext) {
    context.setResponseStatus(204);
    context.set('stamp', 'deleted');
    return undefined;
  }

  fastStatusNoContent(context: RequestContext) {
    context.setResponseStatus(204);
    return undefined;
  }

  defaultCreated() {
    return { ok: true, stamp: 'default-created' };
  }

  defaultNoContent() {
    return undefined;
  }

  boom() {
    throw new Error('boom');
  }

  unhandledBoom() {
    throw new Error('unhandled');
  }

  echo(body: { name: string }) {
    return body;
  }

  rawEcho(body: { name: string }) {
    return body;
  }

  rawUpdate(id: string, body: { name: string }) {
    return { id, name: body.name };
  }

  async rawEchoWithContext(context: RequestContext, body: { name: string }) {
    const cachedBody = await context.jsonBody<{ name: string }>();
    return { sameReference: cachedBody === body, value: cachedBody.name };
  }

  search(search: string) {
    return { search };
  }

  optionalSearch(search: string | undefined) {
    return { search: search ?? null };
  }

  searchViaContext(context: RequestContext) {
    return { search: context.req.query('search') };
  }

  byId(id: string) {
    return { id };
  }

  failConflict() {
    throw conflict('email conflict');
  }

  failRateLimited() {
    throw tooManyRequests('slow down', {
      headers: { 'retry-after': '60' },
    });
  }

  failPrecondition() {
    throw preconditionFailed('etag mismatch', {
      headers: { etag: '"next-version"' },
    });
  }

  notChanged() {
    throw notModified({
      headers: { etag: '"current-version"' },
    });
  }

  failUnavailable() {
    throw serviceUnavailable('maintenance window', {
      headers: { 'retry-after': '120' },
    });
  }

  requestTrace(context: RequestContext) {
    const first = context.inject<{ instance: number; requestId: string }>(REQUEST_TRACE);
    const second = context.inject<{ instance: number; requestId: string }>(REQUEST_TRACE);

    return {
      instance: first.instance,
      requestId: first.requestId,
      sameReference: first === second,
    };
  }

  middlewareOrder(context: RequestContext) {
    return { order: context.get<string[]>('middleware-order') ?? [] };
  }

  erase(context: RequestContext) {
    return context.noContent();
  }
}

const testModule = defineModule({
  providers: [
    HeaderGuard,
    RawHeaderGuard,
    StampMiddleware,
    StopMiddleware,
    QueuedHeaderMiddleware,
    BoomFilter,
    OuterBoomFilter,
    InnerBoomFilter,
    { provide: RequestScopedGuard, scope: 'request', useClass: RequestScopedGuard },
    { provide: RequestScopedMiddleware, scope: 'request', useClass: RequestScopedMiddleware },
    { provide: RequestScopedFilter, scope: 'request', useClass: RequestScopedFilter },
    { provide: RequestScopedController, scope: 'request', useClass: RequestScopedController },
    {
      provide: REQUEST_TRACE,
      scope: 'request',
      useFactory: (container) => {
        const context = container.resolve(RequestContext);
        requestTraceInstances += 1;

        return {
          instance: requestTraceInstances,
          requestId: context.req.raw.headers.get('x-request-id') ?? 'missing',
        };
      },
    },
  ],
  controllers: [TestController, RequestScopedController],
  imports: [],
});

const appDefinition = defineApplication({
  modules: [testModule],
  schemaAdapter: createValibotAdapter(),
  globals: {
    guards: [],
    middleware: [StampMiddleware],
    filters: [],
  },
});

const manifest: AppManifest = {
  routes: [
    {
      method: 'GET',
      fullPath: '/test/static',
      controller: TestController,
      methodName: 'staticHealth',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/secure',
      controller: TestController,
      methodName: 'secure',
      parameters: [{ index: 0, source: 'context' }],
      guards: [HeaderGuard],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 200, description: 'Secure response', schema: SecureSchema }],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/secure-invalid',
      controller: TestController,
      methodName: 'invalidSecure',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 200, description: 'Secure response', schema: SecureSchema }],
      },
    },
    {
      method: 'HEAD',
      fullPath: '/test/secure',
      controller: TestController,
      methodName: 'secureHead',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'OPTIONS',
      fullPath: '/test/secure',
      controller: TestController,
      methodName: 'secureOptions',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/boom',
      controller: TestController,
      methodName: 'boom',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [BoomFilter],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/stop',
      controller: TestController,
      methodName: 'secure',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [StopMiddleware],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'POST',
      fullPath: '/test/echo',
      controller: TestController,
      methodName: 'echo',
      parameters: [{ index: 0, source: 'body' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        bodySchema: EchoSchema,
        responses: [{ status: 200, description: 'Echo response', schema: EchoSchema }],
      },
    },
    {
      method: 'POST',
      fullPath: '/test/raw-echo',
      controller: TestController,
      methodName: 'rawEcho',
      parameters: [{ index: 0, source: 'body' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'POST',
      fullPath: '/test/raw-echo-context',
      controller: TestController,
      methodName: 'rawEchoWithContext',
      parameters: [{ index: 0, source: 'context' }, { index: 1, source: 'body' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'POST',
      fullPath: '/test/raw-guard',
      controller: TestController,
      methodName: 'rawEcho',
      parameters: [{ index: 0, source: 'body' }],
      guards: [RawHeaderGuard],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/search',
      controller: TestController,
      methodName: 'search',
      parameters: [{ index: 0, source: 'query', name: 'search' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        querySchema: SearchQuerySchema,
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/optional-search',
      controller: TestController,
      methodName: 'optionalSearch',
      parameters: [{ index: 0, source: 'query', name: 'search' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        querySchema: OptionalSearchQuerySchema,
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/search-context',
      controller: TestController,
      methodName: 'searchViaContext',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/items/:id',
      controller: TestController,
      methodName: 'byId',
      parameters: [{ index: 0, source: 'path', name: 'id' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        paramSchema: IdParamSchema,
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/raw-items/:id',
      controller: TestController,
      methodName: 'byId',
      parameters: [{ index: 0, source: 'path', name: 'id' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/conflict',
      controller: TestController,
      methodName: 'failConflict',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/rate-limited',
      controller: TestController,
      methodName: 'failRateLimited',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/precondition',
      controller: TestController,
      methodName: 'failPrecondition',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/not-modified',
      controller: TestController,
      methodName: 'notChanged',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/unavailable',
      controller: TestController,
      methodName: 'failUnavailable',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/request-trace',
      controller: TestController,
      methodName: 'requestTrace',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/request-scoped-stack',
      controller: RequestScopedController,
      methodName: 'stack',
      parameters: [{ index: 0, source: 'context' }],
      guards: [RequestScopedGuard],
      middleware: [RequestScopedMiddleware],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/request-scoped-boom',
      controller: RequestScopedController,
      methodName: 'boom',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [RequestScopedFilter],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/request-scoped-filter-pass',
      controller: TestController,
      methodName: 'staticHealth',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [RequestScopedFilter],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'DELETE',
      fullPath: '/test/items/:id',
      controller: TestController,
      methodName: 'erase',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 204, description: 'Deleted' }],
      },
    },
    {
      method: 'DELETE',
      fullPath: '/test/status-no-content-fast',
      controller: TestController,
      methodName: 'fastStatusNoContent',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 204, description: 'Deleted' }],
      },
    },
    {
      method: 'POST',
      fullPath: '/test/default-created',
      controller: TestController,
      methodName: 'defaultCreated',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 201, description: 'Created', schema: SecureSchema }],
      },
    },
    {
      method: 'DELETE',
      fullPath: '/test/default-no-content',
      controller: TestController,
      methodName: 'defaultNoContent',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 204, description: 'Deleted' }],
      },
    },
    {
      method: 'DELETE',
      fullPath: '/test/queued/items/:id',
      controller: TestController,
      methodName: 'erase',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [QueuedHeaderMiddleware],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 204, description: 'Deleted' }],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/queued/conflict',
      controller: TestController,
      methodName: 'failConflict',
      parameters: [],
      guards: [],
      middleware: [QueuedHeaderMiddleware],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/queued/health',
      controller: TestController,
      methodName: 'queuedHealth',
      parameters: [],
      guards: [],
      middleware: [QueuedHeaderMiddleware],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 200, description: 'Secure response', schema: SecureSchema }],
      },
    },
    {
      method: 'POST',
      fullPath: '/test/queued/create',
      controller: TestController,
      methodName: 'queuedCreated',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [QueuedHeaderMiddleware],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 201, description: 'Created', schema: SecureSchema }],
      },
    },
    {
      method: 'POST',
      fullPath: '/test/queued/default-created',
      controller: TestController,
      methodName: 'defaultCreated',
      parameters: [],
      guards: [],
      middleware: [QueuedHeaderMiddleware],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 201, description: 'Created', schema: SecureSchema }],
      },
    },
    {
      method: 'DELETE',
      fullPath: '/test/queued/status-no-content',
      controller: TestController,
      methodName: 'queuedNoContentViaStatus',
      parameters: [{ index: 0, source: 'context' }],
      guards: [],
      middleware: [QueuedHeaderMiddleware],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [{ status: 204, description: 'Deleted' }],
      },
    },
    {
      method: 'GET',
      fullPath: '/test/queued/unhandled',
      controller: TestController,
      methodName: 'unhandledBoom',
      parameters: [],
      guards: [],
      middleware: [QueuedHeaderMiddleware],
      filters: [],
      docs: {
        tags: ['test'],
        security: [],
        responses: [],
      },
    },
  ],
};

const app = createApp(appDefinition, manifest);

describe('createApp pipeline', () => {
  test('guard denies unauthorized requests', async () => {
    const response = await app.fetch(new Request('http://localhost/test/secure'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: 'Forbidden' });
  });

  test('middleware runs and response schema is validated', async () => {
    const response = await app.fetch(new Request('http://localhost/test/secure', {
      headers: { 'x-auth': 'ok' },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-stamp')).toBe('seen');
    expect(await response.json()).toEqual({ ok: true, stamp: 'seen' });
  });

  test('single middleware fast path still validates response schemas', async () => {
    const response = await app.fetch(new Request('http://localhost/test/secure-invalid', {
      headers: { 'x-auth': 'ok' },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: 'response validation failed',
      issues: expect.any(Array),
    });
  });

  test('queued response headers are applied to no-content responses', async () => {
    const response = await app.fetch(new Request('http://localhost/test/queued/items/1', {
      method: 'DELETE',
      headers: { 'x-request-id': 'queued-1' },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('x-request-id')).toBe('queued-1');
    expect(response.headers.get('content-type')).toBeNull();
  });

  test('queued response headers are applied to error responses', async () => {
    const response = await app.fetch(new Request('http://localhost/test/queued/conflict', {
      headers: { 'x-request-id': 'queued-err-1' },
    }));

    expect(response.status).toBe(409);
    expect(response.headers.get('x-request-id')).toBe('queued-err-1');
    expect(await response.json()).toEqual({ message: 'email conflict' });
  });

  test('queued response headers are applied to json success responses', async () => {
    const response = await app.fetch(new Request('http://localhost/test/queued/health', {
      headers: { 'x-request-id': 'queued-ok-1' },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('queued-ok-1');
    expect(await response.json()).toEqual({ ok: true, stamp: 'queued' });
  });

  test('queued response status is applied to plain json responses', async () => {
    const response = await app.fetch(new Request('http://localhost/test/queued/create', {
      method: 'POST',
      headers: { 'x-request-id': 'queued-create-1' },
    }));

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('queued-create-1');
    expect(await response.json()).toEqual({ ok: true, stamp: 'seen' });
  });

  test('queued response status can produce no-content without an explicit Response', async () => {
    const response = await app.fetch(new Request('http://localhost/test/queued/status-no-content', {
      method: 'DELETE',
      headers: { 'x-request-id': 'queued-nc-1' },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('x-request-id')).toBe('queued-nc-1');
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });

  test('single middleware fast path can produce no-content from queued status', async () => {
    const response = await app.fetch(new Request('http://localhost/test/status-no-content-fast', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('x-stamp')).toBe('seen');
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });

  test('single raw middleware fast path can finalize no-content without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'DELETE',
        fullPath: '/test/raw-middleware-no-content',
        controller: TestController,
        methodName: 'defaultNoContent',
        parameters: [],
        guards: [],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          responses: [{ status: 204, description: 'Deleted' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-middleware-no-content', {
      method: 'DELETE',
      headers: { 'x-request-id': 'raw-queued-1' },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('x-request-id')).toBe('raw-queued-1');
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });

  test('multiple raw middleware can complete without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawQueuedHeaderMiddleware, RawTraceMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'DELETE',
        fullPath: '/test/raw-middleware-chain',
        controller: TestController,
        methodName: 'defaultNoContent',
        parameters: [],
        guards: [],
        middleware: [RawQueuedHeaderMiddleware, RawTraceMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          responses: [{ status: 204, description: 'Deleted' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-middleware-chain', {
      method: 'DELETE',
      headers: { 'x-request-id': 'raw-chain-1' },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('x-request-id')).toBe('raw-chain-1');
    expect(response.headers.get('x-raw-trace')).toBe('trace-1');
    expect(await response.text()).toBe('');
  });

  test('single raw guard and middleware can complete without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawHeaderGuard, RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'DELETE',
        fullPath: '/test/raw-guard-middleware-no-content',
        controller: TestController,
        methodName: 'defaultNoContent',
        parameters: [],
        guards: [RawHeaderGuard],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          responses: [{ status: 204, description: 'Deleted' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-guard-middleware-no-content', {
      method: 'DELETE',
      headers: {
        'x-raw-auth': 'ok',
        'x-request-id': 'raw-guard-ok-1',
      },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('x-request-id')).toBe('raw-guard-ok-1');
    expect(await response.text()).toBe('');
  });

  test('single raw guard and middleware can complete body routes without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawHeaderGuard, RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-guard-middleware-body',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [RawHeaderGuard],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 200, description: 'Echo response', schema: EchoSchema }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-guard-middleware-body', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-raw-auth': 'ok',
        'x-request-id': 'raw-guard-body-1',
      },
      body: JSON.stringify({ name: 'raw-body' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('raw-guard-body-1');
    expect(await response.json()).toEqual({ name: 'raw-body' });
  });

  test('async raw guard and useRaw middleware can complete body routes without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [AsyncRawHeaderGuard, RawQueuedHeaderUseMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-async-guard-use-body',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [AsyncRawHeaderGuard],
        middleware: [RawQueuedHeaderUseMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 200, description: 'Echo response', schema: EchoSchema }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-async-guard-use-body', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-raw-auth': 'ok',
        'x-request-id': 'raw-async-use-1',
      },
      body: JSON.stringify({ name: 'raw-body' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('raw-async-use-1');
    expect(await response.json()).toEqual({ name: 'raw-body' });
  });

  test('mixed raw handleRaw and useRaw middleware can complete no-input routes through the generic raw pipeline', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [AsyncRawHeaderGuard, RawQueuedHeaderMiddleware, RawTraceUseMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'DELETE',
        fullPath: '/test/raw-async-guard-mixed-middleware-no-input',
        controller: TestController,
        methodName: 'defaultNoContent',
        parameters: [],
        guards: [AsyncRawHeaderGuard],
        middleware: [RawQueuedHeaderMiddleware, RawTraceUseMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          responses: [{ status: 204, description: 'Deleted' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-async-guard-mixed-middleware-no-input', {
      method: 'DELETE',
      headers: {
        'x-raw-auth': 'ok',
        'x-request-id': 'raw-mixed-use-1',
      },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('x-request-id')).toBe('raw-mixed-use-1');
    expect(response.headers.get('x-raw-trace')).toBe('trace-use');
    expect(await response.text()).toBe('');
  });

  test('multiple raw middleware can complete body routes through the generic raw pipeline', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawQueuedHeaderMiddleware, RawTraceUseMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-middleware-mixed-body',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [],
        middleware: [RawQueuedHeaderMiddleware, RawTraceUseMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 200, description: 'Echo response', schema: EchoSchema }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-middleware-mixed-body', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'raw-multi-body-1',
      },
      body: JSON.stringify({ name: 'raw-body' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('raw-multi-body-1');
    expect(response.headers.get('x-raw-trace')).toBe('trace-use');
    expect(await response.json()).toEqual({ name: 'raw-body' });
  });

  test('single raw guard and middleware can short-circuit body routes before JSON parsing without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawHeaderGuard, RawStopMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-guard-stop-body',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [RawHeaderGuard],
        middleware: [RawStopMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 200, description: 'Echo response', schema: EchoSchema }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-guard-stop-body', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-raw-auth': 'ok',
      },
      body: '{',
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ stopped: true });
  });

  test('single raw middleware can complete body routes without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-middleware-body',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 200, description: 'Echo response', schema: EchoSchema }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-middleware-body', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'raw-body-1',
      },
      body: JSON.stringify({ name: 'raw-body' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('raw-body-1');
    expect(await response.json()).toEqual({ name: 'raw-body' });
  });

  test('single raw middleware preserves queued headers on body validation errors without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-middleware-invalid-body',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 200, description: 'Echo response', schema: EchoSchema }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-middleware-invalid-body', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'raw-invalid-1',
      },
      body: JSON.stringify({ nope: true }),
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toBe('raw-invalid-1');
    expect(await response.json()).toMatchObject({ message: 'body validation failed' });
  });

  test('single raw middleware can apply default created status on body routes without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-middleware-created-body',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 201, description: 'Created' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-middleware-created-body', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'raw-created-1',
      },
      body: JSON.stringify({ name: 'raw-created' }),
    }));

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('raw-created-1');
    expect(await response.json()).toEqual({ name: 'raw-created' });
  });

  test('single raw guard and middleware can apply default created status on body routes without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawHeaderGuard, RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-guard-middleware-created-body',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [RawHeaderGuard],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 201, description: 'Created' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-guard-middleware-created-body', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-raw-auth': 'ok',
        'x-request-id': 'raw-guard-created-1',
      },
      body: JSON.stringify({ name: 'raw-guard-created' }),
    }));

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('raw-guard-created-1');
    expect(await response.json()).toEqual({ name: 'raw-guard-created' });
  });

  test('single raw guard and middleware preserve queued headers on body validation errors without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawHeaderGuard, RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-guard-middleware-invalid-body',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [RawHeaderGuard],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 200, description: 'Echo response', schema: EchoSchema }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-guard-middleware-invalid-body', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-raw-auth': 'ok',
        'x-request-id': 'raw-guard-invalid-1',
      },
      body: JSON.stringify({ nope: true }),
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get('x-request-id')).toBe('raw-guard-invalid-1');
    expect(await response.json()).toMatchObject({ message: 'body validation failed' });
  });

  test('single raw guard and middleware can complete path-and-body routes without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawHeaderGuard, RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'PATCH',
        fullPath: '/test/raw-guard-middleware-path-body/:id',
        controller: TestController,
        methodName: 'rawUpdate',
        parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
        guards: [RawHeaderGuard],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          paramSchema: IdParamSchema,
          responses: [{ status: 200, description: 'Updated' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-guard-middleware-path-body/42', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-raw-auth': 'ok',
        'x-request-id': 'raw-guard-path-body-1',
      },
      body: JSON.stringify({ name: 'patched' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('raw-guard-path-body-1');
    expect(await response.json()).toEqual({ id: '42', name: 'patched' });
  });

  test('raw middleware errors preserve queued headers without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawFailureMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'GET',
        fullPath: '/test/raw-middleware-error',
        controller: TestController,
        methodName: 'defaultCreated',
        parameters: [],
        guards: [],
        middleware: [RawFailureMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          responses: [{ status: 201, description: 'Created' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-middleware-error'));

    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBe('raw-error');
    expect(await response.json()).toEqual({ message: 'Internal Server Error' });
  });

  test('route response metadata can default json success status without explicit context mutation', async () => {
    const response = await app.fetch(new Request('http://localhost/test/default-created', {
      method: 'POST',
    }));

    expect(response.status).toBe(201);
    expect(response.headers.get('x-stamp')).toBe('seen');
    expect(await response.json()).toEqual({ ok: true, stamp: 'default-created' });
  });

  test('route response metadata preserves queued headers on default created context responses', async () => {
    const response = await app.fetch(new Request('http://localhost/test/queued/default-created', {
      method: 'POST',
      headers: { 'x-request-id': 'queued-default-created-1' },
    }));

    expect(response.status).toBe(201);
    expect(response.headers.get('x-request-id')).toBe('queued-default-created-1');
    expect(response.headers.get('x-stamp')).toBe('seen');
    expect(await response.json()).toEqual({ ok: true, stamp: 'default-created' });
  });

  test('route response metadata can default to no-content without explicit context mutation', async () => {
    const response = await app.fetch(new Request('http://localhost/test/default-no-content', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('x-stamp')).toBe('seen');
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });

  test('queued response headers are applied to unhandled error responses', async () => {
    const response = await app.fetch(new Request('http://localhost/test/queued/unhandled', {
      headers: { 'x-request-id': 'queued-err-2' },
    }));

    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBe('queued-err-2');
    expect(await response.json()).toEqual({ message: 'Internal Server Error' });
  });

  test('exact static routes preserve trailing-slash, HEAD, and OPTIONS behavior', async () => {
    const getResponse = await app.fetch(new Request('http://localhost/test/static/'));
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({ ok: true });

    const headResponse = await app.fetch(new Request('http://localhost/test/static', {
      method: 'HEAD',
    }));
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await headResponse.text()).toBe('');

    const optionsResponse = await app.fetch(new Request('http://localhost/test/static', {
      method: 'OPTIONS',
    }));
    expect(optionsResponse.status).toBe(204);
    expect(optionsResponse.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });

  test('exception filter handles controller errors', async () => {
    const response = await app.fetch(new Request('http://localhost/test/boom'));
    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({ message: 'handled' });
  });


  test('single raw middleware can complete path-and-body routes without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'PATCH',
        fullPath: '/test/raw-middleware-path-body/:id',
        controller: TestController,
        methodName: 'rawUpdate',
        parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
        guards: [],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          paramSchema: IdParamSchema,
          responses: [{ status: 200, description: 'Updated' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-middleware-path-body/42', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'raw-middleware-path-body-1',
      },
      body: JSON.stringify({ name: 'patched' }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('raw-middleware-path-body-1');
    expect(await response.json()).toEqual({ id: '42', name: 'patched' });
  });

  test('single raw middleware can complete query routes without constructing RequestContext', async () => {
    const rawApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [RawQueuedHeaderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'GET',
        fullPath: '/test/raw-middleware-query',
        controller: TestController,
        methodName: 'search',
        parameters: [{ index: 0, source: 'query', name: 'search' }],
        guards: [],
        middleware: [RawQueuedHeaderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          querySchema: SearchQuerySchema,
          responses: [{ status: 200, description: 'Search result' }],
        },
      }],
    });

    const response = await rawApp.fetch(new Request('http://localhost/test/raw-middleware-query?search=Ada%20Lovelace', {
      headers: {
        'x-request-id': 'raw-middleware-query-1',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('raw-middleware-query-1');
    expect(await response.json()).toEqual({ search: 'Ada Lovelace' });
  });
  test('middleware can short-circuit before the controller executes', async () => {
    const response = await app.fetch(new Request('http://localhost/test/stop'));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ stopped: true });
  });

  test('middleware can short-circuit body routes before JSON parsing', async () => {
    const stopBodyApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [StopMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/stop-body',
        controller: TestController,
        methodName: 'echo',
        parameters: [{ index: 0, source: 'body' }],
        guards: [],
        middleware: [StopMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 200, description: 'Echo response', schema: EchoSchema }],
        },
      }],
    });

    const response = await stopBodyApp.fetch(new Request('http://localhost/test/stop-body', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ stopped: true });
  });

  test('filters are applied from the last declared filter backward', async () => {
    const orderedApp = createApp(appDefinition, {
      routes: [{
        method: 'GET',
        fullPath: '/test/filter-order',
        controller: TestController,
        methodName: 'boom',
        parameters: [],
        guards: [],
        middleware: [],
        filters: [OuterBoomFilter, InnerBoomFilter],
        docs: {
          tags: ['test'],
          security: [],
          responses: [],
        },
      }],
    });

    const response = await orderedApp.fetch(new Request('http://localhost/test/filter-order'));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ message: 'inner' });
  });

  test('global and route middleware compose in nested order', async () => {
    const orderedApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [GlobalOrderMiddleware, RouteOrderMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [GlobalOrderMiddleware],
        filters: [],
      },
    }), {
      routes: [{
        method: 'GET',
        fullPath: '/test/middleware-order',
        controller: TestController,
        methodName: 'middlewareOrder',
        parameters: [{ index: 0, source: 'context' }],
        guards: [],
        middleware: [RouteOrderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          responses: [],
        },
      }],
    });

    const response = await orderedApp.fetch(new Request('http://localhost/test/middleware-order'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-order')).toBe('global:before>route:before>route:after>global:after');
    expect(await response.json()).toEqual({ order: ['global:before', 'route:before'] });
  });

  test('multiple global and route middleware preserve nested before/after order', async () => {
    const orderedApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [
          GlobalOuterOrderMiddleware,
          GlobalInnerOrderMiddleware,
          RouteOuterOrderMiddleware,
          RouteInnerOrderMiddleware,
        ],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [GlobalOuterOrderMiddleware, GlobalInnerOrderMiddleware],
        filters: [],
      },
    }), {
      routes: [{
        method: 'GET',
        fullPath: '/test/middleware-order-deep',
        controller: TestController,
        methodName: 'middlewareOrder',
        parameters: [{ index: 0, source: 'context' }],
        guards: [],
        middleware: [RouteOuterOrderMiddleware, RouteInnerOrderMiddleware],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          responses: [],
        },
      }],
    });

    const response = await orderedApp.fetch(new Request('http://localhost/test/middleware-order-deep'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-order')).toBe(
      'global-outer:before>global-inner:before>route-outer:before>route-inner:before>route-inner:after>route-outer:after>global-inner:after>global-outer:after',
    );
    expect(await response.json()).toEqual({
      order: ['global-outer:before', 'global-inner:before', 'route-outer:before', 'route-inner:before'],
    });
  });

  test('route filters take precedence over global fallback filters', async () => {
    const orderedApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [GlobalFallbackFilter, InnerBoomFilter],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [GlobalFallbackFilter],
      },
    }), {
      routes: [{
        method: 'GET',
        fullPath: '/test/global-filter-order',
        controller: TestController,
        methodName: 'boom',
        parameters: [],
        guards: [],
        middleware: [],
        filters: [InnerBoomFilter],
        docs: {
          tags: ['test'],
          security: [],
          responses: [],
        },
      }],
    });

    const response = await orderedApp.fetch(new Request('http://localhost/test/global-filter-order'));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ message: 'inner' });
  });

  test('multiple route and global filters run in reverse declaration order with route filters first', async () => {
    const orderedApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [
          RouteInnerPassFilter,
          RouteOuterPassFilter,
          GlobalInnerPassFilter,
          GlobalOuterHandleFilter,
        ],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [GlobalOuterHandleFilter, GlobalInnerPassFilter],
      },
    }), {
      routes: [{
        method: 'GET',
        fullPath: '/test/global-route-filter-stack',
        controller: TestController,
        methodName: 'boom',
        parameters: [],
        guards: [],
        middleware: [],
        filters: [RouteOuterPassFilter, RouteInnerPassFilter],
        docs: {
          tags: ['test'],
          security: [],
          responses: [],
        },
      }],
    });

    const response = await orderedApp.fetch(new Request('http://localhost/test/global-route-filter-stack'));
    expect(response.status).toBe(453);
    expect(await response.json()).toEqual({
      order: ['route-inner:pass', 'route-outer:pass', 'global-inner:pass', 'global-outer:handle'],
    });
  });

  test('secure headers middleware adds defaults without overriding explicit headers', async () => {
    const securedApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [SecureHeadersMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [SecureHeadersMiddleware],
        filters: [],
      },
    }), {
      routes: [{
        method: 'GET',
        fullPath: '/test/security-headers',
        controller: TestController,
        methodName: 'customSecurityHeaders',
        parameters: [{ index: 0, source: 'context' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          responses: [],
        },
      }],
    });

    const response = await securedApp.fetch(new Request('http://localhost/test/security-headers'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(await response.text()).toBe('secured');
  });

  test('configured secure headers middleware can add CSP and override default policies', async () => {
    const AppSecureHeadersMiddleware = createSecureHeadersMiddleware({
      contentSecurityPolicy: "default-src 'self'",
      frameOptions: 'SAMEORIGIN',
      referrerPolicy: null,
    });

    const securedApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [AppSecureHeadersMiddleware],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [AppSecureHeadersMiddleware],
        filters: [],
      },
    }), {
      routes: [{
        method: 'GET',
        fullPath: '/test/security-headers-configured',
        controller: TestController,
        methodName: 'contextHealth',
        parameters: [{ index: 0, source: 'context' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          responses: [],
        },
      }],
    });

    const response = await securedApp.fetch(new Request('http://localhost/test/security-headers-configured'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(response.headers.get('referrer-policy')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('body validation rejects invalid payloads', async () => {
    const response = await app.fetch(new Request('http://localhost/test/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wrong: true }),
    }));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.message).toBe('body validation failed');
  });

  test('body parameters are populated even without a body schema', async () => {
    const response = await app.fetch(new Request('http://localhost/test/raw-echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'raw' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'raw' });
  });

  test('body-only create routes can use the specialized plain executor without context', async () => {
    const bodyOnlyApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/plain-create',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 201, description: 'Created' }],
        },
      }],
    });

    const response = await bodyOnlyApp.fetch(new Request('http://localhost/test/plain-create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'plain-create' }),
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ name: 'plain-create' });
  });

  test('body-only create routes preserve validation failures on the specialized plain executor', async () => {
    const bodyOnlyApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: createValibotAdapter(),
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/plain-create-invalid',
        controller: TestController,
        methodName: 'rawEcho',
        parameters: [{ index: 0, source: 'body' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: EchoSchema,
          responses: [{ status: 201, description: 'Created' }],
        },
      }],
    });

    const response = await bodyOnlyApp.fetch(new Request('http://localhost/test/plain-create-invalid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'body validation failed' });
  });

  test('body parsing is reused when the context reads the parsed body later', async () => {
    const response = await app.fetch(new Request('http://localhost/test/raw-echo-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cached' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sameReference: true, value: 'cached' });
  });

  test('schema-transformed body payload is handed off to context body cache', async () => {
    const transformedBodySchema = Symbol('transformed-body-schema');
    const transformApp = createApp(defineApplication({
      modules: [defineModule({
        providers: [],
        controllers: [TestController],
        imports: [],
      })],
      schemaAdapter: {
        name: 'transform-test',
        parse(schema, input) {
          if (schema !== transformedBodySchema) {
            return { success: true, output: input };
          }

          const body = input as { name?: string };
          return {
            success: true,
            output: {
              name: body.name?.trim().toUpperCase() ?? '',
            },
          };
        },
        toOpenApiSchema() {
          return {};
        },
      },
      globals: {
        guards: [],
        middleware: [],
        filters: [],
      },
    }), {
      routes: [{
        method: 'POST',
        fullPath: '/test/raw-echo-context-transformed',
        controller: TestController,
        methodName: 'rawEchoWithContext',
        parameters: [{ index: 0, source: 'context' }, { index: 1, source: 'body' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: {
          tags: ['test'],
          security: [],
          bodySchema: transformedBodySchema,
          responses: [],
        },
      }],
    });

    const response = await transformApp.fetch(new Request('http://localhost/test/raw-echo-context-transformed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  cached  ' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sameReference: true, value: 'CACHED' });
  });

  test('raw guards can authorize without constructing the legacy context path', async () => {
    const response = await app.fetch(new Request('http://localhost/test/raw-guard', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-raw-auth': 'ok',
      },
      body: JSON.stringify({ name: 'raw-guard' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'raw-guard' });
  });

  test('query validation rejects invalid search params', async () => {
    const response = await app.fetch(new Request('http://localhost/test/search?search=a'));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.message).toBe('query validation failed');
    expect(Array.isArray(payload.issues)).toBe(true);
  });

  test('query schema with only optional fields accepts a request without a query string', async () => {
    const response = await app.fetch(new Request('http://localhost/test/optional-search'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ search: null });
  });

  test('named query parameters are decoded without requiring a query schema object', async () => {
    const response = await app.fetch(new Request('http://localhost/test/search?search=Ada%20Lovelace'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ search: 'Ada Lovelace' });
  });

  test('RequestContext query helper decodes plus-separated values', async () => {
    const response = await app.fetch(new Request('http://localhost/test/search-context?search=Ada+Lovelace'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ search: 'Ada Lovelace' });
  });

  test('path validation rejects invalid route params', async () => {
    const response = await app.fetch(new Request('http://localhost/test/items/not-a-number'));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.message).toBe('params validation failed');
    expect(Array.isArray(payload.issues)).toBe(true);
  });

  test('path parameters are decoded only when needed', async () => {
    const response = await app.fetch(new Request('http://localhost/test/raw-items/Ada%20Lovelace'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'Ada Lovelace' });
  });

  test('explicit HEAD routes take precedence over GET fallback', async () => {
    const response = await app.fetch(new Request('http://localhost/test/secure', {
      method: 'HEAD',
      headers: { 'x-auth': 'ok' },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('x-head-handler')).toBe('yes');
    expect(await response.text()).toBe('');
  });

  test('HEAD requests fall back to GET handlers when no HEAD route exists', async () => {
    const response = await app.fetch(new Request('http://localhost/test/search?search=ok', {
      method: 'HEAD',
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.text()).toBe('');
  });

  test('OPTIONS requests return allowed methods for a matched path', async () => {
    const response = await app.fetch(new Request('http://localhost/test/secure', {
      method: 'OPTIONS',
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-options-handler')).toBe('yes');
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(await response.text()).toBe('explicit options');
  });

  test('unsupported methods return 405 with Allow header', async () => {
    const response = await app.fetch(new Request('http://localhost/test/echo', {
      method: 'PUT',
    }));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, OPTIONS');
    expect(await response.json()).toEqual({ message: 'Method Not Allowed' });
  });

  test('HttpError responses are serialized consistently', async () => {
    const response = await app.fetch(new Request('http://localhost/test/conflict'));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: 'email conflict' });
  });

  test('rate-limit and service availability helpers preserve retry headers', async () => {
    const rateLimitedResponse = await app.fetch(new Request('http://localhost/test/rate-limited'));
    expect(rateLimitedResponse.status).toBe(429);
    expect(rateLimitedResponse.headers.get('retry-after')).toBe('60');
    expect(await rateLimitedResponse.json()).toEqual({ message: 'slow down' });

    const unavailableResponse = await app.fetch(new Request('http://localhost/test/unavailable'));
    expect(unavailableResponse.status).toBe(503);
    expect(unavailableResponse.headers.get('retry-after')).toBe('120');
    expect(await unavailableResponse.json()).toEqual({ message: 'maintenance window' });
  });

  test('cache helpers support precondition failures and bodyless not-modified responses', async () => {
    const preconditionResponse = await app.fetch(new Request('http://localhost/test/precondition'));
    expect(preconditionResponse.status).toBe(412);
    expect(preconditionResponse.headers.get('etag')).toBe('"next-version"');
    expect(await preconditionResponse.json()).toEqual({ message: 'etag mismatch' });

    const notModifiedResponse = await app.fetch(new Request('http://localhost/test/not-modified'));
    expect(notModifiedResponse.status).toBe(304);
    expect(notModifiedResponse.headers.get('etag')).toBe('"current-version"');
    expect(notModifiedResponse.headers.get('content-type')).toBeNull();
    expect(await notModifiedResponse.text()).toBe('');
  });

  test('request-scoped providers are shared within a request and isolated across requests', async () => {
    requestTraceInstances = 0;

    const firstResponse = await app.fetch(new Request('http://localhost/test/request-trace', {
      headers: { 'x-request-id': 'req-1' },
    }));
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({
      instance: 1,
      requestId: 'req-1',
      sameReference: true,
    });

    const secondResponse = await app.fetch(new Request('http://localhost/test/request-trace', {
      headers: { 'x-request-id': 'req-2' },
    }));
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({
      instance: 2,
      requestId: 'req-2',
      sameReference: true,
    });
  });

  test('request-scoped guards, middleware, and controllers resolve per request', async () => {
    requestTraceInstances = 0;

    const firstResponse = await app.fetch(new Request('http://localhost/test/request-scoped-stack', {
      headers: {
        'x-request-id': 'req-stack-1',
        'x-allow-request-id': 'req-stack-1',
      },
    }));
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('x-request-middleware-instance')).toBe('1');
    expect(await firstResponse.json()).toEqual({
      controllerInstance: 1,
      guardInstance: 1,
      middlewareInstance: 1,
      requestId: 'req-stack-1',
    });

    const secondResponse = await app.fetch(new Request('http://localhost/test/request-scoped-stack', {
      headers: {
        'x-request-id': 'req-stack-2',
        'x-allow-request-id': 'req-stack-2',
      },
    }));
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.headers.get('x-request-middleware-instance')).toBe('2');
    expect(await secondResponse.json()).toEqual({
      controllerInstance: 2,
      guardInstance: 2,
      middlewareInstance: 2,
      requestId: 'req-stack-2',
    });
  });

  test('request-scoped filters resolve per request', async () => {
    requestTraceInstances = 0;

    const firstResponse = await app.fetch(new Request('http://localhost/test/request-scoped-boom', {
      headers: { 'x-request-id': 'req-filter-1' },
    }));
    expect(firstResponse.status).toBe(419);
    expect(await firstResponse.json()).toEqual({
      filterInstance: 1,
      requestId: 'req-filter-1',
    });

    const secondResponse = await app.fetch(new Request('http://localhost/test/request-scoped-boom', {
      headers: { 'x-request-id': 'req-filter-2' },
    }));
    expect(secondResponse.status).toBe(419);
    expect(await secondResponse.json()).toEqual({
      filterInstance: 2,
      requestId: 'req-filter-2',
    });
  });

  test('request-scoped filters are not instantiated on successful requests', async () => {
    requestTraceInstances = 0;

    const response = await app.fetch(new Request('http://localhost/test/request-scoped-filter-pass', {
      headers: { 'x-request-id': 'req-filter-pass-1' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(requestTraceInstances).toBe(0);
  });

  test('noContent helper returns a 204 response without a body', async () => {
    const response = await app.fetch(new Request('http://localhost/test/items/1', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('');
  });

  test('unmatched paths return 404 with valid JSON response', async () => {
    const response = await app.fetch(new Request('http://localhost/unknown/path'));

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ message: 'Not Found' });
  });

  test('malformed JSON body returns 500 because JSON parse fails before validation', async () => {
    const response = await app.fetch(new Request('http://localhost/test/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid json',
    }));

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const payload = await response.json();
    expect(payload.message).toBe('Internal Server Error');
  });

  test('405 Method Not Allowed on dynamic routes includes allowed methods', async () => {
    const response = await app.fetch(new Request('http://localhost/test/items/123', {
      method: 'PUT',
    }));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, DELETE, OPTIONS');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ message: 'Method Not Allowed' });
  });

  test('HEAD request falls back to GET handler on dynamic routes', async () => {
    const response = await app.fetch(new Request('http://localhost/test/items/42', {
      method: 'HEAD',
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.text()).toBe('');
  });
});
