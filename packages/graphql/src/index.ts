// @kivin/graphql: mounts a fetch-based GraphQL server (GraphQL Yoga, or any server exposing
// `fetch(request, context)`) on a native route, with access to kivin's DI container.
import { HttpError } from '@kivin/core';

/** What the mount needs from the server: GraphQL Yoga's `createYoga(...)` result fits as is. */
export interface FetchGraphqlServer<TServerContext> {
  fetch(request: Request, serverContext: TServerContext): Response | Promise<Response>;
}

export interface GraphqlRouteOptions<TServerContext> {
  /**
   * The endpoint path. Must equal the server's own endpoint setting (Yoga's `graphqlEndpoint`,
   * default `/graphql`), since the server checks it too.
   */
  path?: string;
  /**
   * Builds the server context Yoga merges into every resolver context, e.g. the authenticated user
   * or services from `app.get(...)`. Throwing a `Response` or an `HttpError` (e.g. `unauthorized()`)
   * answers the request with it.
   */
  context?: (request: Request) => TServerContext | Promise<TServerContext>;
  /** HTTP methods routed to the server. Default GET (GraphiQL, queries), POST, OPTIONS (CORS preflight). */
  methods?: ReadonlyArray<'GET' | 'POST' | 'OPTIONS'>;
}

/**
 * Native routes for `app.listen({ routes })` that hand GraphQL requests to `server`:
 *
 * ```ts
 * import { createYoga, createSchema } from 'graphql-yoga';
 *
 * const yoga = createYoga<{ users: UserService }>({ schema: createSchema({ typeDefs, resolvers }) });
 * app.listen({
 *   port: 3000,
 *   routes: createGraphqlRoutes(yoga, { context: () => ({ users: app.get(UserService) }) }),
 * });
 * // resolvers: (_, args, ctx) => ctx.users.find(args.id)
 * ```
 *
 * `onRequest` hooks run first as for any native route; guards and middleware do not (they belong to
 * controller routes): authenticate in `context` or in a hook.
 */
export function createGraphqlRoutes<TServerContext extends object = Record<string, never>>(
  server: FetchGraphqlServer<TServerContext>,
  options: GraphqlRouteOptions<TServerContext> = {},
) {
  const path = options.path ?? '/graphql';
  if (!path.startsWith('/')) {
    throw new TypeError(`createGraphqlRoutes: path must start with "/" (got ${JSON.stringify(path)})`);
  }
  const handler = createGraphqlHandler(server, options);
  const methods = options.methods ?? ['GET', 'POST', 'OPTIONS'];
  return { [path]: Object.fromEntries(methods.map((method) => [method, handler])) } as Record<string, Record<string, (request: Request) => Promise<Response>>>;
}

/** The request handler behind `createGraphqlRoutes`, for mounting it some other way. */
export function createGraphqlHandler<TServerContext extends object = Record<string, never>>(
  server: FetchGraphqlServer<TServerContext>,
  options: Pick<GraphqlRouteOptions<TServerContext>, 'context'> = {},
) {
  return async (request: Request): Promise<Response> => {
    let serverContext: TServerContext;
    try {
      serverContext = options.context ? await options.context(request) : ({} as TServerContext);
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }
      if (error instanceof HttpError) {
        return error.toResponse();
      }
      throw error;
    }
    return server.fetch(request, serverContext);
  };
}
