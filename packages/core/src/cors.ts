// CORS: response headers for app routes plus automatic preflight handling.
import type { NestLikeMiddleware } from './runtime-types';

export interface CorsOptions {
  /**
   * Allowed origins: `'*'`, one origin, a list, or a predicate. With `credentials: true`, `'*'`
   * reflects the request origin instead (browsers reject `*` together with credentials).
   */
  origin: '*' | string | readonly string[] | ((origin: string) => boolean);
  /** Methods allowed in preflight. Defaults to the methods the matched path actually serves. */
  methods?: readonly string[];
  /** Request headers allowed in preflight. Defaults to echoing `Access-Control-Request-Headers`. */
  allowHeaders?: readonly string[];
  exposeHeaders?: readonly string[];
  credentials?: boolean;
  /** Preflight cache lifetime in seconds. */
  maxAge?: number;
}

export interface CorsHandler {
  /** Adds CORS headers to a response for an allowed origin. */
  apply(request: Request, headers: Headers): void;
  /** Preflight response for an `OPTIONS` request, or `undefined` when it is not a CORS preflight. */
  preflight(request: Request, allowedMethods: readonly string[]): Response | undefined;
}

export function createCorsHandler(options: CorsOptions): CorsHandler {
  const allowOrigin = compileOriginMatcher(options.origin);
  const reflectsOrigin = options.origin !== '*' || options.credentials === true;
  const exposeHeaders = options.exposeHeaders?.join(', ');
  const allowHeaders = options.allowHeaders?.join(', ');
  const methods = options.methods?.map((method) => method.toUpperCase()).join(', ');
  const maxAge = options.maxAge === undefined ? undefined : String(Math.floor(options.maxAge));

  const applyOrigin = (origin: string, headers: Headers) => {
    headers.set('access-control-allow-origin', reflectsOrigin ? origin : '*');
    if (reflectsOrigin) {
      headers.append('vary', 'Origin');
    }
    if (options.credentials) {
      headers.set('access-control-allow-credentials', 'true');
    }
  };

  return {
    apply(request, headers) {
      const origin = request.headers.get('origin');
      if (!origin || !allowOrigin(origin)) {
        return;
      }
      applyOrigin(origin, headers);
      if (exposeHeaders) {
        headers.set('access-control-expose-headers', exposeHeaders);
      }
    },
    preflight(request, allowedMethods) {
      const origin = request.headers.get('origin');
      const requestedMethod = request.headers.get('access-control-request-method');
      if (request.method !== 'OPTIONS' || !origin || !requestedMethod) {
        return undefined;
      }

      const headers = new Headers();
      if (!allowOrigin(origin)) {
        // Not an allowed origin: answer without CORS headers so the browser blocks the request.
        return new Response(null, { status: 204, headers });
      }
      applyOrigin(origin, headers);
      headers.set('access-control-allow-methods', methods ?? allowedMethods.join(', '));
      const requestedHeaders = request.headers.get('access-control-request-headers');
      if (allowHeaders ?? requestedHeaders) {
        headers.set('access-control-allow-headers', allowHeaders ?? requestedHeaders!);
        if (!allowHeaders) {
          headers.append('vary', 'Access-Control-Request-Headers');
        }
      }
      if (maxAge) {
        headers.set('access-control-max-age', maxAge);
      }
      return new Response(null, { status: 204, headers });
    },
  };
}

/** Global middleware class that adds CORS headers to every application route response. */
export function createCorsMiddleware(handler: CorsHandler) {
  return class CorsMiddleware implements NestLikeMiddleware {
    async handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      const response = await next();
      handler.apply(request, response.headers);
      return response;
    }

    async handle(context: import('./context').RequestContext, next: () => Response | PromiseLike<Response>) {
      const response = await next();
      handler.apply(context.request, response.headers);
      return response;
    }
  };
}

function compileOriginMatcher(origin: CorsOptions['origin']): (origin: string) => boolean {
  if (origin === '*') {
    return () => true;
  }
  if (typeof origin === 'function') {
    return origin;
  }
  const allowed = new Set(typeof origin === 'string' ? [origin] : origin);
  return (candidate) => allowed.has(candidate);
}
