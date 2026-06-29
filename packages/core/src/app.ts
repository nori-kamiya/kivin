import { Container } from './container';
import { RequestContext, ResponseState } from './context';
import { HttpError } from './http';
import {
  getControllerMetadata,
  getRouteDescriptors,
  type AppDefinition,
  type ParameterMetadata,
  type RouteDescriptor,
} from './metadata';
import { flattenModules } from './module';
import { readNamedQueryParam, readPathname, readQueryObject } from './request-url';
import { createJsonResponse, createJsonResponseCreated, createJsonResponseWithStatus, createNoContentResponse } from './response';
import { Router } from './router';
import type { Constructor, HttpMethod, Token } from './types';

const HTTP_METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const EMPTY_PARAMS = Object.freeze({}) as Record<string, string>;
const RESPONSE_INIT_201 = Object.freeze({ status: 201 }) as ResponseInit;
const RESPONSE_INIT_204 = Object.freeze({ status: 204 }) as ResponseInit;

interface CompiledRoute<TSchema> {
  nativeStaticResponse?: Response;
  route: ManifestRoute<TSchema>;
  execute: (request: Request, params: Record<string, string>) => Promise<Response>;
}

type CompiledRouteExecutor<TSchema> = CompiledRoute<TSchema>['execute'];
 
interface ScopedResolver<T> {
  requestScoped: boolean;
  resolve: (requestContainer?: Container) => T;
}
 
interface CompiledDependencyList<T> {
  requestScoped: boolean;
  singletonInstances: T[];
  entries: Array<
    | { requestScoped: false; instance: T }
    | { requestScoped: true; resolve: (requestContainer: Container) => T }
  >;
}

type BunRouteHandler = (request: Request & { params?: Record<string, string> }) => Response | Promise<Response>;
type BunRouteDefinition = Response | BunRouteHandler | Partial<Record<HttpMethod | 'HEAD' | 'OPTIONS', Response | BunRouteHandler>>;

interface CompiledArgumentInput {
  bodyValue: unknown;
  context: RequestContext | undefined;
  paramValue: unknown;
  params: Record<string, string>;
  queryParam: (name: string) => string | undefined;
  queryValue: unknown;
}

