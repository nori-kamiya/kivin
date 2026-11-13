// Guard, middleware and exception-filter compilation and execution.
import type { Container } from '../container';
import { RequestContext, ResponseState } from '../context';
import { HttpError } from '../http';
import type { Token } from '../types';
import { mapUnknownToResponse } from './results';
import type { CompiledDependencyList, ManifestRoute, NextResponseFactory, RawExecutionState, RawGuardInvoker, RawGuardSyncInvoker, RawMiddlewareInvoker, RawResponseExecutionState, ResponseStateAdapter, RouteFilters, RouteGuards, RouteMiddleware, ScopedResolver } from './types';
import { isPromiseLike, rethrowJsonBodyError } from './utils';

export function createScopedResolver<T>(input: {
  container: Container;
  token: Token;
  validate: (instance: T, token: Token) => void;
}): ScopedResolver<T> {
  const scope = input.container.getProviderScope(input.token) ?? 'singleton';

  if (scope === 'request') {
    return {
      requestScoped: true,
      resolve: (requestContainer) => {
        if (!requestContainer) {
          throw new Error(`Request-scoped provider ${describeToken(input.token)} requires a request container`);
        }

        const instance = requestContainer.resolve(input.token as Token<T>);
        input.validate(instance, input.token);
        return instance;
      },
    };
  }

  const instance = input.container.resolve(input.token as Token<T>);
  input.validate(instance, input.token);

  return {
    requestScoped: false,
    resolve: () => instance,
  };
}

export function compileDependencyList<T>(resolvers: ScopedResolver<T>[]): CompiledDependencyList<T> {
  const requestScoped = resolvers.some((resolver) => resolver.requestScoped);
  const singletonInstances = requestScoped
    ? []
    : resolvers.map((resolver) => resolver.resolve());

  return {
    requestScoped,
    singletonInstances,
    entries: requestScoped
      ? resolvers.map((resolver) => resolver.requestScoped
          ? { requestScoped: true as const, resolve: (requestContainer: Container) => resolver.resolve(requestContainer) }
          : { requestScoped: false as const, instance: resolver.resolve() })
      : singletonInstances.map((instance) => ({ requestScoped: false as const, instance })),
  };
}

export function resolveCompiledDependencies<T>(compiled: CompiledDependencyList<T>, requestContainer?: Container): T[] {
  if (!compiled.requestScoped) {
    return compiled.singletonInstances;
  }

  return compiled.entries.map((entry) => entry.requestScoped ? entry.resolve(requestContainer as Container) : entry.instance);
}

export function compileGuards(container: Container, tokens: Token[]): CompiledDependencyList<RouteGuards[number]> {
  return compileDependencyList(tokens.map((token) => createScopedResolver<RouteGuards[number]>({
    container,
    token,
    validate: (guard, guardToken) => {
      if (typeof guard?.canActivate !== 'function') {
        throw new Error(`Guard ${describeToken(guardToken)} must implement canActivate(context, route)`);
      }
    },
  })));
}

export function compileMiddleware(container: Container, tokens: Token[]): CompiledDependencyList<RouteMiddleware[number]> {
  return compileDependencyList(tokens.map((token) => createScopedResolver<RouteMiddleware[number]>({
    container,
    token,
    validate: (middleware, middlewareToken) => {
      if (typeof middleware?.handle !== 'function' && typeof middleware?.use !== 'function' && typeof middleware?.handleRaw !== 'function' && typeof middleware?.useRaw !== 'function') {
        throw new Error(`Middleware ${describeToken(middlewareToken)} must implement handle/use or handleRaw/useRaw`);
      }
    },
  })));
}

export function compileFilters(container: Container, tokens: Token[]): CompiledDependencyList<RouteFilters[number]> {
  return compileDependencyList(tokens.map((token) => createScopedResolver<RouteFilters[number]>({
    container,
    token,
    validate: (filter, filterToken) => {
      if (typeof filter?.catch !== 'function') {
        throw new Error(`Filter ${describeToken(filterToken)} must implement catch(error, context, route)`);
      }
    },
  })));
}

export async function enforceGuards(input: {
  getContext: () => RequestContext;
  guards: RouteGuards;
  params: Record<string, string>;
  request: Request;
  route: ManifestRoute<unknown>;
}) {
  const { getContext, guards, params, request, route } = input;

  for (const guard of guards) {
    const result = typeof guard.canActivateRaw === 'function'
      ? await guard.canActivateRaw(request, params, route)
      : await guard.canActivate(getContext(), route);

    if (!result) {
      throw new HttpError(403, 'Forbidden');
    }
  }
}

