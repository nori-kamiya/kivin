// Compile-time tests for the helpers used by the generated `contracts.ts`.
import type { InferSchemaInput, InferSchemaOutput, RouteContract } from '@kivin/core';
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
