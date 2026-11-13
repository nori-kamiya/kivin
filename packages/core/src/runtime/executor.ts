// Selects and builds the specialised executor for each compiled route.
import type { Container } from '../container';
import { RequestContext, ResponseState } from '../context';
import { HttpError } from '../http';
import type { AppDefinition } from '../metadata';
import { readNamedQueryParam } from '../request-url';
import { createJsonResponseWithStatus, createNoContentResponse } from '../response';
import type { Token } from '../types';
import { aotEnabled, createAotRuntime } from './aot';
import { resolveBodyLimit, withBodyLimit } from './body-limit';
import { isFormMediaType, withFormBody } from './form-body';
import { routeUsesHeaders, withRouteHeaders } from './headers';
import { createArgumentResolver, createCompiledHandlerExecutor, createHandlerInvoker } from './arguments';
import { createBodyPayloadFromJsonLoaderResolver, createBodyPayloadLoaderFactory, createBodyPayloadResolver, createParamPayloadResolver, createQueryPayloadResolver, createSchemaValidator } from './payload';
import { applyFilters, compileFilters, compileGuards, compileMiddleware, createRawExecutionState, createRawGuardsAllowChecker, createRawMiddlewareDispatcher, createRawResponseExecutionState, createResolvedRawMiddlewareInvoker, createScopedResolver, createSingleRawGuardAllowChecker, describeToken, enforceGuards, resolveCompiledDependencies, resolveRawMiddlewareResult, runMiddlewareChain } from './pipeline';
import { createNativeStaticResponse, createResponseBodyMapper, createUnhandledErrorResponse, finalizeContextResult, finalizeDefaultCreatedContextResult, finalizeDefaultCreatedPlainResult, finalizeDefaultCreatedRawResult, finalizeDefaultOkRawResult, finalizeRawResult, finalizeResultWithoutContext, getDefaultSuccessResponseInit, getDefaultSuccessStatus, handlePlainExecutionError, mapUnknownToResponse } from './results';
import { type CompiledArgumentInput, type CompiledRoute, type CompiledRouteExecutor, type DeferredPayloadLoader, type DeferredPayloadLoaderFactory, type ManifestRoute, type NextResponseFactory, type RawExecutionState, type RawResponseExecutionState, RESPONSE_INIT_204, type ResponseStateAdapter, type RouteFilters } from './types';
import { isAsyncFunction, isPromiseLike, rethrowJsonBodyError } from './utils';

/**
 * Finalises results of routes without middleware: nothing can queue headers or a status on it, so one
 * shared instance serves every request (its methods only read, or clear fields that are already empty).
 */
const UNQUEUED_RESPONSE_STATE = new ResponseState();

export function createCompiledRouteWithExecutor<TSchema>(
  route: ManifestRoute<TSchema>,
  execute: CompiledRouteExecutor<TSchema>,
): CompiledRoute<TSchema> {
  return {
    route,
    execute,
  };
}

export function selectCompiledRouteExecutor<TSchema>(
  route: ManifestRoute<TSchema>,
  candidates: Array<CompiledRouteExecutor<TSchema> | undefined>,
): CompiledRoute<TSchema> | undefined {
  for (const execute of candidates) {
    if (execute) {
      return createCompiledRouteWithExecutor(route, execute);
    }
  }

  return undefined;
}

type RawState = RawExecutionState | RawResponseExecutionState;

