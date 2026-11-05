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

export function createRawExecutionState(
  request: Request,
  params: Record<string, string>,
  container: Container,
): RawExecutionState {
  let context: RequestContext | undefined;
  let parsedBody: unknown;
  let parsedBodyLoaded = false;
  let responseState = new ResponseState();

  const getContext = () => {
    if (!context) {
      context = new RequestContext(request, params, {
        resolve<T>(token: Token<T>) {
          return container.resolve(token);
        },
      });

      if (parsedBodyLoaded) {
        context.primeJsonBody(parsedBody);
      }

      if (responseState.hasQueuedResponseState()) {
        responseState.copyResponseStateTo(context);
        responseState = new ResponseState();
      }
    }

    return context;
  };

  const getJsonBody = async () => {
    if (!parsedBodyLoaded) {
      try {
        parsedBody = await request.json();
      } catch (error) {
        rethrowJsonBodyError(error);
      }
      parsedBodyLoaded = true;

      if (context) {
        context.primeJsonBody(parsedBody);
      }
    }

    return parsedBody;
  };

  const setBodyPayload = (value: unknown) => {
    parsedBody = value;
    parsedBodyLoaded = true;

    if (context) {
      context.primeJsonBody(value);
    }
  };

  return {
    applyQueuedState(response: Response) {
      return responseState.hasQueuedResponseState()
        ? responseState.applyResponseHeaders(response)
        : response;
    },
    getContext,
    getJsonBody,
    getResponseState: () => responseState,
    setBodyPayload,
  };
}

/**
 * Per-request state for the raw (context-free) executors. A class with prototype methods: the body
 * readers are only materialised (as bound functions) for routes that read a body, so a route without
 * one allocates just this object and its `ResponseState`.
 */
class RawResponseExecution implements RawResponseExecutionState {
  private readonly responseState = new ResponseState();
  private parsedBody: unknown;
  private parsedBodyLoaded = false;
  private boundGetJsonBody: (() => Promise<unknown>) | undefined;
  private boundSetBodyPayload: ((value: unknown) => void) | undefined;

  constructor(private readonly request: Request) {}

  applyQueuedState(response: Response) {
    return this.responseState.hasQueuedResponseState()
      ? this.responseState.applyResponseHeaders(response)
      : response;
  }

  getResponseState() {
    return this.responseState;
  }

  get getJsonBody() {
    return (this.boundGetJsonBody ??= async () => {
      if (!this.parsedBodyLoaded) {
        try {
          this.parsedBody = await this.request.json();
        } catch (error) {
          rethrowJsonBodyError(error);
        }
        this.parsedBodyLoaded = true;
      }

      return this.parsedBody;
    });
  }

  get setBodyPayload() {
    return (this.boundSetBodyPayload ??= (value: unknown) => {
      this.parsedBody = value;
      this.parsedBodyLoaded = true;
    });
  }
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
    return (request: Request, params: Record<string, string>) => {
      if (!invokeRawGuardSync(request, params)) {
        throw new HttpError(403, 'Forbidden');
      }
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
    return async (_request: Request, _params: Record<string, string>, _responseState: ResponseState, next: NextResponseFactory) => {
      const result = next();
      return isPromiseLike<Response>(result)
        ? await result
        : result;
    };
  }

  return async (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => {
    async function dispatch(index: number): Promise<Response> {
      const current = middleware[index];
      if (!current) {
        const result = next();
        return isPromiseLike<Response>(result)
          ? await result
          : result;
      }

      const invokeNext = () => dispatch(index + 1);

      if (typeof current.handleRaw === 'function') {
        return current.handleRaw(request, params, responseState, invokeNext, route);
      }

      return current.useRaw!(request, params, responseState, invokeNext, route);
    }

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
