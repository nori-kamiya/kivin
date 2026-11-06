import { createApp, defineApplication, defineModule, type AppManifest } from '@kivinjs/core';
import { buildOpenApiDocument } from '@kivinjs/openapi';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

const VersionHeaders = v.object({
  'x-api-version': v.picklist(['1', '2']),
  'x-trace': v.optional(v.string()),
});

class Routes {
  versioned({ headers }: { headers: v.InferOutput<typeof VersionHeaders> }) {
    return { version: headers['x-api-version'], trace: headers['x-trace'] ?? null, keys: Object.keys(headers).sort() };
  }

  raw({ headers, params }: { headers: Record<string, string | undefined>; params: Record<string, string> }) {
    return { agent: headers['user-agent'] ?? null, id: params.id ?? null, paramKeys: Object.keys(params) };
  }

  validatedOnly() {
    return { ok: true };
  }
}

type Route = AppManifest['routes'][number];
const route = (input: Pick<Route, 'method' | 'fullPath' | 'methodName'> & Partial<Route>): Route => ({
  controller: Routes,
  parameters: [],
  guards: [],
  middleware: [],
  filters: [],
  docs: { tags: [], security: [], responses: [] },
  ...input,
});

const routes: Route[] = [
  route({ method: 'GET', fullPath: '/versioned', methodName: 'versioned', parameters: [{ index: 0, source: 'input', fields: ['headers'] }], docs: { tags: [], security: [], responses: [], headerSchema: VersionHeaders } }),
  route({ method: 'GET', fullPath: '/raw/:id', methodName: 'raw', parameters: [{ index: 0, source: 'input', fields: ['params', 'headers'] }] }),
  route({ method: 'GET', fullPath: '/raw', methodName: 'raw', parameters: [{ index: 0, source: 'input', fields: ['params', 'headers'] }] }),
  route({ method: 'GET', fullPath: '/validated-only', methodName: 'validatedOnly', docs: { tags: [], security: [], responses: [], headerSchema: VersionHeaders } }),
];

const definition = defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
const app = createApp(definition, { routes });

describe('@UseHeaderSchema / input headers', () => {
  test('validated headers reach the handler typed and stripped to the schema', async () => {
    const response = await app.fetch(new Request('http://x/versioned', { headers: { 'X-API-Version': '2', 'x-other': 'dropped' } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: '2', trace: null, keys: ['x-api-version'] });
  });

  test('invalid or missing headers are 400 headers validation failed', async () => {
    for (const headers of [{}, { 'x-api-version': '3' }]) {
      const response = await app.fetch(new Request('http://x/versioned', { headers }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { message: string }).message).toBe('headers validation failed');
    }
  });

  test('a schema is enforced even when the handler does not read headers', async () => {
    expect((await app.fetch(new Request('http://x/validated-only'))).status).toBe(400);
    expect((await app.fetch(new Request('http://x/validated-only', { headers: { 'x-api-version': '1' } }))).status).toBe(200);
  });

  test('without a schema handlers get all headers; params stay clean', async () => {
    const withParam = await app.fetch(new Request('http://x/raw/7', { headers: { 'user-agent': 'kivin-test' } }));
    expect(await withParam.json()).toEqual({ agent: 'kivin-test', id: '7', paramKeys: ['id'] });
    // Exact (parameterless) routes share a frozen params object; it must not be mutated.
    const exact = await app.fetch(new Request('http://x/raw', { headers: { 'user-agent': 'a' } }));
    expect(await exact.json()).toEqual({ agent: 'a', id: null, paramKeys: [] });
    const again = await app.fetch(new Request('http://x/raw', { headers: { 'user-agent': 'b' } }));
    expect(((await again.json()) as { agent: string }).agent).toBe('b');
  });

  test('works over Bun native routes', async () => {
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/versioned`, { headers: { 'x-api-version': '1', 'x-trace': 't1' } });
      expect(await response.json()).toEqual({ version: '1', trace: 't1', keys: ['x-api-version', 'x-trace'] });
    } finally {
      await server.stop(true);
    }
  });

  test('OpenAPI lists header parameters', () => {
    const document = buildOpenApiDocument({ manifest: { routes }, schemaAdapter: definition.schemaAdapter, title: 't', version: '1' } as never) as { paths: Record<string, Record<string, { parameters: Array<{ in: string; name: string; required: boolean }> }>> };
    const parameters = document.paths['/versioned']!.get!.parameters;
    expect(parameters.filter((parameter) => parameter.in === 'header').map(({ name, required }) => ({ name, required }))).toEqual([
      { name: 'x-api-version', required: true },
      { name: 'x-trace', required: false },
    ]);
  });
});
