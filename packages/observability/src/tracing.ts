// OpenTelemetry server spans without a dependency: the middleware takes the tracer (and optionally
// the propagation / context APIs) from `@opentelemetry/api`, typed structurally.
import { afterResponse, enableAfterResponse, getClientAddress, type ManifestRoute, type NestLikeMiddleware, type RequestContext } from '@kivin/core';

export type AttributeValue = string | number | boolean;

/** The part of an OpenTelemetry `Span` the middleware uses. */
export interface SpanLike {
  setAttribute(key: string, value: AttributeValue): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: unknown): unknown;
  end(): void;
}

/** The part of an OpenTelemetry `Tracer` the middleware uses (`trace.getTracer(name)`). */
export interface TracerLike {
  startActiveSpan<F>(name: string, options: { kind?: number; attributes?: Record<string, AttributeValue> }, context: unknown, fn: (span: SpanLike) => F): F;
}

/** `propagation` from `@opentelemetry/api`. */
export interface PropagationLike {
  extract(context: unknown, carrier: Headers, getter: { get(carrier: Headers, key: string): string | undefined; keys(carrier: Headers): string[] }): unknown;
}

/** `context` from `@opentelemetry/api`. */
export interface ContextApiLike {
  active(): unknown;
}

export interface TracingOptions {
  tracer: TracerLike;
  /** With `context`, continues traces from incoming `traceparent` / `baggage` headers. */
  propagation?: PropagationLike;
  context?: ContextApiLike;
  /** Span name. Default `"<METHOD> <route template>"`. */
  spanName?: (request: Request, route: ManifestRoute<unknown>) => string;
  /** Extra attributes for each span. */
  attributes?: (request: Request, route: ManifestRoute<unknown>) => Record<string, AttributeValue>;
}

const SPAN_KIND_SERVER = 1;
const isThenable = (value: unknown): value is PromiseLike<Response> => typeof (value as PromiseLike<Response> | null)?.then === 'function';
const STATUS_ERROR = 2;

const headerGetter = {
  get: (carrier: Headers, key: string) => carrier.get(key) ?? undefined,
  keys: (carrier: Headers) => [...carrier.keys()],
};

function requestAttributes(request: Request, route: ManifestRoute<unknown>): Record<string, AttributeValue> {
  const url = new URL(request.url);
  const attributes: Record<string, AttributeValue> = {
    'http.request.method': request.method,
    'http.route': route.fullPath,
    'url.path': url.pathname,
    'url.scheme': url.protocol.replace(':', ''),
    'server.address': url.hostname,
  };
  if (url.port) {
    attributes['server.port'] = Number(url.port);
  }
  const userAgent = request.headers.get('user-agent');
  if (userAgent) {
    attributes['user_agent.original'] = userAgent;
  }
  const clientAddress = getClientAddress(request);
  if (clientAddress) {
    attributes['client.address'] = clientAddress;
  }
  return attributes;
}

/**
 * A `SERVER` span per request with the stable HTTP semantic-convention attributes
 * (`http.request.method`, `http.route`, `url.path`, `http.response.status_code`, …). The span ends
 * with the final response (after exception filters); a 5xx marks it as an error and records the
 * exception behind it. The span is active while the
 * route runs, so instrumented clients (fetch, database drivers) become its children.
 *
 * ```ts
 * import { context, propagation, trace } from '@opentelemetry/api';
 * const Tracing = createTracingMiddleware({ tracer: trace.getTracer('my-app'), propagation, context });
 * defineApplication({ ..., globals: { middleware: [Tracing] } });   // first, to cover everything
 * ```
 */
export function createTracingMiddleware(options: TracingOptions) {
  enableAfterResponse();
  const { tracer, propagation, context: contextApi } = options;
  const spanName = options.spanName ?? ((request: Request, route: ManifestRoute<unknown>) => `${request.method} ${route.fullPath}`);

  const run = (request: Request, route: ManifestRoute<unknown>, next: () => Response | PromiseLike<Response>) => {
    const parent = propagation && contextApi ? propagation.extract(contextApi.active(), request.headers, headerGetter) : contextApi?.active();
    const attributes = { ...requestAttributes(request, route), ...options.attributes?.(request, route) };
    return tracer.startActiveSpan(spanName(request, route), { kind: SPAN_KIND_SERVER, attributes }, parent, (span) => {
      let thrown: { error: unknown } | undefined;
      // The span ends with the final response (after exception filters), so its status is what the
      // client got; the exception behind a 5xx is recorded.
      afterResponse(request, (response) => {
        span.setAttribute('http.response.status_code', response.status);
        if (response.status >= 500) {
          if (thrown) {
            span.recordException(thrown.error);
          }
          span.setStatus({ code: STATUS_ERROR, ...(thrown?.error instanceof Error ? { message: thrown.error.message } : {}) });
        }
        span.end();
      });
      try {
        const result = next();
        return isThenable(result)
          ? Promise.resolve(result).catch((error: unknown) => {
              thrown = { error };
              throw error;
            })
          : result;
      } catch (error) {
        thrown = { error };
        throw error;
      }
    });
  };

  return class TracingMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>, route: ManifestRoute<unknown>) {
      return run(context.request, route, next);
    }

    handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>, route: ManifestRoute<unknown>) {
      return run(request, route, next);
    }
  };
}