type CompiledArgumentResolver = (input: CompiledArgumentInput) => unknown[];
type CompiledHandlerInvoker = (
  controller: Record<string, unknown>,
  handler: (...args: unknown[]) => unknown,
  input: CompiledArgumentInput,
) => unknown;
type CompiledHandlerArgumentGetter = (
  bodyValue: unknown,
  context: RequestContext | undefined,
  paramValue: unknown,
  params: Record<string, string>,
  queryValue: unknown,
  requestUrl: string,
) => unknown;
type CompiledHandlerExecutor = (
  bodyValue: unknown,
  context: RequestContext | undefined,
  paramValue: unknown,
  params: Record<string, string>,
  queryValue: unknown,
  requestUrl: string,
) => unknown;
type CompiledParamPayloadResolver = (params: Record<string, string>) => unknown;
type CompiledQueryPayloadResolver = (requestUrl: string) => unknown;
type CompiledBodyPayloadResolver = (request: Request) => Promise<unknown> | unknown;
type CompiledBodyPayloadFromJsonLoaderResolver = (getJsonBody: () => Promise<unknown>) => Promise<unknown> | unknown;
type DeferredPayloadLoader<T> = () => Promise<T>;
type DeferredPayloadLoaderFactory<T> = (getJsonBody: () => Promise<unknown>, onResolved?: (value: T) => void) => DeferredPayloadLoader<T>;
type NextResponseFactory = () => Response | PromiseLike<Response>;
type ResponseStateAdapter = Pick<RequestContext, 'applyResponseHeaders' | 'hasQueuedNoContentResponse' | 'hasQueuedResponseState' | 'noContent' | 'respond' | 'respondDefaultCreated'>;
type RawGuardInvoker = (request: Request, params: Record<string, string>) => boolean | Promise<boolean>;
type RawGuardSyncInvoker = (request: Request, params: Record<string, string>) => boolean;
type RawMiddlewareInvoker = (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => Response | PromiseLike<Response>;

interface RawExecutionState {
  applyQueuedState: (response: Response) => Response;
  getContext: () => RequestContext;
  getJsonBody: () => Promise<unknown>;
  getResponseState: () => ResponseState;
  setBodyPayload: (value: unknown) => void;
}

interface RawResponseExecutionState {
  applyQueuedState: (response: Response) => Response;
  getJsonBody: () => Promise<unknown>;
  getResponseState: () => ResponseState;
  setBodyPayload: (value: unknown) => void;
}

type RouteFilters = Array<{ catch: (error: unknown, context: RequestContext, route: ManifestRoute<unknown>) => Response | void | Promise<Response | void> }>;
type RouteMiddleware = Array<{ handle?: (context: RequestContext, next: NextResponseFactory, route: ManifestRoute<unknown>) => Response | PromiseLike<Response>; handleRaw?: (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory, route: ManifestRoute<unknown>) => Response | PromiseLike<Response>; use?: (context: RequestContext, next: NextResponseFactory, route: ManifestRoute<unknown>) => Response | PromiseLike<Response>; useRaw?: (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory, route: ManifestRoute<unknown>) => Response | PromiseLike<Response> }>;
type RouteGuards = Array<{
  canActivate: (context: RequestContext, route: ManifestRoute<unknown>) => boolean | Promise<boolean>;
  canActivateRaw?: (request: Request, params: Record<string, string>, route: ManifestRoute<unknown>) => boolean | Promise<boolean>;
}>;

export interface ManifestRoute<TSchema = unknown> {
  method: HttpMethod;
  fullPath: string;
  controller: Constructor;
  methodName: string;
  parameters: ParameterMetadata[];
  guards: Token[];
  middleware: Token[];
  filters: Token[];
  docs: {
    summary?: string;
    description?: string;
    operationId?: string;
    tags: string[];
    bodySchema?: TSchema;
    querySchema?: TSchema;
    paramSchema?: TSchema;
    security: Array<{ scheme: string; scopes: string[] }>;
    responses: Array<{ status: number; description: string; schema?: TSchema }>;
  };
}

export interface AppManifest<TSchema = unknown> {
  routes: ManifestRoute<TSchema>[];
}

function joinPaths(basePath: string, routePath: string): string {
  const cleanedBase = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const cleanedRoute = routePath === '/' ? '' : routePath.replace(/^\//, '');
  const combined = `${cleanedBase}/${cleanedRoute}`.replace(/\/+/g, '/');
  return combined || '/';
}

function validateOrThrow<TSchema>(
  schemaAdapter: AppDefinition<TSchema>['schemaAdapter'],
  schema: TSchema | undefined,
  input: unknown,
  label: string,
) {
  if (!schema) {
    return input;
  }

  const result = schemaAdapter.parse(schema, input);
  if (!result.success) {
    throw new Response(JSON.stringify({ message: `${label} validation failed`, issues: result.issues }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  return result.output;
}

function createValidationErrorResponse(label: string, issues: unknown) {
  return new Response(JSON.stringify({ message: `${label} validation failed`, issues }), {
    status: 400,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function createSchemaValidator<TSchema>(
  definition: AppDefinition<TSchema>,
  schema: TSchema,
  label: string,
) {
  return (input: unknown) => {
    const result = definition.schemaAdapter.parse(schema, input);
    if (!result.success) {
      throw createValidationErrorResponse(label, result.issues);
    }

    return result.output;
  };
}

function mapLoadedValue<TInput, TOutput>(value: PromiseLike<TInput> | TInput, map: (input: TInput) => TOutput): PromiseLike<TOutput> | TOutput {
  return isPromiseLike<TInput>(value) ? value.then(map) : map(value);
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | null | undefined)?.then === 'function';
}

function isAsyncFunction(value: unknown) {
  return typeof value === 'function' && value.constructor.name === 'AsyncFunction';
}

function createResponseBodyMapper<TSchema>(definition: AppDefinition<TSchema>, route: ManifestRoute<TSchema>) {
  const successResponseSchema = route.docs.responses.find((response) => response.status >= 200 && response.status < 300 && response.schema)?.schema;
  if (!successResponseSchema) {
    return undefined;
  }

  return createSchemaValidator(definition, successResponseSchema, 'response');
}

function getDefaultSuccessStatus<TSchema>(route: ManifestRoute<TSchema>) {
  const statuses = [...new Set(route.docs.responses
    .filter((response) => response.status >= 200 && response.status < 300)
    .map((response) => response.status))];

  return statuses.length === 1 ? statuses[0] : undefined;
}

function createArgumentResolver(parameters: ParameterMetadata[]): CompiledArgumentResolver {
  if (parameters.length === 0) {
    return () => [];
  }

  const length = Math.max(...parameters.map((parameter) => parameter.index)) + 1;

  return (input) => {
    const resolved = new Array<unknown>(length);

    for (const parameter of parameters) {
      resolved[parameter.index] = resolveParameterValue(parameter, input);
    }

    return resolved;
  };
}

function resolveParameterValue(parameter: ParameterMetadata, input: CompiledArgumentInput) {
  switch (parameter.source) {
    case 'context':
      return input.context;
    case 'body':
      return input.bodyValue;
    case 'query':
      if (parameter.name) {
        if (typeof input.queryValue === 'object' && input.queryValue) {
          return (input.queryValue as Record<string, unknown>)[parameter.name];
        }

        return input.queryParam(parameter.name);
      }

      return input.queryValue;
    case 'path':
      if (parameter.name) {
        if (typeof input.paramValue === 'object' && input.paramValue) {
          return (input.paramValue as Record<string, unknown>)[parameter.name];
        }

        return input.params[parameter.name];
      }

      return input.paramValue;
  }
}

function createCompiledArgumentGetter(parameter: ParameterMetadata): CompiledHandlerArgumentGetter {
  switch (parameter.source) {
    case 'context':
      return (_bodyValue, context) => context;
    case 'body':
      return (bodyValue) => bodyValue;
    case 'query':
      if (parameter.name) {
        return (_bodyValue, _context, _paramValue, _params, queryValue, requestUrl) => {
          if (typeof queryValue === 'object' && queryValue) {
            return (queryValue as Record<string, unknown>)[parameter.name!];
          }

          return readNamedQueryParam(requestUrl, parameter.name!);
        };
      }

      return (_bodyValue, _context, _paramValue, _params, queryValue) => queryValue;
    case 'path':
      if (parameter.name) {
        return (_bodyValue, _context, paramValue, params) => {
          if (typeof paramValue === 'object' && paramValue) {
            return (paramValue as Record<string, unknown>)[parameter.name!];
          }

          return params[parameter.name!];
        };
      }

      return (_bodyValue, _context, paramValue) => paramValue;
  }
}

function createHandlerInvoker(parameters: ParameterMetadata[]): CompiledHandlerInvoker | undefined {
  if (parameters.length === 0 || parameters.length > 4) {
    return undefined;
  }

  const sortedParameters = [...parameters].sort((left, right) => left.index - right.index);
  if (!sortedParameters.every((parameter, index) => parameter.index === index)) {
    return undefined;
  }

  if (sortedParameters.length === 1) {
    return (controller, handler, input) => handler.call(controller, resolveParameterValue(sortedParameters[0]!, input));
  }

  if (sortedParameters.length === 2) {
    return (controller, handler, input) => handler.call(
      controller,
      resolveParameterValue(sortedParameters[0]!, input),
      resolveParameterValue(sortedParameters[1]!, input),
    );
  }

  if (sortedParameters.length === 3) {
    return (controller, handler, input) => handler.call(
      controller,
      resolveParameterValue(sortedParameters[0]!, input),
      resolveParameterValue(sortedParameters[1]!, input),
      resolveParameterValue(sortedParameters[2]!, input),
    );
  }

  return (controller, handler, input) => handler.call(
    controller,
    resolveParameterValue(sortedParameters[0]!, input),
    resolveParameterValue(sortedParameters[1]!, input),
    resolveParameterValue(sortedParameters[2]!, input),
    resolveParameterValue(sortedParameters[3]!, input),
  );
}

function createCompiledHandlerExecutor(input: {
  controller: Record<string, unknown>;
  handler: (...args: unknown[]) => unknown;
  invokeHandler: CompiledHandlerInvoker | undefined;
  parameterCount: number;
  resolveArguments: CompiledArgumentResolver;
  parameters: ParameterMetadata[];
}): CompiledHandlerExecutor {
  const { controller, handler, invokeHandler, parameterCount, resolveArguments } = input;
  const sortedParameters = input.parameters
    .slice()
    .sort((left, right) => left.index - right.index);

  if (
    parameterCount === 1
    && sortedParameters[0]?.index === 0
    && sortedParameters[0]?.source === 'body'
  ) {
    return (bodyValue) => handler.call(controller, bodyValue);
  }

  if (
    parameterCount === 2
    && sortedParameters[0]?.index === 0
    && sortedParameters[0]?.source === 'path'
    && sortedParameters[0]?.name
    && sortedParameters[1]?.index === 1
    && sortedParameters[1]?.source === 'body'
  ) {
    const pathName = sortedParameters[0].name;
    return (bodyValue, _context, paramValue, params) => handler.call(
      controller,
      typeof paramValue === 'object' && paramValue
        ? (paramValue as Record<string, unknown>)[pathName]
        : params[pathName],
      bodyValue,
    );
  }

  const getters = sortedParameters.map((parameter) => createCompiledArgumentGetter(parameter));

  return (bodyValue, context, paramValue, params, queryValue, requestUrl) => {
    if (parameterCount === 0) {
      return handler.call(controller);
    }

    if (parameterCount === 1) {
      return handler.call(controller, getters[0]!(bodyValue, context, paramValue, params, queryValue, requestUrl));
    }

    if (parameterCount === 2) {
      return handler.call(
        controller,
        getters[0]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[1]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
      );
    }

    if (parameterCount === 3) {
      return handler.call(
        controller,
        getters[0]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[1]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[2]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
      );
    }

    if (parameterCount === 4) {
      return handler.call(
        controller,
        getters[0]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[1]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[2]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[3]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
      );
    }

    if (invokeHandler) {
      return invokeHandler(controller, handler, {
        bodyValue,
        context,
        paramValue,
        params,
        queryParam: (name) => readNamedQueryParam(requestUrl, name),
        queryValue,
      });
    }

    return handler.apply(controller, resolveArguments({
      bodyValue,
      context,
      paramValue,
      params,
      queryParam: (name) => readNamedQueryParam(requestUrl, name),
      queryValue,
    }));
  };
}

function normalizeRoutePath(path: string) {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  return path.replace(/\/$/, '') || '/';
}

function createExactRouteLookup<TSchema>(compiledRoutes: CompiledRoute<TSchema>[]) {
  const lookup = new Map<HttpMethod, Map<string, CompiledRoute<TSchema>>>();

  for (const compiledRoute of compiledRoutes) {
    if (compiledRoute.route.fullPath.includes(':')) {
      continue;
    }

    let methodRoutes = lookup.get(compiledRoute.route.method);
    if (!methodRoutes) {
      methodRoutes = new Map<string, CompiledRoute<TSchema>>();
      lookup.set(compiledRoute.route.method, methodRoutes);
    }

    methodRoutes.set(normalizeRoutePath(compiledRoute.route.fullPath), compiledRoute);
  }

  return lookup;
}

function createStaticAllowedMethodsLookup<TSchema>(compiledRoutes: CompiledRoute<TSchema>[]) {
  const lookup = new Map<string, HttpMethod[]>();

  for (const compiledRoute of compiledRoutes) {
    if (compiledRoute.route.fullPath.includes(':')) {
      continue;
    }

    const path = normalizeRoutePath(compiledRoute.route.fullPath);
    const methods = lookup.get(path);
    if (methods) {
      methods.push(compiledRoute.route.method);
      continue;
    }

    lookup.set(path, [compiledRoute.route.method]);
  }

  return lookup;
}

export function buildManifest<TSchema>(definition: AppDefinition<TSchema>): AppManifest<TSchema> {
  const routes: ManifestRoute<TSchema>[] = [];
  const modules = flattenModules(definition.modules);
  const seenControllers = new Set<Constructor>();

  for (const moduleDefinition of modules) {
    for (const controller of moduleDefinition.controllers) {
      if (seenControllers.has(controller)) {
        continue;
      }
      seenControllers.add(controller);

      const controllerMetadata = getControllerMetadata(controller);
      if (!controllerMetadata) {
        throw new Error(`Controller metadata is missing for ${controller.name}`);
      }

      for (const descriptor of getRouteDescriptors(controller)) {
        routes.push(buildRoute(controller, controllerMetadata, descriptor));
      }
    }
  }

  return { routes };
}

function buildRoute<TSchema>(
  controller: Constructor,
  controllerMetadata: { basePath: string; tags: string[]; guards: Token[]; middleware: Token[]; filters: Token[] },
  descriptor: RouteDescriptor,
): ManifestRoute<TSchema> {
  return {
    method: descriptor.route.method,
    fullPath: joinPaths(controllerMetadata.basePath, descriptor.route.path),
    controller,
    methodName: descriptor.methodName,
    parameters: descriptor.parameters,
    guards: [...new Set([...controllerMetadata.guards, ...descriptor.enhancers.guards])],
    middleware: [...new Set([...controllerMetadata.middleware, ...descriptor.enhancers.middleware])],
    filters: [...new Set([...controllerMetadata.filters, ...descriptor.enhancers.filters])],
    docs: {
      ...descriptor.docs,
      tags: [...new Set([...controllerMetadata.tags, ...descriptor.docs.tags])],
    } as ManifestRoute<TSchema>['docs'],
  };
}

export function createApp<TSchema>(definition: AppDefinition<TSchema>, manifest: AppManifest<TSchema>) {
  const container = new Container();
  const router = new Router<CompiledRoute<TSchema>>();
  const compiledRoutes: CompiledRoute<TSchema>[] = [];
  const modules = flattenModules(definition.modules);

  for (const moduleDefinition of modules) {
    for (const provider of moduleDefinition.providers) {
      container.register(provider);
    }
    for (const controller of moduleDefinition.controllers) {
      if (!container.hasLocalProvider(controller)) {
        container.register(controller);
      }
    }
  }

  for (const route of manifest.routes) {
    const compiledRoute = compileRouteExecutor({
      container,
      definition,
      globalFilterTokens: definition.globals?.filters ?? [],
      globalGuardTokens: definition.globals?.guards ?? [],
      globalMiddlewareTokens: definition.globals?.middleware ?? [],
      route,
    });

    compiledRoutes.push(compiledRoute);
    router.register(route.method, route.fullPath, compiledRoute);
  }

  const exactRoutes = createExactRouteLookup(compiledRoutes);
  const staticAllowedMethods = createStaticAllowedMethodsLookup(compiledRoutes);

  const fetch = async (request: Request): Promise<Response> => {
    const isHeadRequest = request.method === 'HEAD';
    const path = normalizeRoutePath(readPathname(request.url));
    const exactMethodMatch = exactRoutes.get(request.method as HttpMethod)?.get(path);
    const exactGetMatch = isHeadRequest ? exactRoutes.get('GET')?.get(path) : undefined;
    const exactMatch = exactMethodMatch ?? exactGetMatch;

    if (exactMatch) {
      const response = exactMatch.nativeStaticResponse
        ? exactMatch.nativeStaticResponse.clone()
        : await exactMatch.execute(request, EMPTY_PARAMS);

      return isHeadRequest ? toHeadResponse(response) : response;
    }

    const staticAllowed = staticAllowedMethods.get(path);
    if (staticAllowed && staticAllowed.length > 0) {
      const allowedMethods = getAllowedMethodsForList(staticAllowed);
      const response = request.method === 'OPTIONS'
        ? new Response(null, { status: 204, headers: { allow: allowedMethods.join(', ') } })
        : new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
            status: 405,
            headers: {
              allow: allowedMethods.join(', '),
              'content-type': 'application/json; charset=utf-8',
            },
          });

      return isHeadRequest ? toHeadResponse(response) : response;
    }

    const matched = isHeadRequest
      ? (router.match(request.method, path) ?? router.match('GET', path))
      : router.match(request.method, path);

    if (!matched) {
      const allowedMethods = getAllowedMethods(router, path);
      if (allowedMethods.length > 0) {
        const response = request.method === 'OPTIONS'
          ? new Response(null, { status: 204, headers: { allow: allowedMethods.join(', ') } })
          : new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
              status: 405,
              headers: {
                allow: allowedMethods.join(', '),
                'content-type': 'application/json; charset=utf-8',
              },
            });
        return isHeadRequest ? toHeadResponse(response) : response;
      }

      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const response = await matched.data.execute(request, matched.params);
    return isHeadRequest ? toHeadResponse(response) : response;
  };

  return {
    fetch,
    listen(port: number) {
      return Bun.serve({
        port,
        routes: createBunServeRoutes(compiledRoutes),
        fetch,
      });
    },
  };
}

function createBunServeRoutes<TSchema>(compiledRoutes: CompiledRoute<TSchema>[]): Record<string, BunRouteDefinition> {
  const routes: Record<string, BunRouteDefinition> = {};
  const routeMethods = new Map<string, Set<HttpMethod>>();

  for (const compiledRoute of compiledRoutes) {
    const { fullPath, method } = compiledRoute.route;
    let methods = routeMethods.get(fullPath);
    if (!methods) {
      methods = new Set<HttpMethod>();
      routeMethods.set(fullPath, methods);
    }
    methods.add(method);

    const handler: BunRouteHandler = (request) => compiledRoute.execute(request, request.params ?? {});
    const current = routes[fullPath];
    const routeValue = compiledRoute.nativeStaticResponse ? compiledRoute.nativeStaticResponse.clone() : handler;

    if (!current) {
      routes[fullPath] = { [method]: routeValue };
      continue;
    }

    if (current instanceof Response || typeof current === 'function') {
      routes[fullPath] = { [method]: routeValue };
      continue;
    }

    current[method] = routeValue;
  }

  for (const compiledRoute of compiledRoutes) {
    if (compiledRoute.route.method !== 'GET') {
      continue;
    }

    const methods = routeMethods.get(compiledRoute.route.fullPath);
    if (!methods || methods.has('HEAD')) {
      continue;
    }

    const current = routes[compiledRoute.route.fullPath];
    if (!current || current instanceof Response || typeof current === 'function') {
      continue;
    }

    current.HEAD = compiledRoute.nativeStaticResponse
      ? toHeadResponse(compiledRoute.nativeStaticResponse.clone())
      : async (request) => toHeadResponse(await compiledRoute.execute(request, request.params ?? {}));
  }

  return routes;
}

function createScopedResolver<T>(input: {
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

function compileDependencyList<T>(resolvers: ScopedResolver<T>[]): CompiledDependencyList<T> {
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

function resolveCompiledDependencies<T>(compiled: CompiledDependencyList<T>, requestContainer?: Container): T[] {
  if (!compiled.requestScoped) {
    return compiled.singletonInstances;
  }

  return compiled.entries.map((entry) => entry.requestScoped ? entry.resolve(requestContainer as Container) : entry.instance);
}

function compileGuards(container: Container, tokens: Token[]): CompiledDependencyList<RouteGuards[number]> {
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

function compileMiddleware(container: Container, tokens: Token[]): CompiledDependencyList<RouteMiddleware[number]> {
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

function compileFilters(container: Container, tokens: Token[]): CompiledDependencyList<RouteFilters[number]> {
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

async function enforceGuards(input: {
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

async function runMiddlewareChain(input: {
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

function mapUnknownToResponse(result: unknown, context: ResponseStateAdapter, defaultSuccessStatus?: number) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && (context.hasQueuedNoContentResponse() || defaultSuccessStatus === 204)) {
    return context.noContent();
  }

  return defaultSuccessStatus === undefined
    ? context.respond(result)
    : context.respond(result, { status: defaultSuccessStatus });
}

function finalizeContextResult(
  result: unknown,
  context: ResponseStateAdapter,
  mapCompiledResponseBody: ((value: unknown) => unknown) | undefined,
  defaultSuccessStatus?: number,
) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && (context.hasQueuedNoContentResponse() || defaultSuccessStatus === 204)) {
    return context.noContent();
  }

  const validated = mapCompiledResponseBody ? mapCompiledResponseBody(result) : result;
  if (defaultSuccessStatus === 201) {
    return context.respondDefaultCreated(validated);
  }

  return defaultSuccessStatus === undefined
    ? context.respond(validated)
    : context.respond(validated, { status: defaultSuccessStatus });
}

function finalizeResultWithoutContext(
  result: unknown,
  mapCompiledResponseBody: ((value: unknown) => unknown) | undefined,
  defaultSuccessStatus?: number,
) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && defaultSuccessStatus === 204) {
    return createNoContentResponse();
  }

  const validated = mapCompiledResponseBody ? mapCompiledResponseBody(result) : result;
  return defaultSuccessStatus === undefined
    ? createJsonResponse(validated)
    : createJsonResponseWithStatus(validated, defaultSuccessStatus);
}

function createParamPayloadResolver<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresParamObject: boolean,
): CompiledParamPayloadResolver {
  if (route.docs.paramSchema) {
    const validateParams = createSchemaValidator(definition, route.docs.paramSchema, 'params');
    return (params) => validateParams(params);
  }

  if (requiresParamObject) {
    return (params) => params;
  }

  return () => undefined;
}

function createQueryPayloadResolver<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresQueryObject: boolean,
): CompiledQueryPayloadResolver {
  if (route.docs.querySchema) {
    const validateQuery = createSchemaValidator(definition, route.docs.querySchema, 'query');
    return (requestUrl) => validateQuery(readQueryObject(requestUrl));
  }

  if (requiresQueryObject) {
    return (requestUrl) => readQueryObject(requestUrl);
  }

  return () => undefined;
}

function createBodyPayloadResolver<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresBody: boolean,
): CompiledBodyPayloadResolver {
  if (!requiresBody || route.method === 'GET' || route.method === 'HEAD') {
    return () => undefined;
  }

  if (route.docs.bodySchema) {
    const bodySchema = route.docs.bodySchema;
    const validateBody = createSchemaValidator(definition, bodySchema, 'body');
    return (request) => mapLoadedValue(request.json(), validateBody);
  }

  return (request) => request.json();
}

function createDeferredPayloadLoader<T>(load: () => Promise<T> | T, onResolved?: (value: T) => void): DeferredPayloadLoader<T> {
  let pending: Promise<T> | undefined;

  return () => {
    if (!pending) {
      const loaded = load();
      pending = isPromiseLike<T>(loaded)
        ? loaded.then((value) => {
            onResolved?.(value);
            return value;
          })
        : Promise.resolve((onResolved?.(loaded), loaded));
    }

    return pending;
  };
}

function createDeferredMappedJsonPayloadLoader<T>(
  getJsonBody: () => Promise<unknown>,
  mapValue: (value: unknown) => T,
  onResolved?: (value: T) => void,
): DeferredPayloadLoader<T> {
  let pending: Promise<T> | undefined;

  return () => {
    if (!pending) {
      pending = getJsonBody().then((value) => {
        const mapped = mapValue(value);
        onResolved?.(mapped);
        return mapped;
      });
    }

    return pending;
  };
}

function createRawExecutionState(
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
      parsedBody = await request.json();
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

function createRawResponseExecutionState(request: Request): RawResponseExecutionState {
  let parsedBody: unknown;
  let parsedBodyLoaded = false;
  const responseState = new ResponseState();

  const getJsonBody = async () => {
    if (!parsedBodyLoaded) {
      parsedBody = await request.json();
      parsedBodyLoaded = true;
    }

    return parsedBody;
  };

  return {
    applyQueuedState(response: Response) {
      return responseState.hasQueuedResponseState()
        ? responseState.applyResponseHeaders(response)
        : response;
    },
    getJsonBody,
    getResponseState: () => responseState,
    setBodyPayload(value: unknown) {
      parsedBody = value;
      parsedBodyLoaded = true;
    },
  };
}

function getDefaultSuccessResponseInit(status: number | undefined): ResponseInit | undefined {
  if (status === undefined) {
    return undefined;
  }

  if (status === 201) {
    return RESPONSE_INIT_201;
  }

  if (status === 204) {
    return RESPONSE_INIT_204;
  }

  return { status };
}

function finalizeDefaultCreatedContextResult(result: unknown, context: ResponseStateAdapter) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && context.hasQueuedNoContentResponse()) {
    return context.noContent();
  }

  return context.respondDefaultCreated(result);
}

function finalizeDefaultCreatedRawResult(result: unknown, responseState: ResponseState) {
  if (result instanceof Response) {
    return result;
  }

  return responseState.respondDefaultCreated(result);
}

function finalizeDefaultOkContextResult(result: unknown, context: ResponseStateAdapter) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && context.hasQueuedNoContentResponse()) {
    return context.noContent();
  }

  return context.respond(result);
}

function finalizeDefaultOkRawResult(result: unknown, responseState: ResponseState) {
  if (result instanceof Response) {
    return result;
  }

  return responseState.respondDefaultOk(result);
}

function finalizeDefaultCreatedPlainResult(result: unknown) {
  if (result instanceof Response) {
    return result;
  }

  return createJsonResponseCreated(result);
}

function finalizeRawResult(
  result: Response | PromiseLike<Response> | unknown,
  responseState: ResponseStateAdapter,
  finalize: (value: unknown, context: ResponseStateAdapter) => Response,
) {
  if (isPromiseLike<unknown>(result)) {
    return result.then((resolved) => finalize(resolved, responseState));
  }

  return finalize(result, responseState);
}

function createSingleRawGuardAllowChecker(
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

function createResolvedRawMiddlewareInvoker(invokeRawMiddleware: RawMiddlewareInvoker | undefined) {
  if (!invokeRawMiddleware) {
    return undefined;
  }

  return async (
    request: Request,
    params: Record<string, string>,
    responseState: ResponseState,
    next: NextResponseFactory,
  ) => {
    const result = invokeRawMiddleware(request, params, responseState, next);
    return isPromiseLike<Response>(result)
      ? await result
      : result;
  };
}

function createRawGuardsAllowChecker(
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

function createRawMiddlewareDispatcher(
  singleRawMiddlewareInvoker: ((request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => Promise<Response>) | undefined,
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


function resolveRawMiddlewareResult(
  result: unknown,
  state: RawExecutionState | RawResponseExecutionState,
  finalize: (value: unknown, context: ResponseStateAdapter) => Response,
) {
  if (result instanceof Response) {
    return state.applyQueuedState(result);
  }

  return finalize(result, state.getResponseState());
}


async function applyFilters(
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

function createUnhandledErrorResponse() {
  return new Response(JSON.stringify({ message: 'Internal Server Error' }), {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function describeToken(token: Token) {
  return typeof token === 'function' ? token.name : String(token);
}

function getAllowedMethods<TSchema>(router: Router<CompiledRoute<TSchema>>, path: string) {
  return getAllowedMethodsForList(router.allowedMethods(path));
}

function getAllowedMethodsForList(methodList: HttpMethod[]) {
  const methods = new Set<HttpMethod | 'HEAD' | 'OPTIONS'>(methodList);
  if (methods.size === 0) {
    return [];
  }

  if (methods.has('GET')) {
    methods.add('HEAD');
  }

  methods.add('OPTIONS');

  return HTTP_METHOD_ORDER.filter((method) => methods.has(method));
}

function toHeadResponse(response: Response) {
  const headers = new Headers(response.headers);
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function canPrecomputeNativeStaticResponse<TSchema>(route: ManifestRoute<TSchema>) {
  if (route.method !== 'GET') {
    return false;
  }

  if (route.parameters.length > 0 || route.guards.length > 0 || route.middleware.length > 0 || route.filters.length > 0) {
    return false;
  }

  if (route.docs.bodySchema || route.docs.querySchema || route.docs.paramSchema) {
    return false;
  }

  return !route.docs.responses.some((response) => response.schema);
}

function createNativeStaticResponse<TSchema>(input: {
  definition: AppDefinition<TSchema>;
  handler: (...args: unknown[]) => unknown;
  route: ManifestRoute<TSchema>;
  target: unknown;
}): Response | undefined {
  if (!canPrecomputeNativeStaticResponse(input.route)) {
    return undefined;
  }

  const mapResponseBody = createResponseBodyMapper(input.definition, input.route);

  try {
    const result = input.handler.apply(input.target, []);
    if (typeof (result as Promise<unknown> | undefined)?.then === 'function') {
      return undefined;
    }

    if (result instanceof Response) {
      return result.clone();
    }

    const validated = mapResponseBody ? mapResponseBody(result) : result;
    return createJsonResponse(validated);
  } catch {
    return undefined;
  }
}

function createBodyPayloadFromJsonLoaderResolver<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresBody: boolean,
): CompiledBodyPayloadFromJsonLoaderResolver {
  if (!requiresBody || route.method === 'GET' || route.method === 'HEAD') {
    return () => undefined;
  }

  if (route.docs.bodySchema) {
    const bodySchema = route.docs.bodySchema;
    const validateBody = createSchemaValidator(definition, bodySchema, 'body');
    return (getJsonBody) => mapLoadedValue(getJsonBody(), validateBody);
  }

  return (getJsonBody) => getJsonBody();
}

function createBodyPayloadLoaderFactory<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresBody: boolean,
): DeferredPayloadLoaderFactory<unknown> {
  if (!requiresBody || route.method === 'GET' || route.method === 'HEAD') {
    return (_getJsonBody, onResolved) => createDeferredPayloadLoader(() => undefined, onResolved);
  }

  if (route.docs.bodySchema) {
    const validateBody = createSchemaValidator(definition, route.docs.bodySchema, 'body');
    return (getJsonBody, onResolved) => createDeferredMappedJsonPayloadLoader(getJsonBody, validateBody, onResolved);
  }

  return (getJsonBody, onResolved) => createDeferredPayloadLoader(getJsonBody, onResolved);
}

function createCompiledRouteWithExecutor<TSchema>(
  route: ManifestRoute<TSchema>,
  execute: CompiledRouteExecutor<TSchema>,
): CompiledRoute<TSchema> {
  return {
    route,
    execute,
  };
}

function selectCompiledRouteExecutor<TSchema>(
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

function createSpecializedRawBodyExecutor(input: {
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

function createSpecializedRawHandlerExecutor(input: {
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

function createSpecializedPlainHandlerExecutor(input: {
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

function handlePlainExecutionError(error: unknown) {
  if (error instanceof HttpError) {
    return error.toResponse();
  }

  if (error instanceof Response) {
    return error;
  }

  return createUnhandledErrorResponse();
}

function createSpecializedRawHandlerBodyExecutor(input: {
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

function compileRouteExecutor<TSchema>(input: {
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

        const response = new Response(JSON.stringify({ message: 'Internal Server Error' }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });

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
