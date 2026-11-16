// @kivinjs/apollo: mounts Apollo Server on kivin native routes (Apollo has no official fetch
// integration), with kivin's DI in the GraphQL context, Apollo's start/stop tied to the app lifecycle
// and kivin's error contract (HttpError codes, unexpected errors masked and logged once).
import { HeaderMap, type ApolloServer, type BaseContext } from '@apollo/server';
import { unwrapResolverError } from '@apollo/server/errors';
import { createCorsHandler, HttpError, type CorsOptions, type ProviderDefinition, type RequestContext } from '@kivinjs/core';
import type { GraphQLFormattedError } from 'graphql';

/** What the adapter needs from the kivin app: `createApp(...)`'s result fits as is. */
export interface RequestContextFactory {
  createRequestContext(request: Request): RequestContext;
}

export interface ApolloContextOptions {
  req: Request;
  /**
   * The kivin `RequestContext` of this request (created on first call, needs `app`): `inject(...)`
   * resolves request-scoped providers once per request.
   */
  requestContext(): RequestContext;
}

export interface ApolloRouteOptions<TContext extends BaseContext> {
  /** The endpoint path. Default `/graphql`. */
  path?: string;
  /** The kivin app, for `requestContext()` in `context`. */
  app?: RequestContextFactory;
  /**
   * Builds the GraphQL context value once per request. Throwing an `HttpError` (e.g. `unauthorized()`)
   * or a `Response` answers the request with it, before Apollo runs.
   */
  context?: (options: ApolloContextOptions) => TContext | Promise<TContext>;
  /** CORS for this endpoint. The app's `cors` setting covers controller routes only, not native routes. */
  cors?: CorsOptions;
}

type Handler = (request: Request) => Promise<Response>;

function assertPath(path: string) {
  if (!path.startsWith('/')) {
    throw new TypeError(`@kivinjs/apollo: path must start with "/" (got ${JSON.stringify(path)})`);
  }
}

async function readBody(request: Request): Promise<{ body: unknown } | Response> {
  if (request.method !== 'POST') {
    return { body: undefined };
  }
  const text = await request.text();
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(request.headers.get('content-type') ?? '')) {
    return { body: text };
  }
  try {
    return { body: text === '' ? undefined : JSON.parse(text) };
  } catch {
    return Response.json({ message: 'Malformed JSON body' }, { status: 400 });
  }
}

function toResponse(result: Awaited<ReturnType<ApolloServer['executeHTTPGraphQLRequest']>>): Response {
  const headers = new Headers([...result.headers]);
  const init = { status: result.status ?? 200, headers };
  if (result.body.kind === 'complete') {
    return new Response(result.body.string, init);
  }
  // @defer / @stream: Apollo yields the multipart chunks as strings.
  const chunks = result.body.asyncIterator;
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(next.value));
      }
    },
    async cancel() {
      await chunks.return?.();
    },
  }), init);
}

/** The request handler behind `createApolloRoutes`, for mounting it some other way. */
export function createApolloHandler<TContext extends BaseContext>(server: ApolloServer<TContext>, options: Omit<ApolloRouteOptions<TContext>, 'path'> = {}): Handler {
  const { app, context: buildContext, cors: corsOptions } = options;
  const cors = corsOptions ? createCorsHandler(corsOptions) : undefined;

  const handle: Handler = async (request) => {
    let requestContext: RequestContext | undefined;
    let contextValue: TContext;
    try {
      contextValue = buildContext
        ? await buildContext({
          req: request,
          requestContext: () => {
            if (!app) {
              throw new TypeError('@kivinjs/apollo: requestContext() needs the app: createApolloRoutes(server, { app, context })');
            }
            requestContext ??= app.createRequestContext(request);
            return requestContext;
          },
        })
        : ({} as TContext);
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }
      if (error instanceof HttpError) {
        return error.toResponse();
      }
      throw error;
    }

    const read = await readBody(request);
    if (read instanceof Response) {
      return read;
    }
    const headers = new HeaderMap();
    request.headers.forEach((value, key) => headers.set(key, value));
    const result = await server.executeHTTPGraphQLRequest({
      httpGraphQLRequest: { method: request.method.toUpperCase(), headers, search: new URL(request.url).search, body: read.body },
      context: async () => contextValue,
    });
    return toResponse(result);
  };

  return cors ? async (request) => cors.ensure(request, await handle(request)) : handle;
}

