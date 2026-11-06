import { createApp, defineApplication, defineModule, type AppManifest } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { expect, test } from 'bun:test';
import { createLoggerModule, RequestLoggerMiddleware } from '@kivin/logger';
import { createRequestIdMiddleware } from '../src/index';

class Routes {
  raw() {
    return { ok: true };
  }
}

test('the request logger records the ID createRequestIdMiddleware validated', async () => {
  const records: Array<Record<string, unknown>> = [];
  const app = createApp(defineApplication({
    modules: [createLoggerModule({ sink: (record) => records.push(record as Record<string, unknown>) }), defineModule({ providers: [], controllers: [Routes], imports: [] })],
    schemaAdapter: createValibotAdapter(),
    // The ID middleware runs first (outer), so the logger sees the assigned ID.
    globals: { middleware: [createRequestIdMiddleware(), RequestLoggerMiddleware] },
  }), { routes: [{ method: 'GET', fullPath: '/raw', controller: Routes, methodName: 'raw', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } } as AppManifest['routes'][number]] });
  const response = await app.fetch(new Request('http://x/raw', { headers: { 'x-request-id': 'has space' } }));
  const id = response.headers.get('x-request-id');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((record) => record.requestId === id)).toBe(true);
});
