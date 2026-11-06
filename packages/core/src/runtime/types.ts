// Shared runtime types and constants: the manifest shape, compiled-route shapes and Bun route types.
import type { Container } from '../container';
import type { RequestContext, ResponseState } from '../context';
import type { ParameterMetadata } from '../metadata';
import type { Constructor, HttpMethod, Token } from '../types';

export const HTTP_METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export const EMPTY_PARAMS = Object.freeze({}) as Record<string, string>;

export const RESPONSE_INIT_201 = Object.freeze({ status: 201 }) as ResponseInit;

export const RESPONSE_INIT_204 = Object.freeze({ status: 204 }) as ResponseInit;

export interface CompiledRoute<TSchema> {
  nativeStaticResponse?: Response;
  route: ManifestRoute<TSchema>;
  execute: (request: Request, params: Record<string, string>) => Promise<Response>;
  /** True when the executor came from a generated (`kivin generate`) AOT factory. */
  aot?: boolean;
}

export type CompiledRouteExecutor<TSchema> = CompiledRoute<TSchema>['execute'];

export interface ScopedResolver<T> {
  requestScoped: boolean;
  resolve: (requestContainer?: Container) => T;
}

export interface CompiledDependencyList<T> {
  requestScoped: boolean;
  singletonInstances: T[];
  entries: Array<
    | { requestScoped: false; instance: T }
    | { requestScoped: true; resolve: (requestContainer: Container) => T }
  >;
}

export type BunRouteHandler = (request: Request & { params?: Record<string, string> }) => Response | Promise<Response>;

export type BunRouteDefinition = Response | BunRouteHandler | Partial<Record<HttpMethod | 'HEAD' | 'OPTIONS', Response | BunRouteHandler>>;

export interface CompiledArgumentInput {
  bodyValue: unknown;
  context: RequestContext | undefined;
  paramValue: unknown;
  params: Record<string, string>;
  queryParam: (name: string) => string | undefined;
  queryValue: unknown;
}

export type CompiledArgumentResolver = (input: CompiledArgumentInput) => unknown[];

export type CompiledHandlerInvoker = (
  controller: Record<string, unknown>,
  handler: (...args: unknown[]) => unknown,
  input: CompiledArgumentInput,
) => unknown;

export type CompiledHandlerArgumentGetter = (
  bodyValue: unknown,
  context: RequestContext | undefined,
  paramValue: unknown,
  params: Record<string, string>,
  queryValue: unknown,
  requestUrl: string,
) => unknown;

export type CompiledHandlerExecutor = (
  bodyValue: unknown,
  context: RequestContext | undefined,
  paramValue: unknown,
  params: Record<string, string>,
  queryValue: unknown,
  requestUrl: string,
) => unknown;

export type CompiledParamPayloadResolver = (params: Record<string, string>) => unknown;

export type CompiledQueryPayloadResolver = (requestUrl: string) => unknown;

export type CompiledBodyPayloadResolver = (request: Request) => Promise<unknown> | unknown;

export type CompiledBodyPayloadFromJsonLoaderResolver = (getJsonBody: () => Promise<unknown>) => Promise<unknown> | unknown;

export type DeferredPayloadLoader<T> = () => Promise<T>;

export type DeferredPayloadLoaderFactory<T> = (getJsonBody: () => Promise<unknown>, onResolved?: (value: T) => void) => DeferredPayloadLoader<T>;

export type NextResponseFactory = () => Response | PromiseLike<Response>;

export type ResponseStateAdapter = Pick<RequestContext, 'applyResponseHeaders' | 'hasQueuedNoContentResponse' | 'hasQueuedResponseState' | 'noContent' | 'respond' | 'respondDefaultCreated'>;

export type RawGuardInvoker = (request: Request, params: Record<string, string>) => boolean | Promise<boolean>;

export type RawGuardSyncInvoker = (request: Request, params: Record<string, string>) => boolean;

export type RawMiddlewareInvoker = (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory) => Response | PromiseLike<Response>;

export interface RawResponseExecutionState {
  applyQueuedState: (response: Response) => Response;
  getJsonBody: () => Promise<unknown>;
  getResponseState: () => ResponseState;
  setBodyPayload: (value: unknown) => void;
  /** Records the (validated) body so a context created later sees it; same as `setBodyPayload`. */
  primeBody(value: unknown): void;
}

export interface RawExecutionState extends RawResponseExecutionState {
  getContext: () => RequestContext;
}

export type RouteFilters = Array<{ catch: (error: unknown, context: RequestContext, route: ManifestRoute<unknown>) => Response | void | Promise<Response | void> }>;

export type RouteMiddleware = Array<{ handle?: (context: RequestContext, next: NextResponseFactory, route: ManifestRoute<unknown>) => Response | PromiseLike<Response>; handleRaw?: (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory, route: ManifestRoute<unknown>) => Response | PromiseLike<Response>; use?: (context: RequestContext, next: NextResponseFactory, route: ManifestRoute<unknown>) => Response | PromiseLike<Response>; useRaw?: (request: Request, params: Record<string, string>, responseState: ResponseState, next: NextResponseFactory, route: ManifestRoute<unknown>) => Response | PromiseLike<Response> }>;

export type RouteGuards = Array<{
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
    /** `@Consumes` media type; form types read the body as a form (see `runtime/form-body.ts`). */
    consumes?: import('../metadata').BodyMediaType;
    headerSchema?: TSchema;
    bodyLimit?: number;
    querySchema?: TSchema;
    paramSchema?: TSchema;
    security: Array<{ scheme: string; scopes: string[] }>;
    responses: Array<{ status: number; description: string; schema?: TSchema }>;
  };
  /** Generated ahead-of-time executor factory (see `runtime/aot.ts`). Optional; hand-written manifests omit it. */
  aot?: import('./aot').AotExecutorFactory;
}

export interface AppManifest<TSchema = unknown> {
  routes: ManifestRoute<TSchema>[];
}

export interface ListenOptions {
  port?: number;
  hostname?: string;
  /** Extra native Bun routes served alongside the application routes. */
  routes?: Record<string, BunRouteDefinition>;
  /** WebSocket routes by path (Bun route syntax, e.g. `/rooms/:id`). See `defineWebSocket`. */
  websockets?: Record<string, import('../websocket').WebSocketRoute<any>>;
  /** Maximum request body size in bytes (Bun's default is 128 MiB). */
  maxRequestBodySize?: number;
  /** Seconds a connection may stay idle before Bun closes it. */
  idleTimeout?: number;
  /**
   * Calls `app.close()` and exits on these signals: `true` means SIGINT and SIGTERM.
   * Off by default so tests and embedding hosts keep control of the process.
   */
  shutdownSignals?: boolean | readonly NodeJS.Signals[];
}
