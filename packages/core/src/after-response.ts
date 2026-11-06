// Per-request callbacks that see the final response of a route: after exception filters, error
// mapping and CORS, i.e. exactly what the client receives. Middleware cannot see that response when
// the handler throws (filters run outside the middleware chain), so metrics / tracing middleware
// register here to record the real status.
import { originalRequest } from './client-address';
import { isPromiseLike } from './runtime/utils';

export type AfterResponseCallback = (response: Response) => Response | void;

const callbacks = new WeakMap<Request, AfterResponseCallback[]>();
// Routes check this flag before touching the map, so apps that never register a callback pay nothing.
let inUse = false;

/**
 * Calls `callback` with the final response of the route handling `request` (one call per request).
 * Returning a `Response` replaces it, e.g. a copy with extra headers. Callback errors are logged and
 * ignored. Only requests that reach a route are finalised (not 404 / 405 answers).
 */
export function afterResponse(request: Request, callback: AfterResponseCallback) {
  inUse = true;
  const key = originalRequest(request);
  const list = callbacks.get(key);
  if (list) {
    list.push(callback);
  } else {
    callbacks.set(key, [callback]);
  }
}

function finish(request: Request, response: Response): Response {
  const list = callbacks.get(request);
  if (!list) {
    return response;
  }
  callbacks.delete(request);
  let current = response;
  for (const callback of list) {
    try {
      const replaced = callback(current);
      if (replaced instanceof Response) {
        current = replaced;
      }
    } catch (error) {
      console.error('[kivin] afterResponse callback failed', error);
    }
  }
  return current;
}

/** @internal Wraps a route executor so registered callbacks run on its final response. */
export function withAfterResponse<TParams>(execute: (request: Request, params: TParams) => Promise<Response>) {
  return (request: Request, params: TParams): Promise<Response> => {
    const result = execute(request, params);
    if (!inUse) {
      return result;
    }
    return isPromiseLike<Response>(result)
      ? result.then((response) => finish(request, response), (error: unknown) => {
          finish(request, new Response(null, { status: 500 }));
          throw error;
        })
      : Promise.resolve(finish(request, result));
  };
}
