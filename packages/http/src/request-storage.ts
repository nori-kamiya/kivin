// Access to the current request from anywhere in its async call tree (equivalent of Hono's
// `contextStorage`), via AsyncLocalStorage. Opt-in: only requests passing through the middleware
// pay for it.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NestLikeMiddleware, RequestContext } from '@kivinjs/core';

interface RequestScope {
  request: Request;
  values: Map<unknown, unknown>;
}

const storage = new AsyncLocalStorage<RequestScope>();

/**
 * Makes `getCurrentRequest()` / `getRequestValue()` work in code called during the request (services,
 * loggers, repositories) without passing the request around. Put it first in `globals.middleware`.
 */
export function createRequestStorageMiddleware() {
  const run = (request: Request, next: () => Response | PromiseLike<Response>) => storage.run({ request, values: new Map() }, next);
  return class RequestStorageMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      return run(context.request, next);
    }

    handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      return run(request, next);
    }
  };
}

/** The request being handled, or `undefined` outside a request (or without the middleware). */
export function getCurrentRequest(): Request | undefined {
  return storage.getStore()?.request;
}

/** A value stored for the current request with `setRequestValue`. */
export function getRequestValue<T>(key: unknown): T | undefined {
  return storage.getStore()?.values.get(key) as T | undefined;
}

/** Stores a value for the current request; throws outside a request. */
export function setRequestValue(key: unknown, value: unknown) {
  const scope = storage.getStore();
  if (!scope) {
    throw new Error('setRequestValue: no current request (is createRequestStorageMiddleware() in the middleware list?)');
  }
  scope.values.set(key, value);
}
