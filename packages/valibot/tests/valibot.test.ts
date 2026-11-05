import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createValibotAdapter } from '../src/index';

describe('createValibotAdapter', () => {
  const adapter = createValibotAdapter();
  const UserSchema = v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    age: v.optional(v.pipe(v.string(), v.transform(Number))),
  });

  test('returns the transformed output on success', () => {
    expect(adapter.parse(UserSchema, { name: 'Ada', age: '36' })).toEqual({ success: true, output: { name: 'Ada', age: 36 } });
  });

  test('returns Valibot issues on failure', () => {
    const result = adapter.parse(UserSchema, { name: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Array.isArray(result.issues)).toBe(true);
      expect((result.issues as Array<{ path?: Array<{ key: unknown }> }>)[0]?.path?.[0]?.key).toBe('name');
    }
  });

  test('converts schemas to JSON Schema for OpenAPI', () => {
    const jsonSchema = adapter.toOpenApiSchema(v.object({ id: v.string(), tags: v.optional(v.array(v.string())) }));
    expect(jsonSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['id'],
    });
  });

  test('ignores parts that have no JSON Schema equivalent instead of throwing', () => {
    expect(() => adapter.toOpenApiSchema(v.pipe(v.string(), v.transform(Number)))).not.toThrow();
  });
});
