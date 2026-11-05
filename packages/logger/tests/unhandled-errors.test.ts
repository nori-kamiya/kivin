import { createApp, defineApplication, defineModule, type AppManifest } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createLoggerModule, RequestLoggerMiddleware } from '../src/index';

class Routes {
  crash() {
    throw new Error('db down');
  }
}

const route = (methodName: string): AppManifest['routes'][number] => ({
  method: 'GET', fullPath: `/${methodName}`, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] },
});

describe('unhandled errors with the request logger', () => {
  const consoleError = spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => consoleError.mockClear());

  test('errors already logged by @kivin/logger are not printed again', async () => {
    const records: Array<{ message: string }> = [];
    const logged = createApp(defineApplication({
      modules: [createLoggerModule({ sink: (record) => records.push(record as { message: string }) }), defineModule({ providers: [], controllers: [Routes], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      globals: { guards: [], middleware: [RequestLoggerMiddleware], filters: [] },
    }), { routes: [route('crash')] });
    expect((await logged.fetch(new Request('http://x/crash'))).status).toBe(500);
    expect(records.map((record) => record.message)).toContain('request.error');
    expect(consoleError.mock.calls.filter((call) => String(call[1]).includes('db down'))).toHaveLength(0);
  });
});
