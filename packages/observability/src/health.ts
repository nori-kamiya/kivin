// Liveness / readiness endpoints with dependency checks (Kubernetes-style `/livez` and `/readyz`).

export type HealthCheckFn = () => unknown | Promise<unknown>;

export interface HealthCheckOptions {
  /**
   * Readiness checks by name. A check fails when it throws / rejects, returns `false`, or takes longer
   * than `timeoutMs`; any other result passes. Checks run concurrently on every readiness request.
   */
  checks?: Record<string, HealthCheckFn>;
  /** Per-check timeout in ms. Default 3000. */
  timeoutMs?: number;
  /** Include each check's status and duration in the readiness body. Default true. */
  details?: boolean;
  /** Ready before `setReady(true)` is called. Default true. */
  ready?: boolean;
}

export interface CheckResult {
  status: 'ok' | 'error';
  durationMs: number;
  /** Error message for a failed check (only when `details` is on). */
  error?: string;
}

const NO_STORE = { 'cache-control': 'no-store' };

function runCheck(check: HealthCheckFn, timeoutMs: number): Promise<CheckResult> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(check), timeout])
    .then(
      (result): CheckResult => (result === false
        ? { status: 'error', durationMs: performance.now() - startedAt, error: 'check returned false' }
        : { status: 'ok', durationMs: performance.now() - startedAt }),
      (error: unknown): CheckResult => ({ status: 'error', durationMs: performance.now() - startedAt, error: error instanceof Error ? error.message : String(error) }),
    )
    .finally(() => clearTimeout(timer));
}

/**
 * Health endpoints for orchestrators and load balancers:
 *
 * - liveness: 200 while the process can serve requests (no checks: a failing dependency should not
 *   get the process restarted)
 * - readiness: 200 when ready and every check passes, otherwise 503 with the failing checks
 *
 * ```ts
 * const health = createHealthCheck({ checks: { db: () => db.ping() } });
 * app.listen({
 *   port,
 *   routes: health.routes(),                         // GET /livez, GET /readyz
 *   shutdownSignals: true,
 *   onShutdownStart: () => health.setReady(false),   // load balancers stop routing here...
 *   shutdownDelayMs: 5000,                           // ...before app.close() runs
 * });
 * ```
 */
export function createHealthCheck(options: HealthCheckOptions = {}) {
  const checks = Object.entries(options.checks ?? {});
  const timeoutMs = options.timeoutMs ?? 3000;
  const details = options.details ?? true;
  let ready = options.ready ?? true;

  const liveness = () => Response.json({ status: 'ok' }, { headers: NO_STORE });

  const readiness = async () => {
    if (!ready) {
      return Response.json({ status: 'error', reason: 'not ready' }, { status: 503, headers: NO_STORE });
    }
    const results = await Promise.all(checks.map(async ([name, check]) => [name, await runCheck(check, timeoutMs)] as const));
    const healthy = results.every(([, result]) => result.status === 'ok');
    const body: Record<string, unknown> = { status: healthy ? 'ok' : 'error' };
    if (details && results.length > 0) {
      body.checks = Object.fromEntries(results.map(([name, result]) => [name, { ...result, durationMs: Math.round(result.durationMs * 100) / 100 }]));
    } else if (!healthy) {
      body.failed = results.filter(([, result]) => result.status === 'error').map(([name]) => name);
    }
    return Response.json(body, { status: healthy ? 200 : 503, headers: NO_STORE });
  };

  return {
    liveness,
    readiness,
    /** Native routes for `listen({ routes })` (GET; Bun answers HEAD for GET routes). */
    routes(paths: { liveness?: string; readiness?: string } = {}) {
      return {
        [paths.liveness ?? '/livez']: { GET: liveness },
        [paths.readiness ?? '/readyz']: { GET: readiness },
      };
    },
    /** Marks the app (not) ready, e.g. `false` when shutdown starts so load balancers stop routing to it. */
    setReady(value: boolean) {
      ready = value;
    },
    get ready() {
      return ready;
    },
  };
}
