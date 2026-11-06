// Prometheus metrics: a small dependency-free registry (counters, gauges, histograms with labels),
// request metrics middleware and a `/metrics` handler in the text exposition format (0.0.4).
import { afterResponse, enableAfterResponse, type ManifestRoute, type NestLikeMiddleware, type RequestContext } from '@kivin/core';

export type Labels = Record<string, string | number>;

interface MetricOptions<TLabel extends string> {
  name: string;
  help: string;
  labelNames?: readonly TLabel[];
}

interface Collectable {
  readonly name: string;
  render(): string;
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const escapeHelp = (text: string) => text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const escapeLabelValue = (text: string) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function formatNumber(value: number) {
  if (Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === Infinity) {
    return '+Inf';
  }
  if (value === -Infinity) {
    return '-Inf';
  }
  return String(value);
}

abstract class Metric<TLabel extends string> implements Collectable {
  readonly name: string;
  readonly help: string;
  protected readonly labelNames: readonly TLabel[];

  constructor(options: MetricOptions<TLabel>, private readonly type: string) {
    if (!METRIC_NAME.test(options.name)) {
      throw new TypeError(`Invalid metric name: ${options.name}`);
    }
    for (const label of options.labelNames ?? []) {
      if (!LABEL_NAME.test(label) || label.startsWith('__') || label === 'le') {
        throw new TypeError(`Invalid label name for ${options.name}: ${label}`);
      }
    }
    this.name = options.name;
    this.help = options.help;
    this.labelNames = options.labelNames ?? [];
  }

  /** Stable series key and the rendered `{a="1",b="2"}` part. */
  protected series(labels: Partial<Record<TLabel, string | number>> | undefined): [string, string] {
    if (this.labelNames.length === 0) {
      return ['', ''];
    }
    const parts: string[] = [];
    for (const label of this.labelNames) {
      const value = labels?.[label];
      parts.push(`${label}="${escapeLabelValue(value === undefined ? '' : String(value))}"`);
    }
    const rendered = parts.join(',');
    return [rendered, `{${rendered}}`];
  }

  protected header() {
    return `# HELP ${this.name} ${escapeHelp(this.help)}\n# TYPE ${this.name} ${this.type}\n`;
  }

  abstract render(): string;
}

export class Counter<TLabel extends string = string> extends Metric<TLabel> {
  private readonly values = new Map<string, { labels: string; value: number }>();

  constructor(options: MetricOptions<TLabel>) {
    super(options, 'counter');
  }

  inc(labels?: Partial<Record<TLabel, string | number>>, amount = 1) {
    if (!(amount >= 0)) {
      throw new RangeError(`Counter ${this.name} can only increase`);
    }
    const [key, rendered] = this.series(labels);
    const entry = this.values.get(key);
    if (entry) {
      entry.value += amount;
    } else {
      this.values.set(key, { labels: rendered, value: amount });
    }
  }

  get(labels?: Partial<Record<TLabel, string | number>>) {
    return this.values.get(this.series(labels)[0])?.value ?? 0;
  }

  render() {
    let text = this.header();
    for (const { labels, value } of this.values.values()) {
      text += `${this.name}${labels} ${formatNumber(value)}\n`;
    }
    return text;
  }
}

export class Gauge<TLabel extends string = string> extends Metric<TLabel> {
  private readonly values = new Map<string, { labels: string; value: number }>();
  private readonly collectors: Array<(gauge: Gauge<TLabel>) => void> = [];

  constructor(options: MetricOptions<TLabel> & { collect?: (gauge: Gauge<TLabel>) => void }) {
    super(options, 'gauge');
    if (options.collect) {
      this.collectors.push(options.collect);
    }
  }

  set(labels: Partial<Record<TLabel, string | number>> | undefined, value: number) {
    const [key, rendered] = this.series(labels);
    this.values.set(key, { labels: rendered, value });
  }

