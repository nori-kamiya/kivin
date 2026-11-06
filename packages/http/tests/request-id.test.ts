import { createApp, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivin/core';
import { createRequestIdMiddleware, getRequestId } from '../src/index';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';

class Routes {
  raw() {
    return { ok: true };
  }

  echo({ context }: { context: RequestContext }) {
    return { fromRequest: getRequestId(context.request), fromContext: context.get('requestId') };
  }
}

type Route = AppManifest['routes'][number];
const routes: Route[] = [
  { method: 'GET', fullPath: '/raw', controller: Routes, methodName: 'raw', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
  { method: 'GET', fullPath: '/echo', controller: Routes, methodName: 'echo', parameters: [{ index: 0, source: 'input', fields: ['context'] }], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
];
const makeApp = (middleware: unknown[]) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: middleware as never },
}), { routes });

describe('createRequestIdMiddleware', () => {
  const app = makeApp([createRequestIdMiddleware()]);

  test('generates a UUID and echoes it, on raw and context routes', async () => {
    for (const path of ['/raw', '/echo']) {
      const id = (await app.fetch(new Request(`http://x${path}`))).headers.get('x-request-id');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const response = await app.fetch(new Request('http://x/echo'));
    const id = response.headers.get('x-request-id');
    expect(await response.json()).toEqual({ fromRequest: id, fromContext: id });
  });

  test('keeps a well-formed incoming ID, replaces a malformed one', async () => {
    expect((await app.fetch(new Request('http://x/raw', { headers: { 'x-request-id': 'lb-1234.abc' } }))).headers.get('x-request-id')).toBe('lb-1234.abc');
    for (const bad of ['has space', 'x'.repeat(200), 'aéb', '{"inject":1}']) {
      const id = (await app.fetch(new Request('http://x/raw', { headers: { 'x-request-id': bad } }))).headers.get('x-request-id');
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test('custom header, generator and untrusted incoming IDs', async () => {
    let counter = 0;
    const custom = makeApp([createRequestIdMiddleware({ header: 'X-Trace-Id', trustIncoming: false, generate: () => `t${++counter}` })]);
    const response = await custom.fetch(new Request('http://x/raw', { headers: { 'x-trace-id': 'from-client' } }));
    expect(response.headers.get('x-trace-id')).toBe('t1');
  });
});
