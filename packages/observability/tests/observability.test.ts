import { createApp, defineApplication, defineModule, HttpError, type AppManifest, type ExceptionFilter, type ManifestRoute, type RequestContext } from '@kivinjs/core';
import { createHealthCheck, createMetrics, createServerTimingMiddleware, createTracingMiddleware, MetricsRegistry, serverTiming, type SpanLike } from '@kivinjs/observability';
import { describe, expect, test } from 'bun:test';

class GoneError extends Error {}

/** Maps a domain error to 410 outside the middleware chain (as exception filters do). */
class GoneFilter implements ExceptionFilter {
  catch(error: unknown) {
    return error instanceof GoneError ? Response.json({ message: 'gone' }, { status: 410 }) : undefined;
  }
}

class Routes {
  async user({ params, context }: { params: { id: string }; context: RequestContext }) {
    await serverTiming(context.request).measure('db', () => Bun.sleep(2), 'load "user"');
    if (params.id === 'missing') {
      throw new HttpError(404, 'Not Found');
    }
    if (params.id === 'crash') {
      throw new Error('crashed');
    }
    if (params.id === 'gone') {
      throw new GoneError();
    }
    return { id: params.id };
  }

  plain() {
    return { ok: true };
  }
}

type Route = AppManifest['routes'][number];
const routes: Route[] = [
  { method: 'GET', fullPath: '/users/:id', controller: Routes, methodName: 'user', parameters: [{ index: 0, source: 'input', fields: ['params', 'context'] }], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
  { method: 'GET', fullPath: '/plain', controller: Routes, methodName: 'plain', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
];
const appWith = (middleware: unknown[]) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  globals: { middleware: middleware as never, filters: [GoneFilter] },
}), { routes });
const quiet = async <T>(work: () => Promise<T>) => {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await work();
  } finally {
    console.error = original;
  }
};

