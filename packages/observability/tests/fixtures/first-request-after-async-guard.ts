// Runs in its own process: the very first request is the case under test, and module state in
// `@kivin/core` remembers any earlier request.
import { createApp, defineApplication, defineModule, type AppManifest } from '@kivin/core';
import { createMetrics, createServerTimingMiddleware, createTracingMiddleware } from '@kivin/observability';
import { createValibotAdapter } from '@kivin/valibot';

class AsyncGuard {
  async canActivate() {
    await Promise.resolve();
    return true;
  }
}

class Routes {
  ok() {
    return { ok: true };
  }
}

let spansEnded = 0;
const tracer = {
  startActiveSpan<F>(_name: string, _options: unknown, _context: unknown, fn: (span: never) => F): F {
    return fn({
      setAttribute() {},
      setStatus() {},
      recordException() {},
      end() {
        spansEnded += 1;
      },
    } as never);
  },
};

// One factory per process: any of them turning the flag on would hide another one forgetting to.
const factory = process.argv[2];
const metrics = factory === 'metrics' ? createMetrics({ processMetrics: false }) : undefined;
const middleware = metrics?.middleware
  ?? (factory === 'tracing' ? createTracingMiddleware({ tracer }) : createServerTimingMiddleware());

const manifest: AppManifest = {
  routes: [{
    method: 'GET', fullPath: '/ok', controller: Routes, methodName: 'ok', parameters: [], guards: [], middleware: [], filters: [],
    docs: { tags: [], security: [], responses: [] },
  }],
};

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  globals: { guards: [AsyncGuard], middleware: [middleware] },
}), manifest);

const server = app.listen({ port: 0, hostname: '127.0.0.1' });
const response = await fetch(new URL('/ok', server.url));
await response.text();
const rendered = metrics ? await metrics.handler().text() : '';
console.log(JSON.stringify({
  serverTiming: response.headers.get('server-timing') !== null,
  spansEnded,
  counted: rendered.includes('http_requests_total{method="GET",route="/ok",status="200"} 1'),
  inFlight: rendered.split('\n').find((line) => line.startsWith('http_requests_in_flight ')) ?? null,
}));
server.stop(true);
