import { createApp, defineApplication, unauthorized } from '@kivinjs/core';
import { createGraphqlRoutes } from '@kivinjs/graphql';
import { createValibotAdapter } from '@kivinjs/valibot';
import { afterAll, describe, expect, test } from 'bun:test';
import { createSchema, createYoga } from 'graphql-yoga';

interface ServerContext {
  user: string;
}

const schema = createSchema<ServerContext>({
  typeDefs: /* GraphQL */ `
    type Query {
      hello: String!
      me: String!
    }
    type Subscription {
      count(to: Int!): Int!
    }
  `,
  resolvers: {
    Query: {
      hello: () => 'world',
      me: (_parent, _args, context) => context.user,
    },
    Subscription: {
      count: {
        subscribe: async function* (_parent, args: { to: number }) {
          for (let value = 1; value <= args.to; value += 1) {
            yield { count: value };
          }
        },
      },
    },
  },
});

const yoga = createYoga<ServerContext>({ schema, logging: false, graphiql: true, cors: { origin: 'https://app.example' } });
const customPathYoga = createYoga<ServerContext>({ schema, logging: false, graphqlEndpoint: '/api/gql' });

const plainYoga = createYoga({
  logging: false,
  graphqlEndpoint: '/plain',
  schema: createSchema({ typeDefs: 'type Query { ping: String! }', resolvers: { Query: { ping: () => 'pong' } } }),
});

const context = (request: Request): ServerContext => {
  const user = request.headers.get('x-user');
  if (!user) {
    throw unauthorized();
  }
  return { user };
};

const app = createApp(defineApplication({ modules: [], schemaAdapter: createValibotAdapter() }), { routes: [] });
const server = app.listen({
  port: 0,
  hostname: '127.0.0.1',
  routes: {
    ...createGraphqlRoutes(yoga, { context }),
    ...createGraphqlRoutes(customPathYoga, { path: '/api/gql', context }),
    ...createGraphqlRoutes(plainYoga, { path: '/plain' }),
  },
});

const url = (path: string) => new URL(path, server.url);
const post = (path: string, query: string, headers: Record<string, string> = { 'x-user': 'ada' }) => fetch(url(path), {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ query }),
});

afterAll(() => {
  server.stop(true);
});

describe('createGraphqlRoutes with GraphQL Yoga', () => {
  test('POST runs a query', async () => {
    const response = await post('/graphql', '{ hello }');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { hello: 'world' } });
  });

  test('GET runs a query from the query string', async () => {
    const response = await fetch(url('/graphql?query=%7B%20hello%20%7D'), { headers: { 'x-user': 'ada', accept: 'application/json' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { hello: 'world' } });
  });

  test('GET from a browser serves GraphiQL', async () => {
    const response = await fetch(url('/graphql'), { headers: { 'x-user': 'ada', accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('GraphiQL');
  });

  test('OPTIONS answers the CORS preflight with the server configuration', async () => {
    const response = await fetch(url('/graphql'), {
      method: 'OPTIONS',
      headers: { 'x-user': 'ada', origin: 'https://app.example', 'access-control-request-method': 'POST' },
    });
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  test('a path equal to the server graphqlEndpoint is served', async () => {
    const response = await post('/api/gql', '{ hello }');
    expect(await response.json()).toEqual({ data: { hello: 'world' } });
  });

  test('a server without a custom context mounts without the context option', async () => {
    const response = await post('/plain', '{ ping }', {});
    expect(await response.json()).toEqual({ data: { ping: 'pong' } });
  });

  test('values from the context option reach resolvers', async () => {
    const response = await post('/graphql', '{ me }', { 'x-user': 'grace' });
    expect(await response.json()).toEqual({ data: { me: 'grace' } });
  });

  test('unauthorized() thrown from the context option answers 401 without running resolvers', async () => {
    const response = await post('/graphql', '{ me }', {});
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('"data"');
  });

  test('a subscription streams its events over SSE through the native route', async () => {
    const response = await fetch(url('/graphql'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-user': 'ada' },
      body: JSON.stringify({ query: 'subscription { count(to: 3) }' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = await response.text();
    const events = body.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice('data: '.length)));
    expect(events.filter((event) => event.data).map((event) => event.data.count)).toEqual([1, 2, 3]);
    expect(body).toContain('event: complete');
  });
});