describe('Server-Timing', () => {
  test('total plus metrics recorded by the handler, quoted descriptions', async () => {
    const app = appWith([createServerTimingMiddleware({ crossOrigin: true })]);
    const response = await app.fetch(new Request('http://localhost/users/1'));
    const header = response.headers.get('server-timing')!;
    expect(header).toMatch(/^db;dur=\d+(\.\d+)?;desc="load \\"user\\"", total;dur=\d+(\.\d+)?$/);
    expect(Number(/db;dur=([\d.]+)/.exec(header)![1])).toBeGreaterThanOrEqual(1);
    expect(response.headers.get('timing-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({ id: '1' });
  });

  test('error responses (filters, HttpError) carry the header too', async () => {
    const app = appWith([createServerTimingMiddleware()]);
    for (const id of ['missing', 'gone']) {
      const response = await app.fetch(new Request(`http://localhost/users/${id}`));
      expect(response.status).toBe(id === 'missing' ? 404 : 410);
      expect(response.headers.get('server-timing')).toMatch(/total;dur=/);
    }
  });

  test('enabled() can turn it off per request; total can be omitted', async () => {
    const off = appWith([createServerTimingMiddleware({ enabled: (request) => request.headers.has('x-debug') })]);
    expect((await off.fetch(new Request('http://localhost/plain'))).headers.get('server-timing')).toBeNull();
    expect((await off.fetch(new Request('http://localhost/plain', { headers: { 'x-debug': '1' } }))).headers.get('server-timing')).toMatch(/^total;dur=/);
    const noTotal = appWith([createServerTimingMiddleware({ total: false })]);
    expect((await noTotal.fetch(new Request('http://localhost/plain'))).headers.get('server-timing')).toBeNull();
  });

  test('recorder API: start / end / add, names sanitised', () => {
    const request = new Request('http://localhost/');
    const timing = serverTiming(request);
    expect(serverTiming(request)).toBe(timing);
    timing.start('cache read');
    timing.end('cache read');
    timing.end('never-started');
    timing.add('region', undefined, 'eu');
    expect(timing.measure('sync', () => 42)).toBe(42);
  });
});

describe('Prometheus metrics', () => {
  test('counts by method / route template / status, histogram and in-flight, text exposition', async () => {
    const metrics = createMetrics({ processMetrics: false, buckets: [0.001, 1] });
    const app = appWith([metrics.middleware]);
    await app.fetch(new Request('http://localhost/users/1'));
    await app.fetch(new Request('http://localhost/users/2'));
    await app.fetch(new Request('http://localhost/users/missing'));
    await quiet(() => app.fetch(new Request('http://localhost/users/crash')));
    await app.fetch(new Request('http://localhost/users/gone'));
    await app.fetch(new Request('http://localhost/plain'));
    await app.fetch(new Request('http://localhost/nope'));

    const response = metrics.handler();
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const text = await response.text();
    expect(text).toContain('# TYPE http_requests_total counter\n');
    expect(text).toContain('http_requests_total{method="GET",route="/users/:id",status="200"} 2\n');
    expect(text).toContain('http_requests_total{method="GET",route="/users/:id",status="404"} 1\n');
    expect(text).toContain('http_requests_total{method="GET",route="/users/:id",status="500"} 1\n');
    expect(text).toContain('http_requests_total{method="GET",route="/plain",status="200"} 1\n');
    // The filter's 410, not the 500 the thrown error would suggest.
    expect(text).toContain('http_requests_total{method="GET",route="/users/:id",status="410"} 1\n');
    expect(text).not.toContain('/nope');
    // A request that reached no route is counted, under one label value and without a duration.
    expect(text).toContain('http_requests_total{method="GET",route="(unmatched)",status="404"} 1\n');
    expect(text).not.toContain('http_request_duration_seconds_count{method="GET",route="(unmatched)"');
    expect(text).toContain('# TYPE http_request_duration_seconds histogram\n');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/users/:id",status="200",le="1"} 2\n');
    expect(text).toContain('http_request_duration_seconds_bucket{method="GET",route="/users/:id",status="200",le="+Inf"} 2\n');
    expect(text).toContain('http_request_duration_seconds_count{method="GET",route="/users/:id",status="200"} 2\n');
    expect(text).toContain('http_requests_in_flight 0\n');
  });

  test('requests no route handled: 404 / 405 / OPTIONS / onRequest answers, over native routes too', async () => {
    const metrics = createMetrics({ processMetrics: false });
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      globals: { middleware: [metrics.middleware] },
      onRequest: (request) => (new URL(request.url).pathname === '/old' ? Response.redirect('http://localhost/plain', 301) : undefined),
    }), { routes });
    await app.fetch(new Request('http://localhost/missing'));
    await app.fetch(new Request('http://localhost/plain', { method: 'DELETE' }));
    await app.fetch(new Request('http://localhost/users/1', { method: 'POST' }));
    await app.fetch(new Request('http://localhost/plain', { method: 'OPTIONS' }));
    await app.fetch(new Request('http://localhost/old'));
    await app.fetch(new Request('http://localhost/missing', { method: 'PROPFIND' }));
    await app.fetch(new Request('http://localhost/plain'));

    const server = app.listen({ port: 0 });
    try {
      expect((await fetch(new URL('/nope', server.url))).status).toBe(404);
      expect((await fetch(new URL('/plain', server.url), { method: 'PUT' })).status).toBe(405);
      expect((await fetch(new URL('/plain', server.url))).status).toBe(200);
    } finally {
      await server.stop(true);
    }

    const text = await metrics.handler().text();
    expect(text).toContain('http_requests_total{method="GET",route="(unmatched)",status="404"} 2\n');
    expect(text).toContain('http_requests_total{method="DELETE",route="(unmatched)",status="405"} 1\n');
    expect(text).toContain('http_requests_total{method="POST",route="(unmatched)",status="405"} 1\n');
    expect(text).toContain('http_requests_total{method="PUT",route="(unmatched)",status="405"} 1\n');
    expect(text).toContain('http_requests_total{method="OPTIONS",route="(unmatched)",status="204"} 1\n');
    expect(text).toContain('http_requests_total{method="GET",route="(unmatched)",status="301"} 1\n');
    // Unknown method tokens share one label value.
    expect(text).toContain('http_requests_total{method="_OTHER",route="(unmatched)",status="404"} 1\n');
    expect(text).toContain('http_requests_total{method="GET",route="/plain",status="200"} 2\n');
    expect(text).toContain('http_requests_in_flight 0\n');
  });

  test('unmatchedRoute renames the label or turns the count off', async () => {
    const renamed = createMetrics({ processMetrics: false, unmatchedRoute: 'other' });
    await appWith([renamed.middleware]).fetch(new Request('http://localhost/nope'));
    expect(await renamed.handler().text()).toContain('http_requests_total{method="GET",route="other",status="404"} 1\n');

    const off = createMetrics({ processMetrics: false, unmatchedRoute: false });
    await appWith([off.middleware]).fetch(new Request('http://localhost/nope'));
    expect(await off.handler().text()).not.toContain('status="404"');
  });

  test('process metrics, custom metrics, escaping and validation', async () => {
    const registry = new MetricsRegistry();
    const metrics = createMetrics({ registry, prefix: 'api_' });
    const jobs = registry.counter<'queue'>({ name: 'jobs_total', help: 'Jobs\nprocessed \\ total', labelNames: ['queue'] });
    jobs.inc({ queue: 'mail "high"\n' }, 3);
    const temperature = registry.gauge({ name: 'temperature', help: 'Temperature.' });
    temperature.set(undefined, -1.5);
    const text = await metrics.handler().text();
    expect(text).toContain('# HELP jobs_total Jobs\\nprocessed \\\\ total\n');
    expect(text).toContain('jobs_total{queue="mail \\"high\\"\\n"} 3\n');
    expect(text).toContain('temperature -1.5\n');
    expect(text).toMatch(/process_resident_memory_bytes \d+\n/);
    expect(text).toMatch(/process_cpu_seconds_total [\d.e-]+\n/);
    expect(text).toContain('api_requests_in_flight 0\n');
    expect(() => registry.counter({ name: 'jobs_total', help: 'dup' })).toThrow();
    expect(() => registry.counter({ name: 'bad-name', help: 'x' })).toThrow(TypeError);
    expect(() => registry.counter({ name: 'ok', help: 'x', labelNames: ['le'] })).toThrow(TypeError);
    expect(() => jobs.inc({ queue: 'x' }, -1)).toThrow(RangeError);
    expect(jobs.get({ queue: 'mail "high"\n' })).toBe(3);
  });
});

