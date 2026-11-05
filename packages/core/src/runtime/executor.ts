// Selects and builds the specialised executor for each compiled route.
import type { Container } from '../container';
import { RequestContext, type ResponseState } from '../context';
import { HttpError } from '../http';
import type { AppDefinition } from '../metadata';
import { readNamedQueryParam } from '../request-url';
import { createJsonResponseWithStatus, createNoContentResponse } from '../response';
import type { Token } from '../types';
import { aotEnabled, createAotRuntime } from './aot';
import { createArgumentResolver, createCompiledHandlerExecutor, createHandlerInvoker } from './arguments';
import { createBodyPayloadFromJsonLoaderResolver, createBodyPayloadLoaderFactory, createBodyPayloadResolver, createParamPayloadResolver, createQueryPayloadResolver, createSchemaValidator } from './payload';
import { applyFilters, compileFilters, compileGuards, compileMiddleware, createRawExecutionState, createRawGuardsAllowChecker, createRawMiddlewareDispatcher, createRawResponseExecutionState, createResolvedRawMiddlewareInvoker, createScopedResolver, createSingleRawGuardAllowChecker, describeToken, enforceGuards, resolveCompiledDependencies, resolveRawMiddlewareResult, runMiddlewareChain } from './pipeline';
import { createNativeStaticResponse, createResponseBodyMapper, createUnhandledErrorResponse, finalizeContextResult, finalizeDefaultCreatedContextResult, finalizeDefaultCreatedPlainResult, finalizeDefaultCreatedRawResult, finalizeDefaultOkRawResult, finalizeRawResult, finalizeResultWithoutContext, getDefaultSuccessResponseInit, getDefaultSuccessStatus, handlePlainExecutionError, mapUnknownToResponse } from './results';
import { type CompiledArgumentInput, type CompiledRoute, type CompiledRouteExecutor, type DeferredPayloadLoader, type DeferredPayloadLoaderFactory, type ManifestRoute, type NextResponseFactory, type RawExecutionState, type RawResponseExecutionState, RESPONSE_INIT_204, type ResponseStateAdapter, type RouteFilters } from './types';
import { isAsyncFunction, isPromiseLike } from './utils';

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

