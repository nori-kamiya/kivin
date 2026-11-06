// Fixed-window rate limiting middleware with a pluggable counter store (memory by default).
import { getClientAddress, type NestLikeMiddleware, type RequestContext } from '@kivinjs/core';

export interface RateLimitOptions {
  /** Requests allowed per key and window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * Identifies the client. Default: the peer address (`getClientAddress`); requests without one
   * (in-process `app.fetch`) share the key `unknown`. Return `undefined` to exempt a request.
   */
  key?: (request: Request) => string | undefined;
  /** Add `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` to responses. Default true. */
  headers?: boolean;
  /** Current time in milliseconds, for tests. */
  now?: () => number;
  /**
   * Where the counters live. Default: a `MemoryRateLimitStore` (per process). With several instances
   * behind a load balancer, use a shared store (e.g. Redis `INCR` + `PEXPIRE`) so the limit is global.
   */
  store?: RateLimitStore;
}

/** The count of the current window for a key, and when the window ends (ms since the epoch). */
export interface RateLimitHit {
  count: number;
  resetAt: number;
}

/** Counter storage for `createRateLimitMiddleware`. */
export interface RateLimitStore {
  /** Counts one request for `key` in its current window (starting one at `now` when none is open). */
  increment(key: string, windowMs: number, now: number): RateLimitHit | Promise<RateLimitHit>;
}

/** In-memory fixed windows; expired windows are swept once per window length. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, RateLimitHit>();
  private nextSweep = 0;

  increment(key: string, windowMs: number, now: number): RateLimitHit {
    if (now >= this.nextSweep) {
      this.nextSweep = now + windowMs;
      for (const [bucketKey, bucket] of this.buckets) {
        if (bucket.resetAt <= now) {
          this.buckets.delete(bucketKey);
        }
      }
    }
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return { count: bucket.count, resetAt: bucket.resetAt };
  }
}

/**
 * Fixed-window rate limiting. Over the limit answers `429` with `Retry-After`. Counters are kept per
 * process unless `store` is shared.
 */
export function createRateLimitMiddleware(options: RateLimitOptions) {
  if (!(options.limit > 0) || !(options.windowMs > 0)) {
    throw new TypeError('createRateLimitMiddleware: limit and windowMs must be positive');
  }
  const { limit, windowMs } = options;
  const key = options.key ?? ((request: Request) => getClientAddress(request) ?? 'unknown');
  const sendHeaders = options.headers ?? true;
  const now = options.now ?? Date.now;
  const store = options.store ?? new MemoryRateLimitStore();

  const limitRequest = async (request: Request, next: () => Response | PromiseLike<Response>): Promise<Response> => {
    const id = key(request);
    if (id === undefined) {
      return next();
    }
    const time = now();
    const pending = store.increment(id, windowMs, time);
    const bucket = pending instanceof Promise ? await pending : pending;
    const resetSeconds = Math.max(Math.ceil((bucket.resetAt - time) / 1000), 0);
    const remaining = Math.max(limit - bucket.count, 0);

    if (bucket.count > limit) {
      const headers: Record<string, string> = { 'retry-after': String(resetSeconds) };
      if (sendHeaders) {
        Object.assign(headers, { 'ratelimit-limit': String(limit), 'ratelimit-remaining': '0', 'ratelimit-reset': String(resetSeconds) });
      }
      return Response.json({ message: 'Too Many Requests' }, { status: 429, headers });
    }

    const response = await next();
    if (!sendHeaders) {
      return response;
    }
    const target = headersWritable(response) ? response : new Response(response.body, response);
    target.headers.set('ratelimit-limit', String(limit));
    target.headers.set('ratelimit-remaining', String(remaining));
    target.headers.set('ratelimit-reset', String(resetSeconds));
    return target;
  };

  return class RateLimitMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      return limitRequest(context.request, next);
    }

    handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      return limitRequest(request, next);
    }
  };
}

function headersWritable(response: Response) {
  try {
    response.headers.set('x-kivin-probe', '1');
    response.headers.delete('x-kivin-probe');
    return true;
  } catch {
    return false;
  }
}
