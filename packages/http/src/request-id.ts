// Request IDs for correlating logs across services (equivalent of Hono's `requestId`).
import type { NestLikeMiddleware, RequestContext, ResponseState } from '@kivin/core';

const requestIds = new WeakMap<Request, string>();

export interface RequestIdOptions {
  /** Request / response header. Default `x-request-id`. */
  header?: string;
  /** Use a well-formed incoming ID (e.g. set by a load balancer). Default true. */
  trustIncoming?: boolean;
  /** Generates a new ID. Default `crypto.randomUUID()`. */
  generate?: () => string;
}

// Incoming IDs end up in logs and response headers: only short, plain tokens are accepted.
const WELL_FORMED = /^[A-Za-z0-9._:-]{1,128}$/;

/** The ID `createRequestIdMiddleware` assigned to this request. */
export function getRequestId(request: Request): string | undefined {
  return requestIds.get(request);
}

/**
 * Assigns each request an ID (the incoming header when well-formed, otherwise a new UUID), echoes
 * it in the response header and makes it available via `getRequestId(request)` and
 * `context.get('requestId')` (which `@kivin/logger` includes in its records).
 */
export function createRequestIdMiddleware(options: RequestIdOptions = {}) {
  const header = (options.header ?? 'x-request-id').toLowerCase();
  const trustIncoming = options.trustIncoming ?? true;
  const generate = options.generate ?? (() => crypto.randomUUID());

  const assign = (request: Request) => {
    const incoming = trustIncoming ? request.headers.get(header) : null;
    const id = incoming !== null && WELL_FORMED.test(incoming) ? incoming : generate();
    requestIds.set(request, id);
    return id;
  };

  return class RequestIdMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      const id = assign(context.request);
      context.set('requestId', id);
      context.setResponseHeader(header, id);
      return next();
    }

    handleRaw(request: Request, _params: Record<string, string>, state: ResponseState, next: () => Response | PromiseLike<Response>) {
      state.setResponseHeader(header, assign(request));
      return next();
    }
  };
}
