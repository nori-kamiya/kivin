// Runtime half of ahead-of-time (AOT) route executors.
//
// `kivin generate` emits, for every route, a factory `aot: (rt) => execute` into the manifest. The
// generated code is a straight-line async function specialised on that route's parameters (direct
// method call, literal argument list, no per-request closures). Everything whose semantics must stay
// identical to the runtime-compiled executor (validation, guards, middleware, filters, response
// finalisation, error mapping) lives here in `AotRouteRuntime`, built from the same compiled pieces.
import { getRouteHeaders } from './headers';
import type { Container } from '../container';
import { RequestContext } from '../context';
import { HttpError } from '../http';
import type { ContainerLike } from '../metadata';
import { readNamedQueryParam } from '../request-url';
import type { Token } from '../types';
import { applyFilters, runMiddlewareChain } from './pipeline';
import { createUnhandledErrorResponse } from './results';
import type { CompiledRouteExecutor, ManifestRoute, ResponseStateAdapter, RouteFilters, RouteGuards, RouteMiddleware } from './types';
import { isPromiseLike, rethrowJsonBodyError } from './utils';

export interface AotRouteRuntime<TController = unknown> {
  /** Singleton controller instance (AOT executors are only bound when the route is all-singleton). */
  readonly controller: TController;
  readonly route: ManifestRoute<unknown>;
  readonly hasGuards: boolean;
  readonly hasMiddleware: boolean;
  createContext(request: Request, params: Record<string, string>): RequestContext;
  resolveParamPayload(params: Record<string, string>): unknown;
  resolveQueryPayload(requestUrl: string): unknown;
  readQueryParam(requestUrl: string, name: string): string | undefined;
  /** Headers the route-level header wrapper stored for this request (`{}` when unused). */
  headers(params: Record<string, string>): unknown;
  /** Reads and validates the JSON body; primes `context.jsonBody()` when a context exists. */
  readBody(request: Request, context: RequestContext | undefined): Promise<unknown>;
  /**
   * Runs guards (raw first, else with a context it creates on demand) and returns the context, if
   * any. Synchronous guards finish synchronously; a denial throws `HttpError(403)`.
   */
  runGuards(request: Request, params: Record<string, string>, context: RequestContext | undefined): RequestContext | undefined | Promise<RequestContext | undefined>;
  /** Runs the middleware chain around `execute` and returns the final response. */
  runMiddleware(context: RequestContext, execute: () => unknown): Response | Promise<Response>;
  /** Turns a handler result into a response (default status, response schema, queued headers). */
  finish(result: unknown, context: RequestContext | undefined): Response;
  handleError(error: unknown, context: RequestContext | undefined, request: Request, params: Record<string, string>): Response | Promise<Response>;
  isThenable(value: unknown): value is PromiseLike<unknown>;
}

export type AotExecutorFactory = (runtime: AotRouteRuntime<any>) => CompiledRouteExecutor<unknown> | undefined;

/** `KIVIN_AOT=0` disables generated executors (falls back to the runtime-compiled ones). */
export const aotEnabled = typeof process === 'undefined' || process.env.KIVIN_AOT !== '0';

/**
 * Resolver handed to `RequestContext`: singletons come from the root container, request-scoped
 * tokens from a request container created on first use (one small object per request).
 */
class LazyRequestResolver implements ContainerLike {
  private requestContainer: Container | undefined;
  context: RequestContext | undefined;

  constructor(private readonly root: Container) {}

  resolve<T>(token: Token<T>): T {
    if ((this.root.getProviderScope(token) ?? 'singleton') !== 'request') {
      return this.root.resolve(token);
    }
    if (!this.requestContainer) {
      this.requestContainer = this.root.createRequestContainer();
      if (this.context) {
        this.requestContainer.register({ provide: RequestContext, scope: 'request', useValue: this.context });
      }
    }
    return this.requestContainer.resolve(token);
  }
}

