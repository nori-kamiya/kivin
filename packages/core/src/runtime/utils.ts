// Small promise helpers shared by the runtime.
import { HttpError } from '../http';

/**
 * Rejection handler for `request.json()`: malformed JSON is the client's fault (400), not a 500.
 * Used as the second `then` argument / in a `catch`, so the success path pays nothing.
 */
export function rethrowJsonBodyError(error: unknown): never {
  throw error instanceof SyntaxError ? new HttpError(400, 'Invalid JSON body') : error;
}

export function mapLoadedValue<TInput, TOutput>(value: PromiseLike<TInput> | TInput, map: (input: TInput) => TOutput): PromiseLike<TOutput> | TOutput {
  return isPromiseLike<TInput>(value) ? value.then(map) : map(value);
}

/**
 * `promise.then(onFulfilled)`, but when `promise` has already fulfilled the callback runs now and the
 * result comes back as an already-resolved promise. Bun answers a resolved promise from a route as
 * cheaply as a synchronous `Response`, while one that is still pending when the handler returns —
 * which `then` always creates — costs ~10% more server CPU per request (#65).
 */
export function thenNow<T, TResult>(promise: Promise<T>, onFulfilled: (value: T) => TResult | PromiseLike<TResult>): Promise<TResult> {
  if (Bun.peek.status(promise) !== 'fulfilled') {
    return promise.then(onFulfilled);
  }
  try {
    return Promise.resolve(onFulfilled(Bun.peek(promise) as T));
  } catch (error) {
    return Promise.reject(error);
  }
}

/** The value of an already-fulfilled native promise, else `NOT_SETTLED`. */
export const NOT_SETTLED: unique symbol = Symbol('kivin.notSettled');
export function settledValue<T>(value: PromiseLike<T>): T | typeof NOT_SETTLED {
  return value instanceof Promise && Bun.peek.status(value) === 'fulfilled' ? Bun.peek(value) as T : NOT_SETTLED;
}

export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | null | undefined)?.then === 'function';
}

export function isAsyncFunction(value: unknown) {
  return typeof value === 'function' && value.constructor.name === 'AsyncFunction';
}