describe('health checks', () => {
  test('liveness always 200; readiness runs checks concurrently, 503 with details on failure', async () => {
    let dbUp = true;
    const health = createHealthCheck({
      timeoutMs: 50,
      checks: {
        db: () => {
          if (!dbUp) throw new Error('connection refused');
        },
        cache: async () => true,
        slow: () => (dbUp ? undefined : Bun.sleep(200)),
      },
    });
    expect((await health.liveness()).status).toBe(200);
    const ok = await health.readiness();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toMatchObject({ status: 'ok', checks: { db: { status: 'ok' }, cache: { status: 'ok' }, slow: { status: 'ok' } } });

    dbUp = false;
    const failing = await health.readiness();
    expect(failing.status).toBe(503);
    expect(await failing.json()).toMatchObject({
      status: 'error',
      checks: { db: { status: 'error', error: 'connection refused' }, cache: { status: 'ok' }, slow: { status: 'error', error: 'timed out after 50ms' } },
    });
  });

  test('setReady(false) fails readiness without running checks; routes() for listen; details off', async () => {
    let ran = 0;
    const health = createHealthCheck({ details: false, checks: { a: () => { ran += 1; return false; } } });
    const failed = await health.readiness();
    expect(await failed.json()).toEqual({ status: 'error', failed: ['a'] });
    health.setReady(false);
    expect(health.ready).toBe(false);
    const draining = await health.readiness();
    expect(draining.status).toBe(503);
    expect(ran).toBe(1);

    const app = createApp(defineApplication({ modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })] }), { routes });
    const server = app.listen({ port: 0, hostname: '127.0.0.1', routes: createHealthCheck().routes({ readiness: '/ready' }) });
    try {
      expect((await fetch(new URL('/livez', server.url))).status).toBe(200);
      expect(await (await fetch(new URL('/ready', server.url))).json()).toEqual({ status: 'ok' });
      expect((await fetch(new URL('/ready', server.url), { method: 'HEAD' })).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('OpenTelemetry tracing', () => {
  interface RecordedSpan {
    name: string;
    options: { kind?: number; attributes?: Record<string, unknown> };
    parent: unknown;
    attributes: Record<string, unknown>;
    status?: { code: number; message?: string };
    exceptions: unknown[];
    ended: boolean;
  }
  const createTracer = () => {
    const spans: RecordedSpan[] = [];
    const tracer = {
      startActiveSpan<F>(name: string, options: RecordedSpan['options'], parent: unknown, fn: (span: SpanLike) => F): F {
        const record: RecordedSpan = { name, options, parent, attributes: {}, exceptions: [], ended: false };
        spans.push(record);
        return fn({
          setAttribute: (key, value) => {
            record.attributes[key] = value;
          },
          setStatus: (status) => {
            record.status = status;
          },
          recordException: (exception) => {
            record.exceptions.push(exception);
          },
          end: () => {
            record.ended = true;
          },
        });
      },
    };
    return { tracer, spans };
  };

  test('server span per request with HTTP semantic-convention attributes and status', async () => {
    const { tracer, spans } = createTracer();
    const app = appWith([createTracingMiddleware({ tracer, attributes: () => ({ 'app.tenant': 'acme' }) })]);
    await app.fetch(new Request('http://example.test:8080/users/7', { headers: { 'user-agent': 'test-agent' } }));
    await app.fetch(new Request('http://example.test/users/missing'));
    await quiet(() => app.fetch(new Request('http://example.test/users/crash')));
    await app.fetch(new Request('http://example.test/users/gone'));

    expect(spans.map((span) => span.name)).toEqual(['GET /users/:id', 'GET /users/:id', 'GET /users/:id', 'GET /users/:id']);
    const [ok, missing, crash, gone] = spans as [RecordedSpan, RecordedSpan, RecordedSpan, RecordedSpan];
    expect(ok.options.kind).toBe(1);
    expect(ok.options.attributes).toEqual({
      'http.request.method': 'GET', 'http.route': '/users/:id', 'url.path': '/users/7', 'url.scheme': 'http',
      'server.address': 'example.test', 'server.port': 8080, 'user_agent.original': 'test-agent', 'app.tenant': 'acme',
    });
    expect(ok.attributes['http.response.status_code']).toBe(200);
    expect(ok.status).toBeUndefined();
    expect(missing.attributes['http.response.status_code']).toBe(404);
    expect(missing.status).toBeUndefined();
    expect(crash.attributes['http.response.status_code']).toBe(500);
    expect(crash.status).toEqual({ code: 2, message: 'crashed' });
    expect((crash.exceptions[0] as Error).message).toBe('crashed');
    // A thrown domain error the filter answers with 410 is not a server error.
    expect(gone.attributes['http.response.status_code']).toBe(410);
    expect(gone.status).toBeUndefined();
    expect(gone.exceptions).toEqual([]);
    expect(spans.every((span) => span.ended)).toBe(true);
  });

  test('continues incoming traces through propagation.extract', async () => {
    const { tracer, spans } = createTracer();
    const active = { name: 'root-context' };
    const extracted: unknown[] = [];
    const propagation = {
      extract(context: unknown, carrier: Headers, getter: { get(carrier: Headers, key: string): string | undefined; keys(carrier: Headers): string[] }) {
        extracted.push([context, getter.get(carrier, 'traceparent'), getter.keys(carrier).includes('traceparent')]);
        return { parentOf: getter.get(carrier, 'traceparent') };
      },
    };
    const app = appWith([createTracingMiddleware({ tracer, propagation, context: { active: () => active } })]);
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await app.fetch(new Request('http://localhost/plain', { headers: { traceparent } }));
    expect(extracted).toEqual([[active, traceparent, true]]);
    expect(spans[0]!.parent).toEqual({ parentOf: traceparent });
    expect(spans[0]!.name).toBe('GET /plain');
  });
});

// Route type is exported for custom labels.
const _routeLabel = (route: ManifestRoute<unknown>) => route.fullPath;
void _routeLabel;

describe('the first request of a process behind an async guard', () => {
  const nothing = { serverTiming: false, spansEnded: 0, counted: false, inFlight: null };

  test.each([
    ['metrics', { ...nothing, counted: true, inFlight: 'http_requests_in_flight 0' }],
    ['tracing', { ...nothing, spansEnded: 1 }],
    ['server-timing', { ...nothing, serverTiming: true }],
  ])('%s finishes on the native route', (factory, expected) => {
    const fixture = new URL('./fixtures/first-request-after-async-guard.ts', import.meta.url).pathname;
    const result = Bun.spawnSync(['bun', 'run', fixture, factory], { cwd: import.meta.dir });
    expect(result.stderr.toString()).toBe('');
    expect(JSON.parse(result.stdout.toString())).toEqual(expected);
  });
});