export async function runMiddlewareChain(input: {
  middleware: RouteMiddleware;
  context: RequestContext;
  defaultSuccessStatus: number | undefined;
  route: ManifestRoute<unknown>;
  execute: () => unknown;
}) {
  if (input.middleware.length === 1) {
    const current = input.middleware[0];
    if (!current) {
      return input.execute();
    }

    const next = () => {
      const result = input.execute();
      return isPromiseLike<unknown>(result)
        ? result.then((resolved) => mapUnknownToResponse(resolved, input.context, input.defaultSuccessStatus))
        : mapUnknownToResponse(result, input.context, input.defaultSuccessStatus);
    };
    if (typeof current.handle === 'function') {
      return current.handle(input.context, next, input.route);
    }

    return current.use!(input.context, next, input.route);
  }

  const dispatch = async (index: number): Promise<unknown> => {
    const current = input.middleware[index];
    if (!current) {
      return input.execute();
    }

    const next = () => {
      const result = dispatch(index + 1);
      return isPromiseLike<unknown>(result)
        ? result.then((resolved) => mapUnknownToResponse(resolved, input.context, input.defaultSuccessStatus))
        : mapUnknownToResponse(result, input.context, input.defaultSuccessStatus);
    };

    if (typeof current.handle === 'function') {
      return current.handle(input.context, next, input.route);
    }

    return current.use!(input.context, next, input.route);
  };

  return dispatch(0);
}

/**
 * Per-request state for the raw (context-free) executors. A class with prototype methods: the body
 * readers are only materialised (as bound functions) for routes that use the deferred loaders, so a
 * route allocates just this object and its `ResponseState`.
 */
class RawResponseExecution implements RawResponseExecutionState {
  protected responseState = new ResponseState();
  protected parsedBody: unknown;
  protected parsedBodyLoaded = false;
  private boundGetJsonBody: (() => Promise<unknown>) | undefined;
  private boundSetBodyPayload: ((value: unknown) => void) | undefined;

  constructor(protected readonly request: Request) {}

  applyQueuedState(response: Response) {
    return this.responseState.hasQueuedResponseState()
      ? this.responseState.applyResponseHeaders(response)
      : response;
  }

  getResponseState() {
    return this.responseState;
  }

  primeBody(value: unknown) {
    this.parsedBody = value;
    this.parsedBodyLoaded = true;
  }

  get getJsonBody() {
    return (this.boundGetJsonBody ??= () => this.loadJsonBody());
  }

  get setBodyPayload() {
    return (this.boundSetBodyPayload ??= (value: unknown) => this.primeBody(value));
  }

  // One promise reaction (no async frame): the body is parsed once and cached.
  private loadJsonBody(): Promise<unknown> {
    if (this.parsedBodyLoaded) {
      return Promise.resolve(this.parsedBody);
    }
    return this.request.json().then((value) => {
      this.primeBody(value);
      return value;
    }, rethrowJsonBodyError);
  }
}

/** Raw state for routes with exception filters: a `RequestContext` is created only when one runs. */
class RawExecution extends RawResponseExecution implements RawExecutionState {
  private context: RequestContext | undefined;
  private boundGetContext: (() => RequestContext) | undefined;

  constructor(
    request: Request,
    private readonly params: Record<string, string>,
    private readonly container: Container,
  ) {
    super(request);
  }

  get getContext() {
    return (this.boundGetContext ??= () => this.ensureContext());
  }

  override primeBody(value: unknown) {
    super.primeBody(value);
    this.context?.primeJsonBody(value);
  }

  private ensureContext() {
    if (!this.context) {
      const container = this.container;
      const context = new RequestContext(this.request, this.params, {
        resolve<T>(token: Token<T>) {
          return container.resolve(token);
        },
      });
      this.context = context;

      if (this.parsedBodyLoaded) {
        context.primeJsonBody(this.parsedBody);
      }

      // Headers queued by raw middleware move to the context, which finalises the response from now on.
      if (this.responseState.hasQueuedResponseState()) {
        this.responseState.copyResponseStateTo(context);
        this.responseState = new ResponseState();
      }
    }

    return this.context;
  }
}

export function createRawExecutionState(
  request: Request,
  params: Record<string, string>,
  container: Container,
): RawExecutionState {
  return new RawExecution(request, params, container);
}

export function createRawResponseExecutionState(request: Request): RawResponseExecutionState {
  return new RawResponseExecution(request);
}

