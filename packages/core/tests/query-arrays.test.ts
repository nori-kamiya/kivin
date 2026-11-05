import { createApp, defineApplication, defineModule, type AppManifest } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

const TagsQuery = v.object({ tag: v.optional(v.union([v.string(), v.array(v.string())])) });
const ListQuery = v.object({ id: v.array(v.pipe(v.string(), v.transform(Number))) });
const SingleQuery = v.object({ search: v.string() });

class Routes {
  echo({ query }: { query: unknown }) {
    return query;
  }
}

type Route = AppManifest['routes'][number];
const route = (fullPath: string, querySchema?: unknown): Route => ({
  method: 'GET',
  fullPath,
  controller: Routes,
  methodName: 'echo',
  parameters: [{ index: 0, source: 'input', fields: ['query'] }],
  guards: [],
  middleware: [],
  filters: [],
  docs: { tags: [], security: [], responses: [], ...(querySchema ? { querySchema } : {}) },
});

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), { routes: [route('/raw'), route('/tags', TagsQuery), route('/ids', ListQuery), route('/single', SingleQuery)] });
const get = async (path: string) => {
  const response = await app.fetch(new Request(`http://x${path}`));
  return { status: response.status, body: await response.json() };
};

describe('repeated query keys', () => {
  test('become arrays without a schema; single keys stay strings', async () => {
    expect(await get('/raw?tag=a&tag=b&q=x')).toEqual({ status: 200, body: { tag: ['a', 'b'], q: 'x' } });
  });

  test('validate against array schemas (what the generated client sends for arrays)', async () => {
    expect(await get('/ids?id=1&id=2&id=3')).toEqual({ status: 200, body: { id: [1, 2, 3] } });
    expect(await get('/tags?tag=a')).toEqual({ status: 200, body: { tag: 'a' } });
    expect(await get('/tags?tag=a&tag=b')).toEqual({ status: 200, body: { tag: ['a', 'b'] } });
  });

  test('a repeated key for a single-value schema is a 400, not a silent last-wins', async () => {
    expect((await get('/single?search=a')).status).toBe(200);
    expect((await get('/single?search=a&search=b')).status).toBe(400);
  });
});
