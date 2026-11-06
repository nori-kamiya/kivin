import { createApp, defineApplication, defineModule, type AppManifest } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

// Malformed percent-encoding is client input; it must never throw out of `fetch` or become a 500.
class Routes {
  user({ params }: { params: Record<string, string> }) {
    return params;
  }

  search({ query }: { query: Record<string, unknown> }) {
    return query;
  }
}

const route = (fullPath: string, methodName: string, fields: Array<'params' | 'query'>): AppManifest['routes'][number] => ({
  method: 'GET',
  fullPath,
  controller: Routes,
  methodName,
  parameters: [{ index: 0, source: 'input', fields }],
  guards: [],
  middleware: [],
  filters: [],
  docs: { tags: [], security: [], responses: [] },
});

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), { routes: [route('/users/:id', 'user', ['params']), route('/search', 'search', ['query'])] });

describe('malformed percent-encoding', () => {
  test('path params keep the raw text', async () => {
    for (const [path, id] of [['/users/%ZZ', '%ZZ'], ['/users/50%', '50%'], ['/users/%E3%81%82', 'あ']] as const) {
      const response = await app.fetch(new Request(`http://x${path}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id });
    }
  });

  test('query keys and values keep the raw text', async () => {
    const response = await app.fetch(new Request('http://x/search?a=%ZZ&%ZZ=1&b=%E3%81%82&c=a+b'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ a: '%ZZ', '%ZZ': '1', b: 'あ', c: 'a b' });
  });

  test('over Bun native routes they do not fail either', async () => {
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      expect((await fetch(`http://127.0.0.1:${server.port}/users/%ZZ`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${server.port}/search?a=%ZZ`)).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });
});
