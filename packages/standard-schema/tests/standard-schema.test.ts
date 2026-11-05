import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createStandardSchemaAdapter, type StandardSchema } from '../src/index';

function numberSchema(options: { async?: boolean; jsonSchema?: boolean } = {}): StandardSchema<unknown, number> {
  const validate = (value: unknown) =>
    typeof value === 'number' ? { value } : { issues: [{ message: 'Expected a number' }] };

  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: options.async ? async (value: unknown) => validate(value) : validate,
      ...(options.jsonSchema
        ? {
            jsonSchema: {
              input: ({ target }) => ({ $schema: `dialect:${target}`, type: 'number' }),
              output: () => ({ type: 'number' }),
            },
          }
        : {}),
    },
  };
}

describe('createStandardSchemaAdapter', () => {
  const adapter = createStandardSchemaAdapter();

  test('returns the validated value on success', () => {
    expect(adapter.parse(numberSchema(), 42)).toEqual({ success: true, output: 42 });
  });

  test('returns the issues on failure', () => {
    expect(adapter.parse(numberSchema(), 'nope')).toEqual({ success: false, issues: [{ message: 'Expected a number' }] });
  });

  test('rejects schemas that validate asynchronously', () => {
    expect(() => adapter.parse(numberSchema({ async: true }), 1)).toThrow('Async Standard Schema validation is not supported');
  });

  test('converts through Standard JSON Schema and drops the $schema dialect', () => {
    expect(adapter.toOpenApiSchema(numberSchema({ jsonSchema: true }))).toEqual({ type: 'number' });
  });

  test('falls back to an empty schema without a JSON Schema converter', () => {
    expect(adapter.toOpenApiSchema(numberSchema())).toEqual({});
  });

  test('accepts a custom JSON Schema converter', () => {
    const custom = createStandardSchemaAdapter({ toJsonSchema: () => ({ type: 'custom' }) });
    expect(custom.toOpenApiSchema(numberSchema({ jsonSchema: true }))).toEqual({ type: 'custom' });
  });

  test('validates real Valibot schemas through their Standard Schema interface', () => {
    const schema = v.object({ name: v.pipe(v.string(), v.minLength(1)) });
    expect(adapter.parse(schema, { name: 'Ada' })).toEqual({ success: true, output: { name: 'Ada' } });
    const failure = adapter.parse(schema, { name: '' });
    expect(failure.success).toBe(false);
  });
});