export function createSingleRawGuardAllowChecker(
  invokeRawGuard: RawGuardInvoker | undefined,
  invokeRawGuardSync: RawGuardSyncInvoker | undefined,
) {
  if (!invokeRawGuard) {
    return undefined;
  }

  if (invokeRawGuardSync) {
    // "Sync" only means the method is not declared `async`: a plain function can still return a
    // promise (`canActivateRaw(req) { return this.auth.check(req); }`). A promise is truthy, so it
    // must be awaited, never treated as an allow.
    return (request: Request, params: Record<string, string>) => {
      const allowed = invokeRawGuardSync(request, params) as boolean | PromiseLike<boolean>;
      if (allowed === true) {
        return undefined;
      }
      if (isPromiseLike<boolean>(allowed)) {
        return Promise.resolve(allowed).then((resolved) => {
          if (!resolved) {
            throw new HttpError(403, 'Forbidden');
          }
        });
      }
      if (!allowed) {
        throw new HttpError(403, 'Forbidden');
      }
      return undefined;
    };
  }

  return async (request: Request, params: Record<string, string>) => {
    if (!(await invokeRawGuard(request, params))) {
      throw new HttpError(403, 'Forbidden');
    }
  };
}

export function createResolvedRawMiddlewareInvoker(invokeRawMiddleware: RawMiddlewareInvoker | undefined) {
  if (!invokeRawMiddleware) {
    return undefined;
  }

  // Not async: a middleware that answers synchronously (or returns next()'s promise) adds no extra tick.
  return (
    request: Request,
    params: Record<string, string>,
    responseState: ResponseState,
    next: NextResponseFactory,
  ): Response | Promise<Response> => {
    const result = invokeRawMiddleware(request, params, responseState, next);
    return isPromiseLike<Response>(result) ? Promise.resolve(result) : result;
  };
}

export function createRawGuardsAllowChecker(
  singleRawGuardAllowChecker: ((request: Request, params: Record<string, string>) => void | Promise<void>) | undefined,
  guards: RouteGuards,
  route: ManifestRoute<unknown>,
) {
  if (singleRawGuardAllowChecker) {
    return singleRawGuardAllowChecker;
  }

  if (guards.length === 0) {
    return undefined;
  }

  return async (request: Request, params: Record<string, string>) => {
    for (const guard of guards) {
      const allowed = guard.canActivateRaw!(request, params, route);
      if (isPromiseLike<boolean>(allowed) ? !(await allowed) : !allowed) {
        throw new HttpError(403, 'Forbidden');
      }
    }
  };
}

export function createRawMiddlewareDispatcher(
  singleRawMiddlewareInvoker: ((request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => Response | Promise<Response>) | undefined,
  middleware: RouteMiddleware,
  route: ManifestRoute<unknown>,
) {
  if (singleRawMiddlewareInvoker) {
    return singleRawMiddlewareInvoker;
  }

  if (middleware.length === 0) {
    // No middleware between the executor and the handler: the executor awaits `next()`'s result itself.
    return (_request: Request, _params: Record<string, string>, _responseState: ResponseState, next: NextResponseFactory) => next();
  }

  // No async frames: a raw middleware's `next()` may return a synchronous `Response` (the raw
  // contract), so a chain of middleware that only pass through stays synchronous end to end and the
  // route reaches Bun as a resolved promise instead of a pending one (#65).
  return (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => {
    const dispatch = (index: number): Response | PromiseLike<Response> => {
      const current = middleware[index];
      if (!current) {
        return next();
      }

      const invokeNext = () => dispatch(index + 1);

      if (typeof current.handleRaw === 'function') {
        return current.handleRaw(request, params, responseState, invokeNext, route);
      }

      return current.useRaw!(request, params, responseState, invokeNext, route);
    };

    return dispatch(0);
  };
}

export function resolveRawMiddlewareResult(
  result: unknown,
  state: RawExecutionState | RawResponseExecutionState,
  finalize: (value: unknown, context: ResponseStateAdapter) => Response,
) {
  if (result instanceof Response) {
    return state.applyQueuedState(result);
  }

  return finalize(result, state.getResponseState());
}

export async function applyFilters(
  filters: RouteFilters,
  error: unknown,
  context: RequestContext,
  route: ManifestRoute<unknown>,
) {
  for (const filter of [...filters].reverse()) {
    const response = await filter.catch(error, context, route);
    if (response) {
      return response;
    }
  }

  return undefined;
}

export function describeToken(token: Token) {
  return typeof token === 'function' ? token.name : String(token);
}
