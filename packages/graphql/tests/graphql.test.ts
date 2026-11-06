import { createApp, defineApplication, defineModule, unauthorized } from '@kivinjs/core';
import { createGraphqlHandler, createGraphqlRoutes, type FetchGraphqlServer } from '@kivinjs/graphql';
import { describe, expect, test } from 'bun:test';

// A stand-in for GraphQL Yoga: echoes the operation and the server context it was given.
const fakeYoga = (): FetchGraphqlServer<{ user?: string; requestId?: string }> & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return {
    seen,
    async fetch(request, serverContext) {
      seen.push(serverContext);
      if (request.method === 'GET' && !new URL(request.url).searchParams.has('query')) {
        return new Response('<html>GraphiQL</html>', { headers: { 'content-type': 'text/html' } });
      }
      const query = request.method === 'POST' ? ((await request.json()) as { query: string }).query : new URL(request.url).searchParams.get('query');
      return Response.json({ data: { query, user: serverContext.user ?? null } });
    },
  };
};

describe('createGraphqlRoutes', () => {
  test('serves GET / POST on the path with the server context from `context`', async () => {
    const yoga = fakeYoga();
    const app = createApp(defineApplication({ modules: [defineModule({ providers: [], controllers: [], imports: [] })] }), { routes: [] });
    const server = app.listen({
      port: 0,
      hostname: '127.0.0.1',
      routes: createGraphqlRoutes(yoga, { context: (request) => ({ user: request.headers.get('x-user') ?? 'anonymous' }) }),
    });
    try {
      const post = await fetch(new URL('/graphql', server.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': 'ada' }, body: JSON.stringify({ query: '{ me }' }) });
      expect(await post.json()).toEqual({ data: { query: '{ me }', user: 'ada' } });
      const get = await fetch(new URL('/graphql?query=%7B%20ping%20%7D', server.url));
      expect(await get.json()).toEqual({ data: { query: '{ ping }', user: 'anonymous' } });
      const graphiql = await fetch(new URL('/graphql', server.url));
      expect(await graphiql.text()).toContain('GraphiQL');
      // Other methods fall through to the app (no route there).
      expect((await fetch(new URL('/graphql', server.url), { method: 'PUT' })).status).toBe(404);
      expect(yoga.seen).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  test('custom path and methods; invalid path throws', () => {
    const routes = createGraphqlRoutes(fakeYoga(), { path: '/api/graphql', methods: ['POST'] });
    expect(Object.keys(routes)).toEqual(['/api/graphql']);
    expect(Object.keys(routes['/api/graphql']!)).toEqual(['POST']);
    expect(() => createGraphqlRoutes(fakeYoga(), { path: 'graphql' })).toThrow(TypeError);
  });

  test('context can reject with an HttpError or a Response', async () => {
    const handler = createGraphqlHandler(fakeYoga(), {
      context: (request) => {
        if (request.headers.get('x-mode') === 'response') {
          throw new Response('nope', { status: 429 });
        }
        throw unauthorized('login first');
      },
    });
    const denied = await handler(new Request('http://localhost/graphql', { method: 'POST', body: '{}' }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ message: 'login first' });
    expect((await handler(new Request('http://localhost/graphql', { headers: { 'x-mode': 'response' } }))).status).toBe(429);
  });
});