/**
 * Native routes for `app.listen({ routes })` that serve `server` at `path`:
 *
 * ```ts
 * const apollo = new ApolloServer<{ users: UserService }>({ typeDefs, resolvers, formatError: formatApolloError });
 * // providers: [apolloLifecycle(apollo)] starts it on app.init() and stops it on app.close()
 * await app.init();
 * app.listen({
 *   port: 3000,
 *   routes: createApolloRoutes(apollo, { app, context: ({ requestContext }) => ({ users: requestContext().inject(UserService) }) }),
 * });
 * ```
 *
 * `onRequest` hooks run first as for any native route; guards, middleware and the app's `cors` do not
 * (they belong to controller routes): authenticate in `context` or in a hook, and pass `cors` here.
 */
export function createApolloRoutes<TContext extends BaseContext>(server: ApolloServer<TContext>, options: ApolloRouteOptions<TContext> = {}) {
  const path = options.path ?? '/graphql';
  assertPath(path);
  const handler = createApolloHandler(server, options);
  type Methods = { GET: Handler; POST: Handler; OPTIONS?: (request: Request) => Response };
  if (!options.cors) {
    return { [path]: { GET: handler, POST: handler } } as Record<string, Methods>;
  }
  const cors = createCorsHandler(options.cors);
  const preflight = (request: Request) => cors.preflight(request, ['GET', 'POST']) ?? new Response(null, { status: 204, headers: { allow: 'GET, POST, OPTIONS' } });
  return { [path]: { GET: handler, POST: handler, OPTIONS: preflight } } as Record<string, Methods>;
}

/**
 * A provider that starts Apollo in `onModuleInit` (so `await app.init()` fails if the schema is
 * invalid) and stops it in `onApplicationShutdown` (`app.close()`): `providers: [apolloLifecycle(apollo)]`.
 */
export function apolloLifecycle(server: Pick<ApolloServer, 'start' | 'stop'>): ProviderDefinition {
  return {
    provide: Symbol('@kivinjs/apollo lifecycle'),
    useValue: {
      onModuleInit: () => server.start(),
      onApplicationShutdown: () => server.stop(),
    },
  };
}

const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'BAD_USER_INPUT',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'TOO_MANY_REQUESTS',
};

const ERROR_REPORTED = Symbol.for('kivin.errorReported');

const isGraphQLError = (error: unknown) => error instanceof Error && error.name === 'GraphQLError';

/**
 * Apollo's `formatError` with kivin's error contract: a resolver's `HttpError` keeps its message and
 * gets the matching `extensions.code` (`unauthorized()` → `UNAUTHENTICATED`) and `extensions.status`;
 * an unexpected error reaches the client only as "Internal Server Error" and is logged once (unless
 * `markErrorReported`). Errors Apollo or the resolver raised as `GraphQLError` pass through.
 */
export function formatApolloError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const cause = unwrapResolverError(error);
  if (cause instanceof HttpError) {
    const code = CODE_BY_STATUS[cause.status] ?? (cause.status < 500 ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR');
    const { stacktrace: _stacktrace, ...extensions } = formatted.extensions ?? {};
    return { ...formatted, message: cause.message, extensions: { ...extensions, code, status: cause.status } };
  }
  if (formatted.extensions?.code !== 'INTERNAL_SERVER_ERROR' || isGraphQLError(cause)) {
    return formatted;
  }
  if (!(typeof cause === 'object' && cause !== null && (cause as Record<symbol, unknown>)[ERROR_REPORTED])) {
    console.error('[kivin] Unhandled error', cause);
  }
  const { path, locations } = formatted;
  return { message: 'Internal Server Error', ...(locations ? { locations } : {}), ...(path ? { path } : {}), extensions: { code: 'INTERNAL_SERVER_ERROR' } };
}
