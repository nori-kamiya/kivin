// @kivinjs/trpc: mounts a tRPC router on kivin native routes, with kivin's DI (request-scoped
// providers included) available in the tRPC context and kivin's HttpError mapped to tRPC errors.
import { createCorsHandler, originalRequest, HttpError, type CorsOptions, type RequestContext } from '@kivinjs/core';
import { TRPCError, type AnyRouter, type inferRouterContext } from '@trpc/server';
import { fetchRequestHandler, type FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import type { HTTPBaseHandlerOptions } from '@trpc/server/http';

type TRPCErrorCode = ConstructorParameters<typeof TRPCError>[0]['code'];

/** What the adapter needs from the kivin app: `createApp(...)`'s result fits as is. */
export interface RequestContextFactory {
  createRequestContext(request: Request): RequestContext;
}

/** The subset of Bun's `Server` the handler uses (native route handlers receive it as 2nd argument). */
interface ServerTimeout {
  timeout(request: Request, seconds: number): void;
}

export interface TrpcCreateContextOptions extends FetchCreateContextFnOptions {
  /**
   * The kivin `RequestContext` of this HTTP request (created on first call, needs `app`). Its
   * `inject(...)` resolves request-scoped providers once per HTTP request, so all procedures of a
   * batch share them.
   */
  requestContext(): RequestContext;
}

export interface TrpcRouteOptions<TRouter extends AnyRouter> extends Omit<HTTPBaseHandlerOptions<TRouter, Request>, 'router'> {
  /** Path prefix of the procedures. Must match the client's `url` path. Default `/trpc`. */
  endpoint?: string;
  /** The kivin app, for `requestContext()` in `createContext`. */
  app?: RequestContextFactory;
  /**
   * Builds the tRPC context once per HTTP request. Throwing an `HttpError` (e.g. `unauthorized()`)
   * answers with the matching tRPC error; throwing a `Response` answers with that response as is.
   */
  createContext?: (options: TrpcCreateContextOptions) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;
  /**
   * CORS for these routes (preflight and response headers). The app's `cors` setting covers controller
   * routes only, not native routes.
   */
  cors?: CorsOptions;
}

const CODE_BY_STATUS: Readonly<Record<number, TRPCErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_SUPPORTED',
  408: 'TIMEOUT',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_CONTENT',
  428: 'PRECONDITION_REQUIRED',
  429: 'TOO_MANY_REQUESTS',
  499: 'CLIENT_CLOSED_REQUEST',
  500: 'INTERNAL_SERVER_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

/** The tRPC error for a kivin `HttpError`: same message, the code whose HTTP status matches. */
export function toTRPCError(error: HttpError): TRPCError {
  const code = CODE_BY_STATUS[error.status] ?? (error.status < 500 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR');
  return new TRPCError({ code, message: error.message, cause: error });
}

/**
 * tRPC middleware that makes procedure errors behave like kivin's routes: an `HttpError` becomes the
 * matching tRPC error (tRPC would report it as INTERNAL_SERVER_ERROR), and an unexpected error reaches
 * the client only as "Internal Server Error" (tRPC would send its message): `t.procedure.use(httpErrors)`.
 */
export async function httpErrors<TResult extends { ok: boolean; error?: TRPCError }>(options: { next: () => Promise<TResult> }): Promise<TResult> {
  const result = await options.next();
  const error = result.ok ? undefined : result.error;
  if (!error) {
    return result;
  }
  if (error.cause instanceof HttpError) {
    throw toTRPCError(error.cause);
  }
  // tRPC wraps a non-TRPCError in INTERNAL_SERVER_ERROR and copies its message; a TRPCError the
  // procedure threw on purpose (its own message) is left alone.
  if (error.code === 'INTERNAL_SERVER_ERROR' && error.cause !== undefined && !(error.cause instanceof TRPCError) && error.message === error.cause.message) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error', cause: error.cause });
  }
  return result;
}

const ERROR_REPORTED = Symbol.for('kivin.errorReported');
const ANSWERED_WITH_RESPONSE = Symbol('kivin.trpc.answeredWithResponse');

const answeredWithResponse = (error: TRPCError) => (error.cause as Record<symbol, unknown> | undefined)?.[ANSWERED_WITH_RESPONSE] === true;

// Same contract as kivin's own routes: an unexpected error is logged once, unless a logger already
// reported it (`markErrorReported`); an HttpError is an intended answer, not an unexpected error.
function reportUnexpected(error: TRPCError) {
  if (error.code !== 'INTERNAL_SERVER_ERROR') {
    return;
  }
  const cause: unknown = error.cause ?? error;
  if (cause instanceof HttpError || (typeof cause === 'object' && cause !== null && (cause as Record<symbol, unknown>)[ERROR_REPORTED])) {
    return;
  }
  console.error('[kivin] Unhandled error', cause);
}

function normalizeEndpoint(endpoint: string) {
  if (!endpoint.startsWith('/')) {
    throw new TypeError(`@kivinjs/trpc: endpoint must start with "/" (got ${JSON.stringify(endpoint)})`);
  }
  return endpoint.length > 1 && endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
}

/** The request handler behind `createTrpcRoutes`, for mounting it some other way. */
export function createTrpcHandler<TRouter extends AnyRouter>(router: TRouter, options: TrpcRouteOptions<TRouter> = {}) {
  const { endpoint: rawEndpoint = '/trpc', app, cors: corsOptions, createContext, onError, ...handlerOptions } = options;
  const endpoint = normalizeEndpoint(rawEndpoint);
  const cors = corsOptions ? createCorsHandler(corsOptions) : undefined;

  const handle = async (request: Request, server?: ServerTimeout): Promise<Response> => {
    // A subscription (SSE) stays open with gaps longer than `idleTimeout`; Bun would cut it. Bun only
    // knows the request it received, not one an `onRequest` hook rewrote.
    if (server && request.headers.get('accept')?.includes('text/event-stream')) {
      server.timeout(originalRequest(request), 0);
    }

    let answer: Response | undefined;
    let context: RequestContext | undefined;
    const requestContext = () => {
      if (!app) {
        throw new TypeError('@kivinjs/trpc: requestContext() needs the app: createTrpcRoutes(router, { app, createContext })');
      }
      context ??= app.createRequestContext(request);
      return context;
    };

    const response = await fetchRequestHandler({
      ...handlerOptions,
      router,
      endpoint,
      req: request,
      createContext: createContext && (async (fetchOptions: FetchCreateContextFnOptions) => {
        try {
          return await createContext({ ...fetchOptions, requestContext });
        } catch (error) {
          if (error instanceof Response) {
            answer = error;
            const marker = new Error('answered with a Response from createContext');
            Object.defineProperty(marker, ANSWERED_WITH_RESPONSE, { value: true });
            throw marker;
          }
          throw error instanceof HttpError ? toTRPCError(error) : error;
        }
      }),
      onError: (errorOptions) => {
        if (answeredWithResponse(errorOptions.error)) {
          return;
        }
        onError?.(errorOptions);
        reportUnexpected(errorOptions.error);
      },
    } as Parameters<typeof fetchRequestHandler<TRouter>>[0]);
    return answer ?? response;
  };

  if (!cors) {
    return handle;
  }
  return async (request: Request, server?: ServerTimeout): Promise<Response> => cors.ensure(request, await handle(request, server));
}

/**
 * Native routes for `app.listen({ routes })` that serve `router` under `endpoint`:
 *
 * ```ts
 * const t = initTRPC.context<{ users: UserService }>().create();
 * const procedure = t.procedure.use(httpErrors);
 * app.listen({
 *   port: 3000,
 *   routes: createTrpcRoutes(appRouter, {
 *     app,
 *     createContext: ({ requestContext }) => ({ users: requestContext().inject(UserService) }),
 *   }),
 * });
 * ```
 *
 * `onRequest` hooks run first as for any native route; guards, middleware and the app's `cors` do not
 * (they belong to controller routes): authenticate in `createContext` or in a hook, and pass `cors` here.
 */
export function createTrpcRoutes<TRouter extends AnyRouter>(router: TRouter, options: TrpcRouteOptions<TRouter> = {}) {
  const endpoint = normalizeEndpoint(options.endpoint ?? '/trpc');
  const handler = createTrpcHandler(router, options);
  const path = endpoint === '/' ? '/*' : `${endpoint}/*`;
  if (!options.cors) {
    return { [path]: { GET: handler, POST: handler } } as Record<string, { GET: typeof handler; POST: typeof handler; OPTIONS?: (request: Request) => Response }>;
  }
  const cors = createCorsHandler(options.cors);
  const preflight = (request: Request) => cors.preflight(request, ['GET', 'POST']) ?? new Response(null, { status: 204, headers: { allow: 'GET, POST, OPTIONS' } });
  return { [path]: { GET: handler, POST: handler, OPTIONS: preflight } } as Record<string, { GET: typeof handler; POST: typeof handler; OPTIONS?: (request: Request) => Response }>;
}
