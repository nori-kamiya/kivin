import type { Constructor } from './types';

/**
 * Typed DI token. At runtime it is a plain symbol, so it stays a valid `Token`;
 * the phantom type lets `@Injectable({ deps })` check constructor parameters.
 */
export type InjectionToken<T> = symbol & { readonly __kivinTokenType?: T };

export function createToken<T>(key: string): InjectionToken<T> {
  return Symbol.for(key) as InjectionToken<T>;
}

/** The value a DI token resolves to. Untyped string/symbol tokens resolve to `any` so they never block checks. */
export type TokenValue<TToken> = TToken extends Constructor<infer TInstance>
  ? TInstance
  : TToken extends { readonly __kivinTokenType?: infer TValue }
  ? unknown extends TValue
    ? any
    : TValue
  : any;

export type TokenValues<TDeps extends readonly unknown[]> = { -readonly [K in keyof TDeps]: TokenValue<TDeps[K]> };

interface StandardSchemaTypes<TInput, TOutput> {
  readonly input: TInput;
  readonly output: TOutput;
}

interface StandardSchemaLike<TInput = unknown, TOutput = unknown> {
  readonly '~standard': {
    readonly types?: StandardSchemaTypes<TInput, TOutput> | undefined;
  };
}

/** Output type of a Standard Schema compatible schema (Valibot, Zod, ArkType, ...). Unknown schemas yield `any`. */
export type InferSchemaOutput<TSchema> = TSchema extends StandardSchemaLike<unknown, infer TOutput> ? TOutput : any;

/** Input type of a Standard Schema compatible schema. Unknown schemas yield `any`. */
export type InferSchemaInput<TSchema> = TSchema extends StandardSchemaLike<infer TInput, unknown> ? TInput : any;

/**
 * Compile-time route contract checks emitted by `kivin generate` into `contracts.ts`.
 * Each helper resolves to `true` or to a descriptive error object that fails `ExpectContract`.
 */
export namespace RouteContract {
  export type Assignable<TFrom, TTo, TLabel extends string> = [TFrom] extends [TTo]
    ? true
    : { readonly contractError: TLabel; readonly expected: TTo; readonly received: TFrom };

  export type Body<TSchema, TParameter, TLabel extends string> = Assignable<InferSchemaOutput<TSchema>, TParameter, TLabel>;

  export type Whole<TSchema, TParameter, TLabel extends string> = Assignable<InferSchemaOutput<TSchema>, TParameter, TLabel>;

  export type Field<TSchema, TKey extends string, TParameter, TLabel extends string> = InferSchemaOutput<TSchema> extends infer TOutput
    ? unknown extends TOutput
      ? true
      : TKey extends keyof TOutput
      ? Assignable<TOutput[TKey], TParameter, TLabel>
      : { readonly contractError: TLabel; readonly missingField: TKey; readonly schemaFields: keyof TOutput }
    : never;

  /** Handler return value (ignoring a raw `Response`) must satisfy the declared success response schema. */
  export type Returns<TSchema, TReturn, TLabel extends string> = Assignable<Exclude<Awaited<TReturn>, Response | void | undefined>, InferSchemaInput<TSchema>, TLabel>;

  export type Expect<T extends true> = T;
}
