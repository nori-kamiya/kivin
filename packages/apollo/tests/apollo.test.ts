import { HeaderMap, type ApolloServer } from '@apollo/server';
import { createApolloRoutes } from '@kivinjs/apollo';
import { describe, expect, test } from 'bun:test';

// Incremental delivery (@defer / @stream) needs graphql 17, which Apollo 5 does not accept as a peer
// yet; a stand-in server returns the chunked body Apollo would.
const chunkedServer = {
  async executeHTTPGraphQLRequest() {
    async function* chunks() {
      yield 'first\r\n';
      yield 'second\r\n';
    }
    return { status: 200, headers: new HeaderMap([['content-type', 'multipart/mixed; boundary="-"']]), body: { kind: 'chunked' as const, asyncIterator: chunks() } };
  },
} as unknown as ApolloServer;

describe('createApolloRoutes', () => {
  test('given no path, when routes are built, then they mount at /graphql for GET and POST', () => {
    const routes = createApolloRoutes(chunkedServer);

    expect(Object.keys(routes)).toEqual(['/graphql']);
    expect(Object.keys(routes['/graphql']!).sort()).toEqual(['GET', 'POST']);
  });

  test('given a path without a leading slash, when routes are built, then it throws', () => {
    expect(() => createApolloRoutes(chunkedServer, { path: 'graphql' })).toThrow(TypeError);
  });

  test('given a chunked Apollo response, when served, then the chunks are streamed in order with Apollo headers', async () => {
    const response = await createApolloRoutes(chunkedServer)['/graphql']!.POST(new Request('http://x/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"query":"{ a }"}',
    }));

    expect(response.headers.get('content-type')).toBe('multipart/mixed; boundary="-"');
    expect(await response.text()).toBe('first\r\nsecond\r\n');
  });
});