export function createAotRuntime(input: {
  container: Container;
  route: ManifestRoute<unknown>;
  controller: unknown;
  guards: RouteGuards;
  middleware: RouteMiddleware;
  filters: RouteFilters;
  defaultSuccessStatus: number | undefined;
  resolveParamPayload: (params: Record<string, string>) => unknown;
  resolveQueryPayload: (requestUrl: string) => unknown;
  /** `undefined` when the route reads no body (no body parameter / schema, or GET / HEAD). */
  validateBody: ((value: unknown) => unknown) | undefined;
  readsBody: boolean;
  finalizeContext: (result: unknown, context: ResponseStateAdapter) => Response;
  finalizePlain: (result: unknown) => Response;
}): AotRouteRuntime {
  const { container, route, guards, middleware, filters, finalizeContext, finalizePlain, validateBody, readsBody } = input;

  const createContext = (request: Request, params: Record<string, string>) => {
    const resolver = new LazyRequestResolver(container);
    const context = new RequestContext(request, params, resolver);
    resolver.context = context;
    return context;
  };

  const withQueuedHeaders = (response: Response, context: RequestContext | undefined) =>
    context && context.hasQueuedResponseState() ? context.applyResponseHeaders(response) : response;

  return {
    controller: input.controller,
    route,
    hasGuards: guards.length > 0,
    hasMiddleware: middleware.length > 0,
    createContext,
    resolveParamPayload: input.resolveParamPayload,
    resolveQueryPayload: input.resolveQueryPayload,
    readQueryParam: readNamedQueryParam,
    headers: getRouteHeaders,

    readBody(request, context) {
      if (!readsBody) {
        return Promise.resolve(undefined);
      }
      // One reaction (no async frame): parse, validate, prime the context.
      return request.json().then((raw: unknown) => {
        const value = validateBody ? validateBody(raw) : raw;
        context?.primeJsonBody(value);
        return value;
      }, rethrowJsonBodyError);
    },

    runGuards(request, params, context) {
      return runGuardsFrom(0, request, params, context);
    },

    runMiddleware(context, execute) {
      if (middleware.length === 1) {
        // Same contract as the runtime executor's single-middleware path: `next()` yields the
        // finalised handler response; a non-Response from the middleware is finalised afterwards.
        const current = middleware[0]!;
        // Always a promise, like the runtime executor's `async` next, but without an extra async frame.
        const next = () => {
          try {
            const result = execute();
            return isPromiseLike<unknown>(result)
              ? Promise.resolve(result).then((resolved) => finalizeContext(resolved, context))
              : Promise.resolve(finalizeContext(result, context));
          } catch (error) {
            return Promise.reject(error);
          }
        };
        const direct = typeof current.handle === 'function' ? current.handle(context, next, route) : current.use!(context, next, route);
        return isPromiseLike<unknown>(direct) ? Promise.resolve(direct).then((resolved) => afterMiddleware(resolved, context)) : afterMiddleware(direct, context);
      }

      return runMiddlewareChain({ middleware, context, defaultSuccessStatus: input.defaultSuccessStatus, route, execute }).then((result) => afterMiddleware(result, context));
    },

    finish(result, context) {
      if (result instanceof Response) {
        return withQueuedHeaders(result, context);
      }
      return context ? finalizeContext(result, context) : finalizePlain(result);
    },

    handleError(error, context, request, params) {
      if (filters.length > 0) {
        const current = context ?? createContext(request, params);
        return applyFilters(filters, error, current, route).then((filtered) => (filtered ? current.applyResponseHeaders(filtered) : mapError(error, current)));
      }
      return mapError(error, context);
    },

    isThenable: isPromiseLike as (value: unknown) => value is PromiseLike<unknown>,
  };

  function mapError(error: unknown, current: RequestContext | undefined): Response {
      if (error instanceof HttpError) {
        return withQueuedHeaders(error.toResponse(), current);
      }
      if (error instanceof Response) {
        return withQueuedHeaders(error, current);
      }
      return withQueuedHeaders(createUnhandledErrorResponse(error), current);
  }

  function afterMiddleware(result: unknown, context: RequestContext): Response {
    return result instanceof Response ? withQueuedHeaders(result, context) : finalizeContext(result, context);
  }

  // Stays synchronous while guards return plain booleans; switches to a promise at the first async one.
  function runGuardsFrom(start: number, request: Request, params: Record<string, string>, context: RequestContext | undefined): RequestContext | undefined | Promise<RequestContext | undefined> {
    let current = context;
    for (let index = start; index < guards.length; index += 1) {
      const guard = guards[index]!;
      const allowed = typeof guard.canActivateRaw === 'function'
        ? guard.canActivateRaw(request, params, route)
        : guard.canActivate((current ??= createContext(request, params)), route);
      if (isPromiseLike<boolean>(allowed)) {
        const resumeContext = current;
        return Promise.resolve(allowed).then((resolved) => {
          if (!resolved) {
            throw new HttpError(403, 'Forbidden');
          }
          return runGuardsFrom(index + 1, request, params, resumeContext);
        });
      }
      if (!allowed) {
        throw new HttpError(403, 'Forbidden');
      }
    }
    return current;
  }
}
