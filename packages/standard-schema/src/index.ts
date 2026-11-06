import type { ParseResult, SchemaAdapter } from '@kivinjs/core';

// Minimal local copies of the Standard Schema / Standard JSON Schema v1 interfaces
// (https://standardschema.dev) so this package needs no runtime dependency.

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export type StandardSchemaResult<TOutput> =
  | { readonly value: TOutput; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

export type JsonSchemaTarget = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | ({} & string);

export interface StandardJsonSchemaConverter {
  input(options: { target: JsonSchemaTarget; libraryOptions?: Record<string, unknown> }): Record<string, unknown>;
  output(options: { target: JsonSchemaTarget; libraryOptions?: Record<string, unknown> }): Record<string, unknown>;
}

export interface StandardSchema<TInput = unknown, TOutput = TInput> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<TOutput> | Promise<StandardSchemaResult<TOutput>>;
    readonly types?: { readonly input: TInput; readonly output: TOutput } | undefined;
    /** Present on schemas that also implement Standard JSON Schema (Zod 4.2+, ArkType, Valibot via `toStandardJsonSchema`). */
    readonly jsonSchema?: StandardJsonSchemaConverter | undefined;
  };
}

export interface StandardSchemaAdapterOptions {
  /**
   * Converts a schema to JSON Schema for OpenAPI. Defaults to the schema's own Standard JSON Schema
   * converter (`~standard.jsonSchema.input`), falling back to `{}` when the schema has none.
   */
  toJsonSchema?: (schema: StandardSchema) => Record<string, unknown>;
  /** JSON Schema dialect requested from Standard JSON Schema converters. OpenAPI 3.1 uses draft 2020-12. */
  target?: JsonSchemaTarget;
}

/**
 * Schema adapter for any Standard Schema validator, so routes can use Zod, ArkType, Valibot and others.
 *
 * kivin validates synchronously on the request path, so schemas whose `validate` returns a Promise
 * (for example async refinements) are rejected with an error rather than silently awaited.
 */
export function createStandardSchemaAdapter(options: StandardSchemaAdapterOptions = {}): SchemaAdapter<StandardSchema> {
  const target = options.target ?? 'draft-2020-12';
  const toJsonSchema = options.toJsonSchema ?? ((schema: StandardSchema) => defaultToJsonSchema(schema, target));

  return {
    name: 'standard-schema',
    parse<TOutput>(schema: StandardSchema, input: unknown): ParseResult<TOutput> {
      const result = schema['~standard'].validate(input);
      if (isPromiseLike(result)) {
        throw new TypeError(`Async Standard Schema validation is not supported (vendor: ${schema['~standard'].vendor}); use a synchronous schema`);
      }

      if (result.issues) {
        return { success: false, issues: result.issues };
      }

      return { success: true, output: result.value as TOutput };
    },
    toOpenApiSchema(schema: StandardSchema) {
      return toJsonSchema(schema);
    },
  };
}

function defaultToJsonSchema(schema: StandardSchema, target: JsonSchemaTarget): Record<string, unknown> {
  const converter = schema['~standard'].jsonSchema;
  if (!converter) {
    return {};
  }

  // Request bodies and query/path params are documented as what clients send, i.e. the schema input.
  const { $schema: _dialect, ...jsonSchema } = converter.input({ target });
  return jsonSchema;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}
