// Small promise helpers shared by the runtime.
export function mapLoadedValue<TInput, TOutput>(value: PromiseLike<TInput> | TInput, map: (input: TInput) => TOutput): PromiseLike<TOutput> | TOutput {
  return isPromiseLike<TInput>(value) ? value.then(map) : map(value);
}

export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | null | undefined)?.then === 'function';
}

export function isAsyncFunction(value: unknown) {
  return typeof value === 'function' && value.constructor.name === 'AsyncFunction';
}
