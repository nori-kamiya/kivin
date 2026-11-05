import { createApp, defineApplication, defineModule, HttpError, type AppManifest, type ExceptionFilter, type NestLikeMiddleware, type RequestContext } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

class Routes {
  crash() {
    throw new Error('db down');
  }

  async asyncCrash(_input: { context: RequestContext }) {
    throw new Error('async db down');
  }

  teapot() {
    throw new HttpError(418, 'tea');
  }

  handled() {
    throw new RangeError('handled by filter');
  }
}

class RangeFilter implements ExceptionFilter {
  catch(error: unknown) {
    return error instanceof RangeError ? Response.json({ message: 'filtered' }, { status: 409 }) : undefined;
  }
}

class PassThrough implements NestLikeMiddleware {
  handle(_context: RequestContext, next: () => Promise<Response>) {
    return next();
  }
}

type Route = AppManifest['routes'][number];
const route = (methodName: string, extra: Partial<Route> = {}): Route => ({
  method: 'GET', fullPath: `/${methodName}`, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});
const routes = [
  route('crash'),
  route('asyncCrash', { parameters: [{ index: 0, source: 'input', fields: ['context'] }] }),
  route('teapot'),
  route('handled', { filters: [RangeFilter] }),
  route('crashWithMiddleware', { methodName: 'crash', fullPath: '/crash-mw', middleware: [PassThrough] }),
];

describe('unhandled errors', () => {
  const consoleError = spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => consoleError.mockClear());

  const app = createApp(defineApplication({
    modules: [defineModule({ providers: [RangeFilter, PassThrough], controllers: [Routes], imports: [] })],
    schemaAdapter: createValibotAdapter(),
  }), { routes });

  test.each(['/crash', '/asyncCrash', '/crash-mw'])('%p answers a generic 500 and reports the cause once', async (path) => {
    const response = await app.fetch(new Request(`http://x${path}`));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: 'Internal Server Error' });
    // Only this file's reports are counted (other test files may log asynchronously).
    const reports = consoleError.mock.calls.filter((call) => call[0] === '[kivin] Unhandled error' && String(call[1]).includes('db down'));
    expect(reports).toHaveLength(1);
  });

  test('HttpErrors and filter-handled errors are not reported', async () => {
    expect((await app.fetch(new Request('http://x/teapot'))).status).toBe(418);
    expect((await app.fetch(new Request('http://x/handled'))).status).toBe(409);
    expect(consoleError.mock.calls.filter((call) => /tea|handled by filter/.test(String(call[1])))).toHaveLength(0);
  });
});
