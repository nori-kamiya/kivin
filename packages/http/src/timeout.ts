// Request timeout middleware (equivalent of Hono's `timeout`).
import type { NestLikeMiddleware, RequestContext } from '@kivinjs/core';

export interface TimeoutOptions {
  /** Status for a request that did not finish in time. Default 504 (as Hono). */
  status?: number;
  message?: string;
}

/**
 * Answers `504` when the rest of the pipeline takes longer than `ms`. The handler is not cancelled
 * (JavaScript cannot interrupt it); long work can watch `request.signal` for client disconnects.
 */
export function createTimeoutMiddleware(ms: number, options: TimeoutOptions = {}) {
  if (!(ms > 0)) {
    throw new TypeError('createTimeoutMiddleware: ms must be a positive number');
  }
  const status = options.status ?? 504;
  const message = options.message ?? 'Request timed out';

  const race = (next: () => Response | PromiseLike<Response>): Promise<Response> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Response>((resolve) => {
      timer = setTimeout(() => resolve(Response.json({ message }, { status })), ms);
    });
    return Promise.race([Promise.resolve(next()), timeout]).finally(() => clearTimeout(timer));
  };

  return class TimeoutMiddleware implements NestLikeMiddleware {
    handle(_context: RequestContext, next: () => Response | PromiseLike<Response>) {
      return race(next);
    }

    handleRaw(_request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      return race(next);
    }
  };
}
