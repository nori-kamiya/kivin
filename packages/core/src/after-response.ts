// Per-request callbacks that see the final response of a route: after exception filters, error
// mapping and CORS, i.e. exactly what the client receives. Middleware cannot see that response when
// the handler throws (filters run outside the middleware chain), so metrics / tracing middleware
// register here to record the real status.
import { originalRequest } from './client-address';

export type AfterResponseCallback = (response: Response) => Response | void;

const callbacks = new WeakMap<Request, AfterResponseCallback[]>();
// Route call sites check this flag (a live binding) before anything else, so apps that never
// register a callback pay one boolean read per request.
export let afterResponseInUse = false;

/**
 * Finalises routes from now on, so `afterResponse` works from the first request of the process.
 * Call it once at startup, before the first request, in anything that registers callbacks.
 *
 * Reading the flag when a route starts keeps apps that never use `afterResponse` at one boolean read.
 * Without this call, every request that passed that read before the first `afterResponse` call loses
 * its callbacks, and any `await` ahead of the registering middleware (a guard, sync or async, is
 * enough) lets requests pass it.
 */
export function enableAfterResponse() {
  afterResponseInUse = true;
}

/**
 * Calls `callback` with the final response of the route handling `request` (one call per request).
 * Returning a `Response` replaces it, e.g. a copy with extra headers. Callback errors are logged and
 * ignored. Only requests that reach a route are finalised (not 404 / 405 answers). Middleware that
 * runs behind a guard or another `await` needs `enableAfterResponse()` at startup to cover the first
 * requests of the process.
 */
export function afterResponse(request: Request, callback: AfterResponseCallback) {
  afterResponseInUse = true;
  const key = originalRequest(request);
  const list = callbacks.get(key);
  if (list) {
    list.push(callback);
  } else {
    callbacks.set(key, [callback]);
  }
}

function finish(request: Request, response: Response): Response {
  // Callbacks are keyed by the received request: a request rewritten by an `onRequest` hook (or
  // re-wrapped by the body limit) finds the callbacks its middleware registered.
  const key = originalRequest(request);
  const list = callbacks.get(key);
  if (!list) {
    return response;
  }
  callbacks.delete(key);
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

/**
 * @internal Runs the request's callbacks on a route's final response. Call sites check
 * `afterResponseInUse` first.
 */
export function finishAfterResponse(request: Request, result: Promise<Response>): Promise<Response> {
  // An already-settled route result is finished now: a resolved promise, not a pending one (#65).
  if (Bun.peek.status(result) === 'fulfilled') {
    return Promise.resolve(finish(request, Bun.peek(result) as Response));
  }
  return result.then((response) => finish(request, response), (error: unknown) => {
    finish(request, new Response(null, { status: 500 }));
    throw error;
  });
}
