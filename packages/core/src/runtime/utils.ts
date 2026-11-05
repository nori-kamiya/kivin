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

export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | null | undefined)?.then === 'function';
}

export function isAsyncFunction(value: unknown) {
  return typeof value === 'function' && value.constructor.name === 'AsyncFunction';
}