  inc(labels?: Partial<Record<TLabel, string | number>>, amount = 1) {
    const [key, rendered] = this.series(labels);
    const entry = this.values.get(key);
    if (entry) {
      entry.value += amount;
    } else {
      this.values.set(key, { labels: rendered, value: amount });
    }
  }

  dec(labels?: Partial<Record<TLabel, string | number>>, amount = 1) {
    this.inc(labels, -amount);
  }

  get(labels?: Partial<Record<TLabel, string | number>>) {
    return this.values.get(this.series(labels)[0])?.value ?? 0;
  }

  render() {
    for (const collect of this.collectors) {
      collect(this);
    }
    let text = this.header();
    for (const { labels, value } of this.values.values()) {
      text += `${this.name}${labels} ${formatNumber(value)}\n`;
    }
    return text;
  }
}

/** Default buckets (seconds), as the Prometheus client libraries. */
export const DEFAULT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram<TLabel extends string = string> extends Metric<TLabel> {
  private readonly buckets: readonly number[];
  private readonly values = new Map<string, { labels: string; counts: number[]; sum: number; count: number }>();

  constructor(options: MetricOptions<TLabel> & { buckets?: readonly number[] }) {
    super(options, 'histogram');
    const buckets = [...(options.buckets ?? DEFAULT_DURATION_BUCKETS)].sort((left, right) => left - right);
    if (buckets.length === 0 || buckets.some((bucket, index) => !Number.isFinite(bucket) || bucket === buckets[index - 1])) {
      throw new TypeError(`Histogram ${options.name}: buckets must be distinct finite numbers`);
    }
    this.buckets = buckets;
  }

  observe(labels: Partial<Record<TLabel, string | number>> | undefined, value: number) {
    const [key, rendered] = this.series(labels);
    let entry = this.values.get(key);
    if (!entry) {
      entry = { labels: rendered, counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.values.set(key, entry);
    }
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (value <= this.buckets[index]!) {
        entry.counts[index]! += 1;
      }
    }
    entry.sum += value;
    entry.count += 1;
  }

  render() {
    let text = this.header();
    for (const { labels, counts, sum, count } of this.values.values()) {
      const prefix = labels ? `${labels.slice(1, -1)},` : '';
      this.buckets.forEach((bucket, index) => {
        text += `${this.name}_bucket{${prefix}le="${formatNumber(bucket)}"} ${counts[index]}\n`;
      });
      text += `${this.name}_bucket{${prefix}le="+Inf"} ${count}\n`;
      text += `${this.name}_sum${labels} ${formatNumber(sum)}\n`;
      text += `${this.name}_count${labels} ${count}\n`;
    }
    return text;
  }
}

/** Metric registry; `render()` returns the Prometheus text exposition. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Collectable>();

  private add<T extends Collectable>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Metric ${metric.name} is already registered`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter<TLabel extends string = never>(options: MetricOptions<TLabel>) {
    return this.add(new Counter<TLabel>(options));
  }

  gauge<TLabel extends string = never>(options: MetricOptions<TLabel> & { collect?: (gauge: Gauge<TLabel>) => void }) {
    return this.add(new Gauge<TLabel>(options));
  }

  histogram<TLabel extends string = never>(options: MetricOptions<TLabel> & { buckets?: readonly number[] }) {
    return this.add(new Histogram<TLabel>(options));
  }

  render() {
    return [...this.metrics.values()].map((metric) => metric.render()).join('');
  }
}

export interface MetricsOptions {
  /** Registry to add the metrics to (default: a new one). */
  registry?: MetricsRegistry;
  /** Prefix for the request metric names. Default `http_`. */
  prefix?: string;
  /** Duration histogram buckets in seconds. */
  buckets?: readonly number[];
  /** Process metrics (CPU, memory, start time). Default true. */
  processMetrics?: boolean;
  /**
   * The `route` label. Default: the route template (`/users/:id`), never the raw path, so the number
   * of series stays bounded.
   */
  routeLabel?: (route: ManifestRoute<unknown>, request: Request) => string;
}