export function createSpecializedRawBodyExecutor(input: {
  createBodyPayloadLoader: DeferredPayloadLoaderFactory<unknown>;
  createState: (request: Request, params: Record<string, string>) => RawExecutionState | RawResponseExecutionState;
  ensureGuardsAllowed: ((request: Request, params: Record<string, string>) => void | Promise<void>) | undefined;
  executeMiddleware: (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => Promise<Response>;
  finalizeDirectResult: (result: Response, state: RawExecutionState | RawResponseExecutionState, responseState: ResponseState) => Response;
  handleError: (error: unknown, state: RawExecutionState | RawResponseExecutionState, responseState: ResponseState) => Response | Promise<Response>;
  prepareNext: (input: {
    loadBodyPayload: DeferredPayloadLoader<unknown>;
    params: Record<string, string>;
    request: Request;
    requestUrl: string;
    responseState: ResponseState;
  }) => NextResponseFactory;
  useRequestUrl?: boolean;
}) {
  return async (request: Request, params: Record<string, string>) => {
    const requestUrl = input.useRequestUrl ? request.url : '';
    const state = input.createState(request, params);
    const responseState = state.getResponseState();
    const loadBodyPayload = input.createBodyPayloadLoader(state.getJsonBody, state.setBodyPayload);

    try {
      await input.ensureGuardsAllowed?.(request, params);

      const next = input.prepareNext({
        loadBodyPayload,
        params,
        request,
        requestUrl,
        responseState,
      });

      const resolvedDirectResult = await input.executeMiddleware(request, params, responseState, next);
      return input.finalizeDirectResult(resolvedDirectResult, state, responseState);
    } catch (error) {
      return input.handleError(error, state, responseState);
    }
  };
}

export function createSpecializedRawHandlerExecutor(input: {
  createBodyPayloadLoader?: DeferredPayloadLoaderFactory<unknown>;
  createState: (request: Request, params: Record<string, string>) => RawExecutionState | RawResponseExecutionState;
  ensureGuardsAllowed: ((request: Request, params: Record<string, string>) => void | Promise<void>) | undefined;
  executeHandler: (input: {
    loadBodyPayload: DeferredPayloadLoader<unknown> | undefined;
    params: Record<string, string>;
    request: Request;
    requestUrl: string;
    responseState: ResponseState;
  }) => unknown | PromiseLike<unknown>;
  executeMiddleware: (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => Promise<Response>;
  finalizeHandlerResult: (result: unknown, responseState: ResponseState) => Response;
  handleError: (error: unknown, state: RawExecutionState | RawResponseExecutionState, responseState: ResponseState) => Response | Promise<Response>;
  useRequestUrl?: boolean;
}) {
  return async (request: Request, params: Record<string, string>) => {
    const requestUrl = input.useRequestUrl ? request.url : '';
    const state = input.createState(request, params);
    const responseState = state.getResponseState();
    const loadBodyPayload = input.createBodyPayloadLoader
      ? input.createBodyPayloadLoader(state.getJsonBody, state.setBodyPayload)
      : undefined;
    const finalize = (value: unknown, context: ResponseStateAdapter) => input.finalizeHandlerResult(value, context as ResponseState);

    try {
      await input.ensureGuardsAllowed?.(request, params);

      const next = () => finalizeRawResult(
        input.executeHandler({
          loadBodyPayload,
          params,
          request,
          requestUrl,
          responseState,
        }),
        responseState,
        finalize,
      );

      const resolvedDirectResult = await input.executeMiddleware(request, params, responseState, next);
      return resolveRawMiddlewareResult(resolvedDirectResult, state, finalize);
    } catch (error) {
      return input.handleError(error, state, responseState);
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

export function createSpecializedRawHandlerBodyExecutor(input: {
  createBodyPayloadLoader: DeferredPayloadLoaderFactory<unknown>;
  createState: (request: Request, params: Record<string, string>) => RawExecutionState | RawResponseExecutionState;
  ensureGuardsAllowed: ((request: Request, params: Record<string, string>) => void | Promise<void>) | undefined;
  executeHandler: (bodyPayload: unknown, params: Record<string, string>) => unknown | PromiseLike<unknown>;
  executeMiddleware: (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => Promise<Response>;
  finalizeHandlerResult: (result: unknown, responseState: ResponseState) => Response;
  handleError: (error: unknown, state: RawExecutionState | RawResponseExecutionState, responseState: ResponseState) => Response | Promise<Response>;
}) {
  return createSpecializedRawHandlerExecutor({
    createBodyPayloadLoader: input.createBodyPayloadLoader,
    createState: input.createState,
    ensureGuardsAllowed: input.ensureGuardsAllowed,
    executeMiddleware: input.executeMiddleware,
    executeHandler: async ({ loadBodyPayload, params }) => input.executeHandler(await loadBodyPayload!(), params),
    finalizeHandlerResult: input.finalizeHandlerResult,
    handleError: input.handleError,
  });
}

export function compileRouteExecutor<TSchema>(input: {
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
  const hasContextParameter = input.route.parameters.some((parameter) => parameter.source === 'context');
  const hasBodyParameter = input.route.parameters.some((parameter) => parameter.source === 'body');
  const hasPathParameter = input.route.parameters.some((parameter) => parameter.source === 'path');
  const hasQueryParameter = input.route.parameters.some((parameter) => parameter.source === 'query');
  const hasSingleBodyParameter = input.route.parameters.length === 1
    && input.route.parameters[0]?.index === 0
    && input.route.parameters[0]?.source === 'body';
  const requiresQueryObject = Boolean(input.route.docs.querySchema) || input.route.parameters.some((parameter) => parameter.source === 'query' && !parameter.name);
  const requiresParamObject = Boolean(input.route.docs.paramSchema) || input.route.parameters.some((parameter) => parameter.source === 'path' && !parameter.name);
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
  const nativeStaticResponse = singletonController
    ? createNativeStaticResponse({
        definition: input.definition,
        handler: singletonController[input.route.methodName] as (...args: unknown[]) => unknown,
        route: input.route,
        target: singletonController,
      })
    : undefined;
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
  const executeSingletonHandler = singletonController && singletonHandler
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
        const result = await executeSingletonHandler(await resolveBodyPayload(request), undefined, undefined, params, undefined, '');
        if (result instanceof Response) {
          return result;
        }

        return finalizeCompiledPlainResult(result);
      }

      const requestUrl = requiresRequestUrl ? request.url : '';
      const paramPayload = resolveParamPayload(params);
      const queryPayload = resolveQueryPayload(requestUrl);

      await ensureRawGuardsAllowed?.(request, params);

      const bodyPayload = await resolveBodyPayload(request);

      if (executeSingletonHandler) {
        const result = await executeSingletonHandler(bodyPayload, undefined, paramPayload, params, queryPayload, requestUrl);
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
        resolveBodyPayload: (request) => resolveBodyPayloadFromJsonLoader(() => request.json()),
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
        resolveBodyPayload: (request) => resolveBodyPayloadFromJsonLoader(() => request.json()),
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

    const response = createUnhandledErrorResponse();

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

    const response = createUnhandledErrorResponse();

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
        executeHandler: ({ params }) => executeSingletonHandler!(undefined, undefined, resolveParamPayload(params), params, undefined, ''),
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
        createBodyPayloadLoader,
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
        createBodyPayloadLoader,
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
        createBodyPayloadLoader,
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
        createBodyPayloadLoader,
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
    ? createSpecializedRawHandlerExecutor({
        ...(requiresBody ? { createBodyPayloadLoader } : {}),
        createState: createRawState,
        ensureGuardsAllowed: ensureSingleRawGuardAllowed,
        executeHandler: async ({ loadBodyPayload, params, requestUrl }) => executeSingletonHandler!(
          loadBodyPayload ? await loadBodyPayload() : undefined,
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
    : undefined;

  const executeWithSingleRawMiddlewareNoInput = singleRawMiddleware && invokeSingleRawMiddleware && !requiresBody && !requiresRequestUrl
    ? createSpecializedRawHandlerExecutor({
        createState: createRawState,
        ensureGuardsAllowed: undefined,
        executeHandler: ({ params }) => executeSingletonHandler!(undefined, undefined, resolveParamPayload(params), params, undefined, ''),
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
        createBodyPayloadLoader,
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
        createBodyPayloadLoader,
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
        createBodyPayloadLoader,
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
        createBodyPayloadLoader,
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
    ? createSpecializedRawHandlerExecutor({
        ...(requiresBody ? { createBodyPayloadLoader } : {}),
        createState: createRawState,
        ensureGuardsAllowed: undefined,
        executeHandler: async ({ loadBodyPayload, params, requestUrl }) => executeSingletonHandler!(
          loadBodyPayload ? await loadBodyPayload() : undefined,
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
    : undefined;

  const executeWithRawPipeline = async (request: Request, params: Record<string, string>) => {
    const requestUrl = requiresRequestUrl ? request.url : '';
    const state = createRawState(request, params);
    const loadBodyPayload = createBodyPayloadLoader(state.getJsonBody, state.setBodyPayload);

    try {
      const paramPayload = resolveParamPayload(params);
      const queryPayload = resolveQueryPayload(requestUrl);

      await ensureRawGuardsAllowed?.(request, params);

      const executeHandler = async () => {
        const bodyPayload = await loadBodyPayload();
        return finalizeRawResult(
          executeSingletonHandler!(bodyPayload, undefined, paramPayload, params, queryPayload, requestUrl),
          state.getResponseState(),
          finalizeCompiledContextResult,
        );
      };

      const directResult = await dispatchRawMiddleware(request, params, state.getResponseState(), executeHandler);

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
          parsedBody = await request.json();
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
        const getBodyPayload = async () => requiresBody ? loadBodyPayload() : undefined;

        const resolvedGuards = guards.requestScoped
          ? resolveCompiledDependencies(guards, getRequestContainer())
          : singletonGuards;
        const resolvedMiddleware = middleware.requestScoped
          ? resolveCompiledDependencies(middleware, getRequestContainer())
          : singletonMiddleware;

        if (singletonGuardsUseRawOnly) {
          for (const guard of singletonGuards) {
            const allowed = await guard.canActivateRaw!(request, params, input.route);
            if (!allowed) {
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
            const bodyPayload = await getBodyPayload();
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

        const executeResolvedHandler = async () => {
          const bodyPayload = await getBodyPayload();
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

        const result = resolvedMiddleware.length > 0
          ? await runMiddlewareChain({
              middleware: resolvedMiddleware,
              context: getContext(),
              defaultSuccessStatus,
              route: input.route,
              execute: executeResolvedHandler,
            })
          : await executeResolvedHandler();

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

        const response = Response.json({ message: 'Internal Server Error' }, { status: 500 });

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
