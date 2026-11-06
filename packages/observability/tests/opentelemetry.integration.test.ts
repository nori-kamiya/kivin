import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createApp, defineApplication, defineModule, type AppManifest, type ExceptionFilter } from '@kivin/core';
import { createTracingMiddleware } from '@kivin/observability';
import { createValibotAdapter } from '@kivin/valibot';
import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';

class Teapot extends Error {}

class TeapotFilter implements ExceptionFilter {
  catch(error: unknown) {
    return error instanceof Teapot ? new Response('short and stout', { status: 418 }) : undefined;
  }
}

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer('kivin-integration');
const contextManager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(contextManager);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('upstream') });

class Routes {
  user() {
    return { id: 1 };
  }

  boom() {
    throw new Error('database is down');
  }

  teapot() {
    throw new Teapot();
  }

  // A child span after real I/O: the active context must survive the await.
  async child() {
    await fetch(upstream.url);
    await tracer.startActiveSpan('db.query', async (span) => {
      await Bun.sleep(1);
      span.end();
    });
    return { done: true };
  }
}

type Route = AppManifest['routes'][number];
const route = (fullPath: string, methodName: string): Route => ({
  method: 'GET', fullPath, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] },
});

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  globals: {
    middleware: [createTracingMiddleware({ tracer: trace.getTracer('kivin-integration'), propagation, context })],
    filters: [TeapotFilter],
  },
}), {
  routes: [route('/users/:id', 'user'), route('/boom', 'boom'), route('/teapot', 'teapot'), route('/child', 'child')],
});

trace.setGlobalTracerProvider(provider);
const server = app.listen({ port: 0, hostname: '127.0.0.1' });
const get = (path: string, headers: HeadersInit = {}) => fetch(new URL(path, server.url), { headers });
const finished = () => exporter.getFinishedSpans();
const serverSpan = () => {
  const span = finished().find((candidate) => candidate.kind === SpanKind.SERVER);
  if (!span) {
    throw new Error('no SERVER span was exported');
  }
  return span;
};

afterAll(async () => {
  server.stop(true);
  upstream.stop(true);
  context.disable();
  propagation.disable();
  trace.disable();
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe('createTracingMiddleware with the OpenTelemetry SDK', () => {
  test('a matched route exports a SERVER span with HTTP semantic-convention attributes', async () => {
    const response = await get('/users/42', { 'user-agent': 'kivin-test' });
    expect(response.status).toBe(200);

    const span = serverSpan();
    expect(span.name).toBe('GET /users/:id');
    expect(span.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/users/:id',
      'url.path': '/users/42',
      'url.scheme': 'http',
      'server.address': '127.0.0.1',
      'server.port': server.port,
      'user_agent.original': 'kivin-test',
      'http.response.status_code': 200,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  test('an unhandled exception marks the span as an error and records the exception', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const response = await get('/boom');
    consoleError.mockRestore();
    expect(response.status).toBe(500);

    const span = serverSpan();
    expect(span.attributes['http.response.status_code']).toBe(500);
    expect(span.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'database is down' });
    expect(span.events.map((event) => event.name)).toEqual(['exception']);
  });

  test('an exception a filter turns into a 4xx does not mark the span as an error', async () => {
    const response = await get('/teapot');
    expect(response.status).toBe(418);

    const span = serverSpan();
    expect(span.attributes['http.response.status_code']).toBe(418);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.events).toEqual([]);
  });

  test('a W3C traceparent header makes the span continue the caller trace', async () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const parentSpanId = 'b7ad6b7169203331';
    await get('/users/1', { traceparent: `00-${traceId}-${parentSpanId}-01` });

    const span = serverSpan();
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.parentSpanContext?.spanId).toBe(parentSpanId);
    expect(span.parentSpanContext?.isRemote).toBe(true);
  });

  test('a span started in a handler after awaited I/O is a child of the SERVER span', async () => {
    const response = await get('/child');
    expect(response.status).toBe(200);

    const child = finished().find((candidate) => candidate.name === 'db.query');
    const parent = serverSpan();
    expect(child?.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(child?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  test('requests running concurrently keep their child spans under their own SERVER spans', async () => {
    await Promise.all([get('/child'), get('/child'), get('/child')]);

    const servers = finished().filter((span) => span.kind === SpanKind.SERVER);
    const children = finished().filter((span) => span.name === 'db.query');
    expect(servers).toHaveLength(3);
    expect(children.map((span) => span.parentSpanContext?.spanId).sort())
      .toEqual(servers.map((span) => span.spanContext().spanId).sort());
  });
});
