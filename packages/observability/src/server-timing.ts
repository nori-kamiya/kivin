// Server-Timing header (equivalent of Hono's `timing`): total time plus metrics recorded by handlers.
import { afterResponse, enableAfterResponse, type NestLikeMiddleware, type RequestContext } from '@kivin/core';
import { withHeader } from './shared';

interface Metric {
  name: string;
  duration?: number;
  description?: string;
}

/** Records Server-Timing metrics for one request. */
export interface ServerTimingRecorder {
  /** Starts a timer; `end(name)` records its duration. */
  start(name: string, description?: string): void;
  end(name: string): void;
  /** Records a metric directly (duration in ms, optional). */
  add(name: string, duration?: number, description?: string): void;
  /** Times `work` (sync or async) under `name` and returns its result. */
  measure<T>(name: string, work: () => T, description?: string): T;
}

class Recorder implements ServerTimingRecorder {
  readonly metrics: Metric[] = [];
  private readonly started = new Map<string, { at: number; description: string | undefined }>();

  start(name: string, description?: string) {
    this.started.set(name, { at: performance.now(), description });
  }

  end(name: string) {
    const started = this.started.get(name);
    if (started) {
      this.started.delete(name);
      this.add(name, performance.now() - started.at, started.description);
    }
  }

  add(name: string, duration?: number, description?: string) {
    this.metrics.push({ name, ...(duration !== undefined ? { duration } : {}), ...(description !== undefined ? { description } : {}) });
  }

  measure<T>(name: string, work: () => T, description?: string): T {
    const at = performance.now();
    const done = () => this.add(name, performance.now() - at, description);
    const result = work();
    if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
      return Promise.resolve(result).finally(done) as T;
    }
    done();
    return result;
  }
}

const recorders = new WeakMap<Request, Recorder>();

/**
 * The Server-Timing recorder of a request (`context.request` or the raw request). Metrics recorded
 * without `createServerTimingMiddleware` in the pipeline are simply not sent.
 */
export function serverTiming(request: Request): ServerTimingRecorder {
  let recorder = recorders.get(request);
  if (!recorder) {
    recorder = new Recorder();
    recorders.set(request, recorder);
  }
  return recorder;
}

const TOKEN = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g;

function formatMetric(metric: Metric) {
  let value = metric.name.replace(TOKEN, '_') || 'metric';
  if (metric.duration !== undefined) {
    value += `;dur=${Math.round(metric.duration * 100) / 100}`;
  }
  if (metric.description !== undefined) {
    value += `;desc="${metric.description.replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, ' ')}"`;
  }
  return value;
}

export interface ServerTimingOptions {
  /** Adds a `total` metric for the whole pipeline. Default true. */
  total?: boolean;
  /**
   * Whether to send the header for this request. Timings reveal how long work takes (a timing side
   * channel), so in production you may limit it, e.g. to internal clients. Default: always.
   */
  enabled?: (request: Request) => boolean;
  /** `Timing-Allow-Origin` so browsers expose the timings to other origins (`true` = `*`). */
  crossOrigin?: boolean | string;
}

/**
 * Sends `Server-Timing` with the total time and every metric recorded through `serverTiming(request)`
 * (shown in the browser's network panel).
 */
export function createServerTimingMiddleware(options: ServerTimingOptions = {}) {
  enableAfterResponse();
  const total = options.total ?? true;
  const allowOrigin = options.crossOrigin === true ? '*' : options.crossOrigin || undefined;

  const run = (request: Request, next: () => Response | PromiseLike<Response>) => {
    if (options.enabled && !options.enabled(request)) {
      return next();
    }
    const startedAt = performance.now();
    const recorder = serverTiming(request) as Recorder;
    // On the final response, so error responses (filters, 4xx / 5xx) carry the timings too.
    afterResponse(request, (response) => {
      const metrics = total ? [...recorder.metrics, { name: 'total', duration: performance.now() - startedAt }] : recorder.metrics;
      if (metrics.length === 0) {
        return response;
      }
      let result = withHeader(response, 'server-timing', metrics.map(formatMetric).join(', '), true);
      if (allowOrigin) {
        result = withHeader(result, 'timing-allow-origin', allowOrigin);
      }
      return result;
    });
    return next();
  };

  return class ServerTimingMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      return run(context.request, next);
    }

    handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      return run(request, next);
    }
  };
}
