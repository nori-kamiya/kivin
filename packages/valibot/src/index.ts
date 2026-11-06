import type { ParseResult, SchemaAdapter } from '@kivinjs/core';
import { toJsonSchema } from '@valibot/to-json-schema';
import { safeParse, type BaseSchema } from 'valibot';

export type ValibotSchema = BaseSchema<unknown, unknown, never>;

export function createValibotAdapter(): SchemaAdapter<ValibotSchema> {
  return {
    name: 'valibot',
    parse<TOutput>(schema: ValibotSchema, input: unknown): ParseResult<TOutput> {
      const result = safeParse(schema, input);
      if (result.success) {
        return {
          success: true,
          output: result.output as TOutput,
        };
      }

      return {
        success: false,
        issues: result.issues,
      };
    },
    toOpenApiSchema(schema: ValibotSchema) {
      return toJsonSchema(schema, {
        errorMode: 'ignore',
        // File uploads (`v.file()` / `v.blob()`, e.g. in a multipart body) are binary strings in OpenAPI.
        overrideSchema: ({ valibotSchema }) => (valibotSchema.type === 'file' || valibotSchema.type === 'blob' ? { type: 'string', format: 'binary' } : undefined),
      }) as Record<string, unknown>;
    },
  };
}
