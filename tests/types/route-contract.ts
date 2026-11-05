// Compile-time tests for the helpers used by the generated `contracts.ts`.
import type { InferSchemaInput, InferSchemaOutput, RouteContract, RouteInput } from '@kivin/core';
import * as v from 'valibot';

const BodySchema = v.object({ name: v.string(), age: v.optional(v.number()) });
const ParamsSchema = v.object({ id: v.pipe(v.string(), v.transform(Number)) });

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

export type InferOutput = RouteContract.Expect<Equal<InferSchemaOutput<typeof ParamsSchema>, { id: number }>>;
export type InferInput = RouteContract.Expect<Equal<InferSchemaInput<typeof ParamsSchema>, { id: string }>>;
export type NonStandardSchemaIsAny = RouteContract.Expect<Equal<InferSchemaOutput<{ parse(): void }>, any>>;

export type BodyOk = RouteContract.Expect<RouteContract.Body<typeof BodySchema, { name: string; age?: number | undefined }, 'ok'>>;
export type BodyWider = RouteContract.Expect<RouteContract.Body<typeof BodySchema, { name: string }, 'a wider parameter type is fine'>>;
// @ts-expect-error the parameter requires a field the schema does not produce
export type BodyMissingField = RouteContract.Expect<RouteContract.Body<typeof BodySchema, { name: string; email: string }, 'missing'>>;

export type FieldOk = RouteContract.Expect<RouteContract.Field<typeof ParamsSchema, 'id', number, 'transformed field'>>;
// @ts-expect-error the transformed field is a number, not a string
export type FieldWrongType = RouteContract.Expect<RouteContract.Field<typeof ParamsSchema, 'id', string, 'wrong type'>>;
// @ts-expect-error the schema has no `slug` field
export type FieldUnknown = RouteContract.Expect<RouteContract.Field<typeof ParamsSchema, 'slug', string, 'unknown field'>>;

export type ReturnsOk = RouteContract.Expect<RouteContract.Returns<typeof BodySchema, Promise<{ name: string }>, 'async return'>>;
export type ReturnsResponseIsSkipped = RouteContract.Expect<RouteContract.Returns<typeof BodySchema, Response, 'raw response'>>;
// @ts-expect-error the returned value does not satisfy the response schema
export type ReturnsWrong = RouteContract.Expect<RouteContract.Returns<typeof BodySchema, { title: string }, 'wrong return'>>;

// RouteInput / RouteContract.Input: the handler's declared input vs the route's schemas.
type FindHandler = (input: Pick<RouteInput<{ params: typeof ParamsSchema }>, 'params' | 'context'>) => unknown;
export type InputOk = RouteContract.Expect<RouteContract.Input<{ params: typeof ParamsSchema }, Parameters<FindHandler>[0], 'ok'>>;
export type InputParamsTyped = RouteContract.Expect<Equal<RouteInput<{ params: typeof ParamsSchema }>['params'], { id: number }>>;
export type InputDefaults = RouteContract.Expect<Equal<RouteInput['params'], Record<string, string>>>;
// @ts-expect-error the handler expects a params schema the route does not declare
export const inputMissingSchema: RouteContract.Input<{}, Parameters<FindHandler>[0], 'missing'> = true;
type CreateHandler = (input: { body: { name: string; age?: number | undefined } }) => unknown;
export type InputBodyOk = RouteContract.Expect<RouteContract.Input<{ body: typeof BodySchema }, Parameters<CreateHandler>[0], 'ok'>>;
type StrictCreateHandler = (input: { body: { name: string; email: string } }) => unknown;
// @ts-expect-error the body schema does not produce `email`
export type InputBodyMismatch = RouteContract.Expect<RouteContract.Input<{ body: typeof BodySchema }, Parameters<StrictCreateHandler>[0], 'mismatch'>>;
export type NoInputIsFine = RouteContract.Expect<RouteContract.Input<{}, undefined, 'none'>>;

// headers: typed by @UseHeaderSchema, otherwise a string record.
const HeadersSchema = v.object({ 'x-api-version': v.picklist(['1', '2']) });
export type HeadersTyped = RouteContract.Expect<Equal<RouteInput<{ headers: typeof HeadersSchema }>['headers'], { 'x-api-version': '1' | '2' }>>;
export type HeadersDefault = RouteContract.Expect<Equal<RouteInput['headers'], Record<string, string | undefined>>>;
type VersionedHandler = (input: { headers: { 'x-api-version': '1' | '2' } }) => unknown;
export type InputHeadersOk = RouteContract.Expect<RouteContract.Input<{ headers: typeof HeadersSchema }, Parameters<VersionedHandler>[0], 'ok'>>;
// @ts-expect-error the handler expects typed headers the route does not validate
export const inputHeadersMissing: RouteContract.Input<{}, Parameters<VersionedHandler>[0], 'missing'> = true;
