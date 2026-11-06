// In-memory rate limiting middleware.
import { getClientAddress, type NestLikeMiddleware, type RequestContext } from '@kivin/core';

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
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiting kept in memory (per process: use a shared store at the proxy or in
 * your own middleware when running several instances). Over the limit answers `429` with
 * `Retry-After`.
 */
export function createRateLimitMiddleware(options: RateLimitOptions) {
  if (!(options.limit > 0) || !(options.windowMs > 0)) {
    throw new TypeError('createRateLimitMiddleware: limit and windowMs must be positive');
  }
  const { limit, windowMs } = options;
  const key = options.key ?? ((request: Request) => getClientAddress(request) ?? 'unknown');
  const sendHeaders = options.headers ?? true;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  let nextSweep = now() + windowMs;

  const sweep = (time: number) => {
    if (time < nextSweep) {
      return;
    }
    nextSweep = time + windowMs;
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= time) {
        buckets.delete(bucketKey);
      }
    }
  };

  const limitRequest = async (request: Request, next: () => Response | PromiseLike<Response>): Promise<Response> => {
    const id = key(request);
    if (id === undefined) {
      return next();
    }
    const time = now();
    sweep(time);
    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= time) {
      bucket = { count: 0, resetAt: time + windowMs };
      buckets.set(id, bucket);
    }
    bucket.count += 1;
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