interface SpecializedRawExecutorInput {
  createState: (request: Request, params: Record<string, string>) => RawState;
  ensureGuardsAllowed: ((request: Request, params: Record<string, string>) => void | Promise<void>) | undefined;
  executeMiddleware: (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => Response | Promise<Response>;
  finalizeHandlerResult: (result: unknown, responseState: ResponseState) => Response;
  handleError: (error: unknown, state: RawState, responseState: ResponseState) => Response | Promise<Response>;
  useRequestUrl?: boolean;
}

/**
 * Raw executor for a route that reads no body. Per request it allocates the state and the `next`
 * closure only; a synchronous handler behind a synchronous middleware adds no promise hop.
 */
export function createSpecializedRawHandlerExecutor(input: SpecializedRawExecutorInput & {
  executeHandler: (params: Record<string, string>, requestUrl: string) => unknown | PromiseLike<unknown>;
}) {
  const { createState, ensureGuardsAllowed, executeHandler, executeMiddleware, finalizeHandlerResult, handleError } = input;
  const useRequestUrl = input.useRequestUrl === true;
  const finalize = finalizeHandlerResult as (value: unknown, context: ResponseStateAdapter) => Response;

  return async (request: Request, params: Record<string, string>) => {
    const requestUrl = useRequestUrl ? request.url : '';
    const state = createState(request, params);
    const responseState = state.getResponseState();

    try {
      // Await only an async guard: `await undefined` would still cost a microtask per request.
      const guarded = ensureGuardsAllowed?.(request, params);
      if (guarded) {
        await guarded;
      }

      const next = () => finalizeRawResult(executeHandler(params, requestUrl), responseState, finalize);
      const middlewareResult = executeMiddleware(request, params, responseState, next);
      return resolveRawMiddlewareResult(isPromiseLike<Response>(middlewareResult) ? await middlewareResult : middlewareResult, state, finalize);
    } catch (error) {
      return handleError(error, state, responseState);
    }
  };
}

export function createSpecializedPlainHandlerExecutor(input: {
  executeHandler: (input: {
    bodyPayload: unknown;
    params: Record<string, string>;
  }) => unknown | PromiseLike<unknown>;
  finalizeResult: (result: unknown) => Response;
  resolveBodyPayload: (request: Request) => unknown | PromiseLike<unknown>;
  handleError: (error: unknown) => Response;
}) {
  return async (request: Request, params: Record<string, string>) => {
    try {
      const bodyPayload = await input.resolveBodyPayload(request);
      const result = input.executeHandler({ bodyPayload, params });
      return isPromiseLike<unknown>(result)
        ? input.finalizeResult(await result)
        : input.finalizeResult(result);
    } catch (error) {
      return input.handleError(error);
    }
  };
}

/**
 * Raw executor for a route that reads a body. `readBody` is the route's one-reaction JSON reader
 * (`request.json().then(validate, rethrowJsonBodyError)`); the handler runs in the same reaction, so a
 * synchronous handler costs two promise hops in total (body, then the middleware's await).
 */
export function createSpecializedRawHandlerBodyExecutor(input: SpecializedRawExecutorInput & {
  readBody: (request: Request) => Promise<unknown>;
  executeHandler: (bodyPayload: unknown, params: Record<string, string>, requestUrl: string) => unknown | PromiseLike<unknown>;
}) {
  const { createState, ensureGuardsAllowed, executeHandler, executeMiddleware, finalizeHandlerResult, handleError, readBody } = input;
  const useRequestUrl = input.useRequestUrl === true;
  const finalize = finalizeHandlerResult as (value: unknown, context: ResponseStateAdapter) => Response;

  return async (request: Request, params: Record<string, string>) => {
    const requestUrl = useRequestUrl ? request.url : '';
    const state = createState(request, params);
    const responseState = state.getResponseState();

    try {
      const guarded = ensureGuardsAllowed?.(request, params);
      if (guarded) {
        await guarded;
      }

      // The body is read once even if a middleware calls `next()` more than once.
      let pendingBody: Promise<unknown> | undefined;
      const next = () => (pendingBody ??= readBody(request)).then((bodyPayload) => {
        state.primeBody(bodyPayload);
        return finalizeRawResult(executeHandler(bodyPayload, params, requestUrl), responseState, finalize);
      });
      const middlewareResult = executeMiddleware(request, params, responseState, next);
      return resolveRawMiddlewareResult(isPromiseLike<Response>(middlewareResult) ? await middlewareResult : middlewareResult, state, finalize);
    } catch (error) {
      return handleError(error, state, responseState);
    }
  };
}

export function compileRouteExecutor<TSchema>(input: {
  container: Container;
  definition: AppDefinition<TSchema>;
  globalFilterTokens: Token[];
  globalGuardTokens: Token[];
  globalMiddlewareTokens: Token[];
  route: ManifestRoute<TSchema>;
}): CompiledRoute<TSchema> {
  let compiled = compileRouteExecutorFor(input);
  if (isFormMediaType(input.route.docs.consumes)) {
    compiled = withFormBody(compiled);
  }
  // Outside the form reader: the limit applies before any body is parsed.
  const bodyLimit = resolveBodyLimit(input.route, input.definition.bodyLimit);
  if (bodyLimit !== undefined) {
    compiled = withBodyLimit(compiled, bodyLimit);
  }
  // Headers are validated before the form body is installed / anything else runs.
  return routeUsesHeaders(input.route) ? withRouteHeaders(compiled, input.definition, input.route) : compiled;
}

function compileRouteExecutorFor<TSchema>(input: {
  container: Container;
  definition: AppDefinition<TSchema>;
  globalFilterTokens: Token[];
  globalGuardTokens: Token[];
  globalMiddlewareTokens: Token[];
  route: ManifestRoute<TSchema>;
}): CompiledRoute<TSchema> {
  const controllerResolver = createScopedResolver<Record<string, unknown>>({
    container: input.container,
    token: input.route.controller as Token,
    validate: (controller, token) => {
      const routeHandler = controller[input.route.methodName] as ((...args: unknown[]) => unknown) | undefined;
      if (!routeHandler) {
        throw new Error(`Handler not found: ${describeToken(token)}.${input.route.methodName}`);
      }
    },
  });
  const prototypeHandler = input.route.controller.prototype?.[input.route.methodName] as ((...args: unknown[]) => unknown) | undefined;
  if (!prototypeHandler) {
    throw new Error(`Handler not found: ${input.route.controller.name}.${input.route.methodName}`);
  }

  const singletonController = controllerResolver.requestScoped ? undefined : controllerResolver.resolve();
  const guards = compileGuards(input.container, [...input.globalGuardTokens, ...input.route.guards]);
  const middleware = compileMiddleware(input.container, [...input.globalMiddlewareTokens, ...input.route.middleware]);
  const filters = compileFilters(input.container, [...input.globalFilterTokens, ...input.route.filters]);
  const resolveArguments = createArgumentResolver(input.route.parameters);
  const invokeHandler = createHandlerInvoker(input.route.parameters);
  // An input-object parameter (`find({ params, context })`) counts as each of the fields it reads.
  const reads = (source: 'context' | 'body' | 'path' | 'query', field: 'context' | 'body' | 'params' | 'query') =>
    input.route.parameters.some((parameter) => parameter.source === source || (parameter.source === 'input' && (parameter.fields ?? ['params', 'query', 'body', 'context']).includes(field)));
  const hasContextParameter = reads('context', 'context');
  const hasBodyParameter = reads('body', 'body');
  const hasPathParameter = reads('path', 'params');
  const hasQueryParameter = reads('query', 'query');
  const inputReads = (field: 'params' | 'query') =>
    input.route.parameters.some((parameter) => parameter.source === 'input' && (parameter.fields ?? ['params', 'query', 'body', 'context']).includes(field));
  const hasSingleBodyParameter = input.route.parameters.length === 1
    && input.route.parameters[0]?.index === 0
    && input.route.parameters[0]?.source === 'body';
  const requiresQueryObject = Boolean(input.route.docs.querySchema) || inputReads('query') || input.route.parameters.some((parameter) => parameter.source === 'query' && !parameter.name);
  const requiresParamObject = Boolean(input.route.docs.paramSchema) || inputReads('params') || input.route.parameters.some((parameter) => parameter.source === 'path' && !parameter.name);
  const requiresRequestUrl = requiresQueryObject || hasQueryParameter;
  const requiresBody = hasBodyParameter || Boolean(input.route.docs.bodySchema);
  const singletonGuards = guards.singletonInstances;
  const singletonMiddleware = middleware.singletonInstances;
  const singletonMiddlewareOnly = !middleware.requestScoped ? singletonMiddleware : [];
  const singletonMiddlewareUseRawOnly = !middleware.requestScoped && singletonMiddlewareOnly.every((entry) => typeof entry.handleRaw === 'function' || typeof entry.useRaw === 'function');
  const singletonGuardsUseRawOnly = !guards.requestScoped && singletonGuards.every((guard) => typeof guard.canActivateRaw === 'function');
  const singleRawGuard = singletonGuardsUseRawOnly && singletonGuards.length === 1 ? singletonGuards[0] : undefined;
  const singleRawMiddleware = singletonMiddlewareUseRawOnly && singletonMiddlewareOnly.length === 1 ? singletonMiddlewareOnly[0] : undefined;
  const singleRawGuardMethod = singleRawGuard?.canActivateRaw;
  const invokeSingleRawGuard = singleRawGuard && singleRawGuardMethod
    ? (request: Request, params: Record<string, string>) => singleRawGuardMethod.call(singleRawGuard, request, params, input.route)
    : undefined;
  const invokeSingleRawGuardSync = singleRawGuard && singleRawGuardMethod && invokeSingleRawGuard && !isAsyncFunction(singleRawGuardMethod)
    ? (request: Request, params: Record<string, string>) => invokeSingleRawGuard(request, params) as boolean
    : undefined;
  const singleRawMiddlewareMethod = singleRawMiddleware
    ? (typeof singleRawMiddleware.handleRaw === 'function' ? singleRawMiddleware.handleRaw : singleRawMiddleware.useRaw!)
    : undefined;
  const invokeSingleRawMiddleware = singleRawMiddleware && singleRawMiddlewareMethod
    ? (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => singleRawMiddlewareMethod.call(singleRawMiddleware, request, params, responseState, next, input.route)
    : undefined;
  const ensureSingleRawGuardAllowed = createSingleRawGuardAllowChecker(invokeSingleRawGuard, invokeSingleRawGuardSync);
  const executeSingleRawMiddleware = createResolvedRawMiddlewareInvoker(invokeSingleRawMiddleware);
  const ensureRawGuardsAllowed = createRawGuardsAllowChecker(ensureSingleRawGuardAllowed, singletonGuards, input.route);
  const dispatchRawMiddleware = createRawMiddlewareDispatcher(executeSingleRawMiddleware, singletonMiddlewareOnly, input.route);
  const requiresGuardContext = guards.requestScoped || singletonGuards.some((guard) => typeof guard.canActivateRaw !== 'function');
  const requiresContext = hasContextParameter || middleware.entries.length > 0 || filters.entries.length > 0 || requiresGuardContext || controllerResolver.requestScoped;
  const requiresRequestScopedContainer = controllerResolver.requestScoped || guards.requestScoped || middleware.requestScoped || filters.requestScoped;
  // A precomputed static response skips the whole pipeline, so it is only allowed when no guard,
  // middleware or filter applies — including app-wide globals (the route's own lists are checked in
  // canPrecomputeNativeStaticResponse; the compiled lists below also contain the globals).
  const hasEnhancers = guards.entries.length > 0 || middleware.entries.length > 0 || filters.entries.length > 0;
  // A parameterless, schema-free GET handler cannot see the request, so (as for the static path) its
  // response is computed once. With enhancers the pipeline still runs around a clone of it.
  const precomputedResponse = singletonController
    ? createNativeStaticResponse({
        definition: input.definition,
        handler: singletonController[input.route.methodName] as (...args: unknown[]) => unknown,
        route: input.route,
        target: singletonController,
      })
    : undefined;
  const nativeStaticResponse = hasEnhancers ? undefined : precomputedResponse;
  const mapCompiledResponseBody = createResponseBodyMapper(input.definition, input.route);
  const defaultSuccessStatus = getDefaultSuccessStatus(input.route);
  const defaultSuccessResponseInit = getDefaultSuccessResponseInit(defaultSuccessStatus);
  const resolveParamPayload = createParamPayloadResolver(input.definition, input.route, requiresParamObject);
  const resolveQueryPayload = createQueryPayloadResolver(input.definition, input.route, requiresQueryObject);
  const hasRawFilters = filters.singletonInstances.length > 0;
  const createRawState = hasRawFilters
    ? (request: Request, params: Record<string, string>) => createRawExecutionState(request, params, input.container)
    : (request: Request) => createRawResponseExecutionState(request);
  const resolveBodyPayload = createBodyPayloadResolver(input.definition, input.route, requiresBody);
  // One-reaction body reader for the raw executors (`createBodyPayloadResolver` returns a promise for
  // every method that has a body; GET / HEAD routes resolve to `undefined`).
  const readsRequestBody = requiresBody && input.route.method !== 'GET' && input.route.method !== 'HEAD';
  const readBodyPayload = readsRequestBody
    ? resolveBodyPayload as (request: Request) => Promise<unknown>
    : () => Promise.resolve(undefined);
  const resolveBodyPayloadFromJsonLoader = createBodyPayloadFromJsonLoaderResolver(input.definition, input.route, requiresBody);
  const createBodyPayloadLoader = createBodyPayloadLoaderFactory(input.definition, input.route, requiresBody);
  const finalizeCompiledContextResult = !mapCompiledResponseBody
    ? (defaultSuccessStatus === 201
        ? finalizeDefaultCreatedContextResult
        : (defaultSuccessStatus === 204
        ? (result: unknown, context: ResponseStateAdapter) => {
            if (result instanceof Response) {
              return result;
            }

            if (result === undefined || context.hasQueuedNoContentResponse()) {
              return context.noContent();
            }

            return context.respond(result, RESPONSE_INIT_204);
          }
        : (defaultSuccessStatus !== undefined
            ? (result: unknown, context: ResponseStateAdapter) => {
                if (result instanceof Response) {
                  return result;
                }

                if (result === undefined && context.hasQueuedNoContentResponse()) {
                  return context.noContent();
                }

                return context.respond(result, defaultSuccessResponseInit!);
              }
            : (result: unknown, context: ResponseStateAdapter) => mapUnknownToResponse(result, context, defaultSuccessStatus))))
    : (result: unknown, context: ResponseStateAdapter) => finalizeContextResult(result, context, mapCompiledResponseBody, defaultSuccessStatus);
  const finalizeCompiledPlainResult = !mapCompiledResponseBody
    ? (defaultSuccessStatus === 201
        ? finalizeDefaultCreatedPlainResult
        : (defaultSuccessStatus === 204
        ? (result: unknown) => {
            if (result instanceof Response) {
              return result;
            }

            if (result === undefined) {
              return createNoContentResponse();
            }

            return createJsonResponseWithStatus(result, 204);
          }
        : (defaultSuccessStatus !== undefined
            ? (result: unknown) => {
                if (result instanceof Response) {
                  return result;
                }

                return createJsonResponseWithStatus(result, defaultSuccessStatus);
              }
            : (result: unknown) => finalizeResultWithoutContext(result, mapCompiledResponseBody, defaultSuccessStatus))))
    : (result: unknown) => finalizeResultWithoutContext(result, mapCompiledResponseBody, defaultSuccessStatus);
  const singletonHandler = singletonController?.[input.route.methodName] as ((...args: unknown[]) => unknown) | undefined;
  const executeSingletonHandler = precomputedResponse
    ? () => precomputedResponse.clone()
    : singletonController && singletonHandler
    ? createCompiledHandlerExecutor({
        controller: singletonController,
        handler: singletonHandler,
        invokeHandler,
        parameterCount: input.route.parameters.length,
        parameters: input.route.parameters,
        resolveArguments,
      })
    : undefined;

  if (nativeStaticResponse) {
    return {
      route: input.route,
      nativeStaticResponse,
      execute: async () => nativeStaticResponse.clone(),
    };
  }

  const executeWithoutContext = async (request: Request, params: Record<string, string>) => {
    try {
      if (executeSingletonHandler && requiresBody && !requiresRequestUrl && !hasPathParameter && !requiresParamObject && singletonGuards.length === 0) {
        const pending = executeSingletonHandler(await resolveBodyPayload(request), undefined, undefined, params, undefined, '');
        const result = isPromiseLike<unknown>(pending) ? await pending : pending;
        if (result instanceof Response) {
          return result;
        }

        return finalizeCompiledPlainResult(result);
      }

      const requestUrl = requiresRequestUrl ? request.url : '';
      const paramPayload = resolveParamPayload(params);
      const queryPayload = resolveQueryPayload(requestUrl);

      const guarded = ensureRawGuardsAllowed?.(request, params);
      if (guarded) {
        await guarded;
      }

      // `await` only real promises: awaiting a plain value still costs a microtask per request.
      const loadedBody = readsRequestBody ? resolveBodyPayload(request) : undefined;
      const bodyPayload = isPromiseLike<unknown>(loadedBody) ? await loadedBody : loadedBody;

      if (executeSingletonHandler) {
        const pending = executeSingletonHandler(bodyPayload, undefined, paramPayload, params, queryPayload, requestUrl);
        const result = isPromiseLike<unknown>(pending) ? await pending : pending;
        if (result instanceof Response) {
          return result;
        }

        return finalizeCompiledPlainResult(result);
      }

      const controller = singletonController ?? controllerResolver.resolve();
      const handler = controller[input.route.methodName] as ((...args: unknown[]) => unknown) | undefined;
      if (!handler) {
        throw new Error(`Handler not found: ${input.route.controller.name}.${input.route.methodName}`);
      }

      const result = input.route.parameters.length === 0
        ? await handler.call(controller)
        : (invokeHandler
            ? await invokeHandler(controller, handler, {
                bodyValue: bodyPayload,
                context: undefined,
                paramValue: paramPayload,
                params,
                queryParam: (name) => readNamedQueryParam(requestUrl, name),
                queryValue: queryPayload,
              })
            : await handler.apply(controller, resolveArguments({
                bodyValue: bodyPayload,
                context: undefined,
                paramValue: paramPayload,
                params,
                queryParam: (name) => readNamedQueryParam(requestUrl, name),
                queryValue: queryPayload,
              })));
      if (result instanceof Response) {
        return result;
      }

      return finalizeCompiledPlainResult(result);
    } catch (error) {
      return handlePlainExecutionError(error);
    }
  };

  const executeWithoutContextBodyOnly = executeSingletonHandler
    && requiresBody
    && !requiresRequestUrl
    && !hasPathParameter
    && !requiresParamObject
    && singletonGuards.length === 0
    ? createSpecializedPlainHandlerExecutor({
        executeHandler: ({ bodyPayload, params }) => executeSingletonHandler(bodyPayload, undefined, undefined, params, undefined, ''),
        finalizeResult: finalizeCompiledPlainResult,
        handleError: handlePlainExecutionError,
        resolveBodyPayload: (request) => resolveBodyPayloadFromJsonLoader(() => request.json().then(undefined, rethrowJsonBodyError)),
      })
    : undefined;

  const executeWithoutContextValidatedCreatedBodyOnly = executeSingletonHandler
    && hasSingleBodyParameter
    && Boolean(input.route.docs.bodySchema)
    && defaultSuccessStatus === 201
    && !mapCompiledResponseBody
    && !requiresRequestUrl
    && !hasPathParameter
    && !requiresParamObject
    && singletonGuards.length === 0
    ? createSpecializedPlainHandlerExecutor({
        executeHandler: ({ bodyPayload, params }) => executeSingletonHandler(bodyPayload, undefined, undefined, params, undefined, ''),
        finalizeResult: finalizeDefaultCreatedPlainResult,
        handleError: handlePlainExecutionError,
        resolveBodyPayload: (request) => resolveBodyPayloadFromJsonLoader(() => request.json().then(undefined, rethrowJsonBodyError)),
      })
    : undefined;

  const handleRawPipelineError = async (
    error: unknown,
    getContext: () => RequestContext,
    rawResponseState: ResponseState,
  ) => {
    if (filters.singletonInstances.length > 0) {
      const filtered = await applyFilters(filters.singletonInstances, error, getContext(), input.route);
      if (filtered) {
        return getContext().applyResponseHeaders(filtered);
      }
    }

    if (error instanceof HttpError) {
      return rawResponseState.hasQueuedResponseState()
        ? rawResponseState.applyResponseHeaders(error.toResponse())
        : error.toResponse();
    }

    if (error instanceof Response) {
      return rawResponseState.hasQueuedResponseState()
        ? rawResponseState.applyResponseHeaders(error)
        : error;
    }

    const response = createUnhandledErrorResponse(error);

    return rawResponseState.hasQueuedResponseState()
      ? rawResponseState.applyResponseHeaders(response)
      : response;
  };

  const handleRawPipelineErrorWithoutContext = (error: unknown, rawResponseState: ResponseState) => {
    if (error instanceof HttpError) {
      return rawResponseState.hasQueuedResponseState()
        ? rawResponseState.applyResponseHeaders(error.toResponse())
        : error.toResponse();
    }

    if (error instanceof Response) {
      return rawResponseState.hasQueuedResponseState()
        ? rawResponseState.applyResponseHeaders(error)
        : error;
    }

    const response = createUnhandledErrorResponse(error);

    return rawResponseState.hasQueuedResponseState()
      ? rawResponseState.applyResponseHeaders(response)
      : response;
  };

  const handleRawExecutionError = (
    error: unknown,
    state: RawExecutionState | RawResponseExecutionState,
    rawResponseState: ResponseState,
  ) => hasRawFilters
    ? handleRawPipelineError(error, (state as RawExecutionState).getContext, rawResponseState)
    : handleRawPipelineErrorWithoutContext(error, rawResponseState);

  const executeWithSingleRawGuardAndMiddlewareNoInput = singleRawGuard && invokeSingleRawGuard && invokeSingleRawMiddleware && !requiresBody && !requiresRequestUrl
    ? createSpecializedRawHandlerExecutor({
        createState: createRawState,
        ensureGuardsAllowed: ensureSingleRawGuardAllowed,
        executeHandler: (params) => executeSingletonHandler!(undefined, undefined, resolveParamPayload(params), params, undefined, ''),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeCompiledContextResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawGuardAndMiddlewareBodyOnly = singleRawGuard
    && invokeSingleRawGuard
    && invokeSingleRawMiddleware
    && executeSingletonHandler
    && requiresBody
    && !requiresRequestUrl
    && !hasPathParameter
    && !requiresParamObject
    ? createSpecializedRawHandlerBodyExecutor({
        readBody: readBodyPayload,
        createState: createRawState,
        ensureGuardsAllowed: ensureSingleRawGuardAllowed,
        executeHandler: (bodyPayload, params) => executeSingletonHandler(bodyPayload, undefined, undefined, params, undefined, ''),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeCompiledContextResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawGuardAndMiddlewareCreatedBodyOnly = singleRawGuard
    && invokeSingleRawGuard
    && invokeSingleRawMiddleware
    && executeSingletonHandler
    && defaultSuccessStatus === 201
    && !mapCompiledResponseBody
    && requiresBody
    && !requiresRequestUrl
    && !hasPathParameter
    && !requiresParamObject
    ? createSpecializedRawHandlerBodyExecutor({
        readBody: readBodyPayload,
        createState: createRawState,
        ensureGuardsAllowed: ensureSingleRawGuardAllowed,
        executeHandler: (bodyPayload, params) => executeSingletonHandler(bodyPayload, undefined, undefined, params, undefined, ''),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeDefaultCreatedRawResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawGuardAndMiddlewareNoQuery = singleRawGuard && invokeSingleRawGuard && invokeSingleRawMiddleware && requiresBody && !requiresRequestUrl
    ? createSpecializedRawHandlerBodyExecutor({
        readBody: readBodyPayload,
        createState: createRawState,
        ensureGuardsAllowed: ensureSingleRawGuardAllowed,
        executeHandler: (bodyPayload, params) => executeSingletonHandler!(
          bodyPayload,
          undefined,
          resolveParamPayload(params),
          params,
          undefined,
          '',
        ),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeCompiledContextResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawGuardAndMiddlewarePathBodyNoQuery = singleRawGuard
    && invokeSingleRawGuard
    && invokeSingleRawMiddleware
    && executeSingletonHandler
    && defaultSuccessStatus === undefined
    && !mapCompiledResponseBody
    && requiresBody
    && !requiresRequestUrl
    && hasPathParameter
    ? createSpecializedRawHandlerBodyExecutor({
        readBody: readBodyPayload,
        createState: createRawState,
        ensureGuardsAllowed: ensureSingleRawGuardAllowed,
        executeHandler: (bodyPayload, params) => executeSingletonHandler(
          bodyPayload,
          undefined,
          resolveParamPayload(params),
          params,
          undefined,
          '',
        ),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeDefaultOkRawResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawGuardAndMiddleware = singleRawGuard && invokeSingleRawGuard && invokeSingleRawMiddleware
    ? (requiresBody
        ? createSpecializedRawHandlerBodyExecutor({
            readBody: readBodyPayload,
            createState: createRawState,
            ensureGuardsAllowed: ensureSingleRawGuardAllowed,
            executeHandler: (bodyPayload, params, requestUrl) => executeSingletonHandler!(
              bodyPayload,
              undefined,
              resolveParamPayload(params),
              params,
              resolveQueryPayload(requestUrl),
              requestUrl,
            ),
            executeMiddleware: executeSingleRawMiddleware!,
            finalizeHandlerResult: finalizeCompiledContextResult,
            handleError: handleRawExecutionError,
            useRequestUrl: requiresRequestUrl,
          })
        : createSpecializedRawHandlerExecutor({
            createState: createRawState,
            ensureGuardsAllowed: ensureSingleRawGuardAllowed,
            executeHandler: (params, requestUrl) => executeSingletonHandler!(
              undefined,
              undefined,
              resolveParamPayload(params),
              params,
              resolveQueryPayload(requestUrl),
              requestUrl,
            ),
            executeMiddleware: executeSingleRawMiddleware!,
            finalizeHandlerResult: finalizeCompiledContextResult,
            handleError: handleRawExecutionError,
            useRequestUrl: requiresRequestUrl,
          }))
    : undefined;

  const executeWithSingleRawMiddlewareNoInput = singleRawMiddleware && invokeSingleRawMiddleware && !requiresBody && !requiresRequestUrl
    ? createSpecializedRawHandlerExecutor({
        createState: createRawState,
        ensureGuardsAllowed: undefined,
        executeHandler: (params) => executeSingletonHandler!(undefined, undefined, resolveParamPayload(params), params, undefined, ''),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeCompiledContextResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawMiddlewareBodyOnly = singleRawMiddleware
    && invokeSingleRawMiddleware
    && executeSingletonHandler
    && requiresBody
    && !requiresRequestUrl
    && !hasPathParameter
    && !requiresParamObject
    ? createSpecializedRawHandlerBodyExecutor({
        readBody: readBodyPayload,
        createState: createRawState,
        ensureGuardsAllowed: undefined,
        executeHandler: (bodyPayload, params) => executeSingletonHandler(bodyPayload, undefined, undefined, params, undefined, ''),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeCompiledContextResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawMiddlewareCreatedBodyOnly = singleRawMiddleware
    && invokeSingleRawMiddleware
    && executeSingletonHandler
    && defaultSuccessStatus === 201
    && !mapCompiledResponseBody
    && requiresBody
    && !requiresRequestUrl
    && !hasPathParameter
    && !requiresParamObject
    ? createSpecializedRawHandlerBodyExecutor({
        readBody: readBodyPayload,
        createState: createRawState,
        ensureGuardsAllowed: undefined,
        executeHandler: (bodyPayload, params) => executeSingletonHandler(bodyPayload, undefined, undefined, params, undefined, ''),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeDefaultCreatedRawResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawMiddlewareNoQuery = singleRawMiddleware && invokeSingleRawMiddleware && requiresBody && !requiresRequestUrl
    ? createSpecializedRawHandlerBodyExecutor({
        readBody: readBodyPayload,
        createState: createRawState,
        ensureGuardsAllowed: undefined,
        executeHandler: (bodyPayload, params) => executeSingletonHandler!(
          bodyPayload,
          undefined,
          resolveParamPayload(params),
          params,
          undefined,
          '',
        ),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeCompiledContextResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawMiddlewarePathBodyNoQuery = singleRawMiddleware
    && invokeSingleRawMiddleware
    && executeSingletonHandler
    && defaultSuccessStatus === undefined
    && !mapCompiledResponseBody
    && requiresBody
    && !requiresRequestUrl
    && hasPathParameter
    ? createSpecializedRawHandlerBodyExecutor({
        readBody: readBodyPayload,
        createState: createRawState,
        ensureGuardsAllowed: undefined,
        executeHandler: (bodyPayload, params) => executeSingletonHandler(
          bodyPayload,
          undefined,
          resolveParamPayload(params),
          params,
          undefined,
          '',
        ),
        executeMiddleware: executeSingleRawMiddleware!,
        finalizeHandlerResult: finalizeDefaultOkRawResult,
        handleError: handleRawExecutionError,
      })
    : undefined;

  const executeWithSingleRawMiddleware = singleRawMiddleware && invokeSingleRawMiddleware
    ? (requiresBody
        ? createSpecializedRawHandlerBodyExecutor({
            readBody: readBodyPayload,
            createState: createRawState,
            ensureGuardsAllowed: undefined,
            executeHandler: (bodyPayload, params, requestUrl) => executeSingletonHandler!(
              bodyPayload,
              undefined,
              resolveParamPayload(params),
              params,
              resolveQueryPayload(requestUrl),
              requestUrl,
            ),
            executeMiddleware: executeSingleRawMiddleware!,
            finalizeHandlerResult: finalizeCompiledContextResult,
            handleError: handleRawExecutionError,
            useRequestUrl: requiresRequestUrl,
          })
        : createSpecializedRawHandlerExecutor({
            createState: createRawState,
            ensureGuardsAllowed: undefined,
            executeHandler: (params, requestUrl) => executeSingletonHandler!(
              undefined,
              undefined,
              resolveParamPayload(params),
              params,
              resolveQueryPayload(requestUrl),
              requestUrl,
            ),
            executeMiddleware: executeSingleRawMiddleware!,
            finalizeHandlerResult: finalizeCompiledContextResult,
            handleError: handleRawExecutionError,
            useRequestUrl: requiresRequestUrl,
          }))
    : undefined;

  /**
   * Raw guards and / or exception filters but no middleware (#66): nothing can queue response headers,
   * so the success path allocates no execution state; it is created only when an error reaches the
   * filters (with the body already read, so their context sees it).
   */
  const executeWithoutMiddlewareRaw = async (request: Request, params: Record<string, string>) => {
    const requestUrl = requiresRequestUrl ? request.url : '';
    let bodyPayload: unknown;
    let bodyLoaded = false;

    try {
      const paramPayload = resolveParamPayload(params);
      const queryPayload = resolveQueryPayload(requestUrl);

      const guarded = ensureRawGuardsAllowed?.(request, params);
      if (guarded) {
        await guarded;
      }

      if (requiresBody) {
        bodyPayload = await readBodyPayload(request);
        bodyLoaded = true;
      }

      const pending = executeSingletonHandler!(bodyPayload, undefined, paramPayload, params, queryPayload, requestUrl);
      const result = isPromiseLike<unknown>(pending) ? await pending : pending;
      return result instanceof Response ? result : finalizeCompiledContextResult(result, UNQUEUED_RESPONSE_STATE);
    } catch (error) {
      const state = createRawState(request, params);
      if (bodyLoaded) {
        state.primeBody(bodyPayload);
      }
      return handleRawExecutionError(error, state, state.getResponseState());
    }
  };

  const executeWithRawPipeline = async (request: Request, params: Record<string, string>) => {
    const requestUrl = requiresRequestUrl ? request.url : '';
    const state = createRawState(request, params);

    try {
      const paramPayload = resolveParamPayload(params);
      const queryPayload = resolveQueryPayload(requestUrl);

      const guarded = ensureRawGuardsAllowed?.(request, params);
      if (guarded) {
        await guarded;
      }

      const responseState = state.getResponseState();
      // As in the specialised executors: no body → the handler runs synchronously inside `next()`;
      // a body → one reaction reads + validates it and runs the handler (read once per request).
      let pendingBody: Promise<unknown> | undefined;
      const executeHandler: NextResponseFactory = requiresBody
        ? () => (pendingBody ??= readBodyPayload(request)).then((bodyPayload) => {
            state.primeBody(bodyPayload);
            return finalizeRawResult(
              executeSingletonHandler!(bodyPayload, undefined, paramPayload, params, queryPayload, requestUrl),
              responseState,
              finalizeCompiledContextResult,
            );
          })
        : () => finalizeRawResult(
            executeSingletonHandler!(undefined, undefined, paramPayload, params, queryPayload, requestUrl),
            responseState,
            finalizeCompiledContextResult,
          ) as Response | Promise<Response>;

      const dispatched = dispatchRawMiddleware(request, params, responseState, executeHandler);
      const directResult = isPromiseLike<Response>(dispatched) ? await dispatched : dispatched;

      return resolveRawMiddlewareResult(directResult, state, finalizeCompiledContextResult);
    } catch (error) {
      return handleRawExecutionError(error, state, state.getResponseState());
    }
  };

  if (!requiresContext && singletonMiddleware.length === 0 && filters.singletonInstances.length === 0) {
    return selectCompiledRouteExecutor(input.route, [
      executeWithoutContextValidatedCreatedBodyOnly,
      executeWithoutContextBodyOnly,
      executeWithoutContext,
    ])!;
  }

  const canUseSpecializedRawExecutor = !requiresRequestScopedContainer && !hasContextParameter;
  const hasNoSingletonGuards = singletonGuards.length === 0;
  const selectedRawExecutor = selectCompiledRouteExecutor(input.route, [
    canUseSpecializedRawExecutor ? executeWithSingleRawGuardAndMiddlewareNoInput : undefined,
    canUseSpecializedRawExecutor ? executeWithSingleRawGuardAndMiddlewareCreatedBodyOnly : undefined,
    canUseSpecializedRawExecutor ? executeWithSingleRawGuardAndMiddlewareBodyOnly : undefined,
    canUseSpecializedRawExecutor ? executeWithSingleRawGuardAndMiddlewarePathBodyNoQuery : undefined,
    canUseSpecializedRawExecutor ? executeWithSingleRawGuardAndMiddlewareNoQuery : undefined,
    canUseSpecializedRawExecutor ? executeWithSingleRawGuardAndMiddleware : undefined,
    canUseSpecializedRawExecutor && hasNoSingletonGuards ? executeWithSingleRawMiddlewareNoInput : undefined,
    canUseSpecializedRawExecutor && hasNoSingletonGuards ? executeWithSingleRawMiddlewareCreatedBodyOnly : undefined,
    canUseSpecializedRawExecutor && hasNoSingletonGuards ? executeWithSingleRawMiddlewareBodyOnly : undefined,
    canUseSpecializedRawExecutor && hasNoSingletonGuards ? executeWithSingleRawMiddlewarePathBodyNoQuery : undefined,
    canUseSpecializedRawExecutor && hasNoSingletonGuards ? executeWithSingleRawMiddlewareNoQuery : undefined,
    canUseSpecializedRawExecutor && hasNoSingletonGuards ? executeWithSingleRawMiddleware : undefined,
    executeSingletonHandler && canUseSpecializedRawExecutor && singletonGuardsUseRawOnly && middleware.entries.length === 0
      ? executeWithoutMiddlewareRaw
      : undefined,
    executeSingletonHandler && canUseSpecializedRawExecutor && singletonGuardsUseRawOnly && singletonMiddlewareUseRawOnly
      ? executeWithRawPipeline
      : undefined,
  ]);
  if (selectedRawExecutor) {
    return selectedRawExecutor;
  }

  // Ahead-of-time executor generated by `kivin generate`. It replaces only this generic path (the
  // specialised executors above are already tuned) and only for all-singleton routes.
  if (input.route.aot && aotEnabled && singletonController && singletonHandler && !requiresRequestScopedContainer) {
    const readsBody = requiresBody && input.route.method !== 'GET' && input.route.method !== 'HEAD';
    const generated = input.route.aot(createAotRuntime({
      container: input.container,
      route: input.route,
      controller: singletonController,
      guards: singletonGuards,
      middleware: singletonMiddlewareOnly,
      filters: filters.singletonInstances,
      defaultSuccessStatus,
      resolveParamPayload,
      resolveQueryPayload,
      validateBody: readsBody && input.route.docs.bodySchema ? createSchemaValidator(input.definition, input.route.docs.bodySchema, 'body') : undefined,
      readsBody,
      finalizeContext: finalizeCompiledContextResult,
      finalizePlain: finalizeCompiledPlainResult,
    }));
    if (generated) {
      return { route: input.route, execute: generated as CompiledRouteExecutor<TSchema>, aot: true };
    }
  }

  return {
    route: input.route,
    execute: async (request, params) => {
      let context: RequestContext | undefined;
      let requestContainer: Container | undefined;
      let parsedBody: unknown;
      let parsedBodyLoaded = false;
      let resolvedFilters: RouteFilters | undefined;
      const requestUrl = request.url;
      const setBodyPayload = (value: unknown) => {
        parsedBody = value;
        parsedBodyLoaded = true;

        if (context) {
          context.primeJsonBody(value);
        }
      };

      const createContextResolver = () => ({
        resolve<T>(token: Token<T>) {
          if ((input.container.getProviderScope(token) ?? 'singleton') === 'request') {
            return getRequestContainer().resolve(token);
          }

          return input.container.resolve(token);
        },
      });

      const ensureContext = () => {
        if (!context) {
          context = new RequestContext(
            request,
            params,
            requiresRequestScopedContainer ? getRequestContainer() : createContextResolver(),
          );

          if (requestContainer) {
            requestContainer.register({
              provide: RequestContext,
              scope: 'request',
              useValue: context,
            });
          }

          if (parsedBodyLoaded) {
            context.primeJsonBody(parsedBody);
          }
        }

        return context;
      };

      const getRequestContainer = () => {
        if (!requestContainer) {
          requestContainer = input.container.createRequestContainer();

          if (context) {
            requestContainer.register({
              provide: RequestContext,
              scope: 'request',
              useValue: context,
            });
          }
        }

        return requestContainer;
      };

      const getContext = () => {
        return ensureContext();
      };

      const getResolvedFilters = () => {
        if (!resolvedFilters) {
          resolvedFilters = filters.requestScoped
            ? resolveCompiledDependencies(filters, getRequestContainer())
            : filters.singletonInstances;
        }

        return resolvedFilters;
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

      try {
        if (requiresRequestScopedContainer && requiresContext) {
          ensureContext();
        }

        const paramPayload = resolveParamPayload(params);
        const queryPayload = resolveQueryPayload(requestUrl);
        const loadBodyPayload = createBodyPayloadLoader(getJsonBody, setBodyPayload);

        const resolvedGuards = guards.requestScoped
          ? resolveCompiledDependencies(guards, getRequestContainer())
          : singletonGuards;
        const resolvedMiddleware = middleware.requestScoped
          ? resolveCompiledDependencies(middleware, getRequestContainer())
          : singletonMiddleware;

        if (singletonGuardsUseRawOnly) {
          for (const guard of singletonGuards) {
            const allowed = guard.canActivateRaw!(request, params, input.route);
            if (isPromiseLike<boolean>(allowed) ? !(await allowed) : !allowed) {
              throw new HttpError(403, 'Forbidden');
            }
          }
        } else if (resolvedGuards.length > 0) {
          await enforceGuards({
            getContext,
            guards: resolvedGuards,
            params,
            request,
            route: input.route,
          });
        }

        if (
          executeSingletonHandler
          && !requiresRequestScopedContainer
          && !middleware.requestScoped
          && singletonMiddlewareOnly.length === 1
        ) {
          const current = singletonMiddlewareOnly[0]!;
          const contextValue = getContext();
          const next = async () => {
            const bodyPayload = requiresBody ? await loadBodyPayload() : undefined;
            return finalizeRawResult(
              executeSingletonHandler(bodyPayload, contextValue, paramPayload, params, queryPayload, requestUrl),
              contextValue,
              finalizeCompiledContextResult,
            );
          };

          const directResult = typeof current.handle === 'function'
            ? current.handle(contextValue, next, input.route)
            : current.use!(contextValue, next, input.route);

          const resolvedDirectResult = isPromiseLike<Response>(directResult)
            ? await directResult
            : directResult;

          if (resolvedDirectResult instanceof Response) {
            return contextValue.hasQueuedResponseState()
              ? contextValue.applyResponseHeaders(resolvedDirectResult)
              : resolvedDirectResult;
          }

          return finalizeCompiledContextResult(resolvedDirectResult, contextValue);
        }

        const controller = controllerResolver.requestScoped ? controllerResolver.resolve(getRequestContainer()) : singletonController ?? controllerResolver.resolve();
        const handler = controller[input.route.methodName] as ((...args: unknown[]) => unknown) | undefined;
        if (!handler) {
          throw new Error(`Handler not found: ${input.route.controller.name}.${input.route.methodName}`);
        }

        const runResolvedHandler = (bodyPayload: unknown) => {
          const argumentInput = {
            bodyValue: bodyPayload,
            context: hasContextParameter ? getContext() : undefined,
            paramValue: paramPayload,
            params,
            queryParam: (name) => readNamedQueryParam(requestUrl, name),
            queryValue: queryPayload,
          } satisfies CompiledArgumentInput;

          return input.route.parameters.length === 0
            ? handler.call(controller)
            : (invokeHandler
                ? invokeHandler(controller, handler, argumentInput)
                : handler.apply(controller, resolveArguments(argumentInput)));
        };
        // Without a body the handler runs synchronously; only real promises are awaited below.
        const executeResolvedHandler = requiresBody
          ? () => loadBodyPayload().then(runResolvedHandler)
          : () => runResolvedHandler(undefined);

        let result: unknown;
        if (resolvedMiddleware.length > 0) {
          result = await runMiddlewareChain({
            middleware: resolvedMiddleware,
            context: getContext(),
            defaultSuccessStatus,
            route: input.route,
            // Middleware sees `next()` reject (never throw synchronously), as before.
            execute: async () => executeResolvedHandler(),
          });
        } else {
          const pending = executeResolvedHandler();
          result = isPromiseLike<unknown>(pending) ? await pending : pending;
        }

        if (result instanceof Response) {
          if (!context) {
            return result;
          }

          return context.hasQueuedResponseState()
            ? context.applyResponseHeaders(result)
            : result;
        }

        if (context) {
          return finalizeCompiledContextResult(result, context);
        }

        return finalizeCompiledPlainResult(result);
      } catch (error) {
        const resolvedFilters = getResolvedFilters();
        if (resolvedFilters.length > 0) {
          const filtered = await applyFilters(resolvedFilters, error, getContext(), input.route);
          if (filtered) {
            return getContext().applyResponseHeaders(filtered);
          }
        }

        if (error instanceof HttpError) {
          if (!context) {
            return error.toResponse();
          }

          const response = error.toResponse();
          return context.hasQueuedResponseState()
            ? context.applyResponseHeaders(response)
            : response;
        }

        if (error instanceof Response) {
          if (!context) {
            return error;
          }

          return context.hasQueuedResponseState()
            ? context.applyResponseHeaders(error)
            : error;
        }

        const response = createUnhandledErrorResponse(error);

        if (!context) {
          return response;
        }

        return context.hasQueuedResponseState()
          ? context.applyResponseHeaders(response)
          : response;
      }
    },
  };
}
