import { createApp, defineApplication, defineModule, getClientAddress, type AppManifest, type RequestContext } from '@kivinjs/core';
import { createTimeoutMiddleware } from '../src/index';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

class Routes {
  fast() {
    return { ok: true };
  }

  async slow() {
    await Bun.sleep(200);
    return { ok: 'late' };
  }

  whoami({ context }: { context: RequestContext }) {
    return { address: getClientAddress(context.request) ?? null };
  }
}

type Route = AppManifest['routes'][number];
const route = (methodName: string, extra: Partial<Route> = {}): Route => ({
  method: 'GET', fullPath: `/${methodName}`, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});
const routes = [route('fast'), route('slow'), route('whoami', { parameters: [{ index: 0, source: 'input', fields: ['context'] }] })];
const makeApp = (middleware: unknown[]) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: middleware as never },
}), { routes });

describe('createTimeoutMiddleware', () => {
  const app = makeApp([createTimeoutMiddleware(50)]);

  test('slow requests get 504, fast ones are unaffected', async () => {
    const slow = await app.fetch(new Request('http://x/slow'));
    expect(slow.status).toBe(504);
    expect(await slow.json()).toEqual({ message: 'Request timed out' });
    expect(await (await app.fetch(new Request('http://x/fast'))).json()).toEqual({ ok: true });
  });

  test('status is configurable and invalid durations are rejected', async () => {
    const custom = makeApp([createTimeoutMiddleware(10, { status: 503, message: 'busy' })]);
    const response = await custom.fetch(new Request('http://x/slow'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'busy' });
    expect(() => createTimeoutMiddleware(0)).toThrow('positive');
  });
});

