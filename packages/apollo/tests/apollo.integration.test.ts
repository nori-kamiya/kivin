import { ApolloServer } from '@apollo/server';
import { apolloLifecycle, createApolloRoutes, formatApolloError } from '@kivinjs/apollo';
import { createApp, defineApplication, defineModule, forbidden, markErrorReported, RequestContext, unauthorized } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { GraphQLError } from 'graphql';

class RequestId {
  static created = 0;
  readonly id = ++RequestId.created;
}

interface Context {
  user: string;
  requestId: number;
  context: RequestContext;
}

const typeDefs = /* GraphQL */ `
  type Query {
    me: String!
    requestId: Int!
    sameScope: Boolean!
    denied: String
    boom: String
    logged: String
    intended: String
  }
`;

const resolvers = {
  Query: {
    me: (_: unknown, __: unknown, ctx: Context) => ctx.user,
    requestId: (_: unknown, __: unknown, ctx: Context) => ctx.requestId,
    sameScope: (_: unknown, __: unknown, ctx: Context) => ctx.context.inject(RequestId).id === ctx.requestId,
    denied: () => {
      throw forbidden('no access');
    },
    boom: () => {
      throw new Error('database is down');
    },
    logged: () => {
      const error = new Error('already logged');
      markErrorReported(error);
      throw error;
    },
    intended: () => {
      throw new GraphQLError('custom', { extensions: { code: 'CUSTOM' } });
    },
  },
};

const apollo = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatApolloError });

const app = createApp(defineApplication({
  modules: [defineModule({
    providers: [{ provide: RequestId, scope: 'request', useClass: RequestId }, apolloLifecycle(apollo)],
    controllers: [],
    imports: [],
  })],
  schemaAdapter: createValibotAdapter(),
}), { routes: [] });

let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  await app.init();
  server = app.listen({
    port: 0,
    hostname: '127.0.0.1',
    routes: createApolloRoutes(apollo, {
      app,
      cors: { origin: 'https://app.example' },
      context: ({ req, requestContext }) => {
        const user = req.headers.get('x-user');
        if (user === 'teapot') {
          throw new Response('short and stout', { status: 418 });
        }
        if (!user) {
          throw unauthorized('sign in first');
        }
        const context = requestContext();
        return { user, requestId: context.inject(RequestId).id, context };
      },
    }),
  });
});

let consoleError: ReturnType<typeof spyOn<Console, 'error'>>;
beforeEach(() => {
  consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleError.mockRestore();
});

const url = (path = '/graphql') => new URL(path, server.url);
const post = (query: string, headers: Record<string, string> = { 'x-user': 'ada' }) => fetch(url(), {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ query }),
});
type GraphqlBody = { data?: Record<string, unknown> | null; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };

describe('createApolloRoutes with a real Apollo Server', () => {
  test('given a POST query, when the context resolves request-scoped providers, then one request shares one scope', async () => {
    const response = await post('{ me requestId sameScope }');

    expect(response.status).toBe(200);
    const body = await response.json() as GraphqlBody;
    expect(body.data).toMatchObject({ me: 'ada', sameScope: true });
  });

  test('given two requests, when each resolves a request-scoped provider, then each gets its own instance', async () => {
    const first = await (await post('{ requestId }')).json() as GraphqlBody;
    const second = await (await post('{ requestId }')).json() as GraphqlBody;

    expect(first.data?.requestId).not.toBe(second.data?.requestId);
  });

  test('given a GET query with the preflight header, when sent, then it runs', async () => {
    const response = await fetch(url(`/graphql?query=${encodeURIComponent('{ me }')}`), { headers: { 'x-user': 'ada', 'apollo-require-preflight': 'true' } });

    expect(response.status).toBe(200);
    expect(((await response.json()) as GraphqlBody).data).toEqual({ me: 'ada' });
  });

  test('given a GET query without a preflight header, when sent, then Apollo CSRF prevention rejects it', async () => {
    const response = await fetch(url(`/graphql?query=${encodeURIComponent('{ me }')}`), { headers: { 'x-user': 'ada' } });

    expect(response.status).toBe(400);
  });

  test('given malformed JSON, when posted, then the answer is 400', async () => {
    const response = await fetch(url(), { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'ada' }, body: '{"query":' });

    expect(response.status).toBe(400);
  });

  test('given the context throws an HttpError, when called, then that status answers the request', async () => {
    const response = await post('{ me }', {});

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'sign in first' });
  });

  test('given the context throws a Response, when called, then that response is returned as is', async () => {
    const response = await post('{ me }', { 'x-user': 'teapot' });

    expect(response.status).toBe(418);
    expect(await response.text()).toBe('short and stout');
  });

  test('given formatApolloError, when a resolver throws an HttpError, then the error carries the matching code and its message', async () => {
    const body = await (await post('{ denied }')).json() as GraphqlBody;

    expect(body.errors?.[0]?.message).toBe('no access');
    expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(body.errors?.[0]?.extensions?.status).toBe(403);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('given formatApolloError, when a resolver throws an unexpected error, then the client sees only a generic message and the cause is logged once', async () => {
    const body = await (await post('{ boom }')).json() as GraphqlBody;

    expect(body.errors?.[0]?.message).toBe('Internal Server Error');
    expect(body.errors?.[0]?.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body.errors?.[0]?.extensions?.stacktrace).toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe('[kivin] Unhandled error');
    expect((consoleError.mock.calls[0]?.[1] as Error).message).toBe('database is down');
  });

  test('given formatApolloError, when the error was already reported, then it is not logged again', async () => {
    const body = await (await post('{ logged }')).json() as GraphqlBody;

    expect(body.errors?.[0]?.message).toBe('Internal Server Error');
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('given formatApolloError, when a resolver throws a GraphQLError on purpose, then it passes through', async () => {
    const body = await (await post('{ intended }')).json() as GraphqlBody;

    expect(body.errors?.[0]?.message).toBe('custom');
    expect(body.errors?.[0]?.extensions?.code).toBe('CUSTOM');
  });

  test('given cors, when a browser preflights and then queries from an allowed origin, then both carry CORS headers', async () => {
    const preflight = await fetch(url(), {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    const response = await post('{ me }', { 'x-user': 'ada', origin: 'https://app.example' });
    const other = await post('{ me }', { 'x-user': 'ada', origin: 'https://evil.example' });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('apolloLifecycle', () => {
  test('given the provider, when the app closes, then Apollo is stopped and refuses further operations', async () => {
    const lifecycleApollo = new ApolloServer({ typeDefs: 'type Query { ok: Boolean }', resolvers: { Query: { ok: () => true } } });
    const lifecycleApp = createApp(defineApplication({
      modules: [defineModule({ providers: [apolloLifecycle(lifecycleApollo)], controllers: [], imports: [] })],
      schemaAdapter: createValibotAdapter(),
    }), { routes: [] });

    await lifecycleApp.init();
    expect((await lifecycleApollo.executeOperation({ query: '{ ok }' })).body).toMatchObject({ kind: 'single' });

    await lifecycleApp.close();
    await expect(lifecycleApollo.executeOperation({ query: '{ ok }' })).rejects.toThrow();
  });
});

afterAll(async () => {
  server.stop(true);
  await app.close();
});