export const CONTENT_TYPE_PROMETHEUS = 'text/plain; version=0.0.4; charset=utf-8';

function registerProcessMetrics(registry: MetricsRegistry) {
  const startTime = Date.now() / 1000 - process.uptime();
  registry.gauge({ name: 'process_start_time_seconds', help: 'Start time of the process since unix epoch in seconds.', collect: (gauge) => gauge.set(undefined, Math.round(startTime)) });
  registry.gauge({
    name: 'process_cpu_seconds_total',
    help: 'Total user and system CPU time spent in seconds.',
    collect: (gauge) => {
      const usage = process.cpuUsage();
      gauge.set(undefined, (usage.user + usage.system) / 1e6);
    },
  });
  registry.gauge({ name: 'process_resident_memory_bytes', help: 'Resident memory size in bytes.', collect: (gauge) => gauge.set(undefined, process.memoryUsage().rss) });
  registry.gauge({ name: 'process_heap_bytes', help: 'JavaScript heap in use in bytes.', collect: (gauge) => gauge.set(undefined, process.memoryUsage().heapUsed) });
}

/**
 * Request metrics for Prometheus:
 *
 * - `http_requests_total{method,route,status}` (counter)
 * - `http_request_duration_seconds{method,route,status}` (histogram)
 * - `http_requests_in_flight` (gauge)
 *
 * Put `middleware` in `globals.middleware` (it counts requests that matched a route, with the status
 * of the final response, after exception filters) and serve
 * `handler` from a native route, ideally not exposed publicly:
 *
 * ```ts
 * const metrics = createMetrics();
 * defineApplication({ ..., globals: { middleware: [metrics.middleware] } });
 * app.listen({ port, routes: { '/metrics': metrics.handler } });
 * ```
 */
export function createMetrics(options: MetricsOptions = {}) {
  enableAfterResponse();
  const registry = options.registry ?? new MetricsRegistry();
  const prefix = options.prefix ?? 'http_';
  const routeLabel = options.routeLabel ?? ((route: ManifestRoute<unknown>) => route.fullPath);
  const requests = registry.counter<'method' | 'route' | 'status'>({ name: `${prefix}requests_total`, help: 'HTTP requests handled.', labelNames: ['method', 'route', 'status'] });
  const durations = registry.histogram<'method' | 'route' | 'status'>({ name: `${prefix}request_duration_seconds`, help: 'HTTP request duration in seconds.', labelNames: ['method', 'route', 'status'], ...(options.buckets ? { buckets: options.buckets } : {}) });
  const inFlight = registry.gauge({ name: `${prefix}requests_in_flight`, help: 'HTTP requests being handled.' });
  inFlight.set(undefined, 0);
  if (options.processMetrics !== false) {
    registerProcessMetrics(registry);
  }

  // The status comes from the final response (after exception filters), not from what `next()`
  // returned or threw: a domain error a filter maps to 404 is counted as 404.
  const run = (request: Request, route: ManifestRoute<unknown>, next: () => Response | PromiseLike<Response>) => {
    const startedAt = performance.now();
    inFlight.inc();
    afterResponse(request, (response) => {
      const labels = { method: request.method, route: routeLabel(route, request), status: response.status };
      requests.inc(labels);
      durations.observe(labels, (performance.now() - startedAt) / 1000);
      inFlight.dec();
    });
    return next();
  };

  class MetricsMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>, route: ManifestRoute<unknown>) {
      return run(context.request, route, next);
    }

    handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>, route: ManifestRoute<unknown>) {
      return run(request, route, next);
    }
  }

  return {
    registry,
    middleware: MetricsMiddleware,
    /** Native route handler answering the text exposition. */
    handler: () => new Response(registry.render(), { headers: { 'content-type': CONTENT_TYPE_PROMETHEUS, 'cache-control': 'no-store' } }),
  };
}
