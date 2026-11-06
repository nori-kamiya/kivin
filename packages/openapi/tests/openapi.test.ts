import type { AppManifest, SchemaAdapter } from '@kivinjs/core';
import { describe, expect, test } from 'bun:test';
import { buildOpenApiDocument, createDocsHtml, toOpenApiPath } from '../src/index';

// A tiny adapter whose "schemas" already are JSON Schema, so the test only exercises the document builder.
const jsonSchemaAdapter: SchemaAdapter<Record<string, unknown>> = {
  name: 'json-schema',
  parse: (_schema, input) => ({ success: true, output: input as never }),
  toOpenApiSchema: (schema) => schema,
};

class ItemsController {}

const ItemSchema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

const manifest: AppManifest<Record<string, unknown>> = {
  routes: [
    {
      method: 'GET',
      fullPath: '/items/:id',
      controller: ItemsController,
      methodName: 'find',
      parameters: [{ index: 0, source: 'path', name: 'id' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        summary: 'Find item',
        operationId: 'items.find',
        tags: ['Items'],
        paramSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querySchema: { type: 'object', properties: { expand: { type: 'boolean' }, fields: { type: 'string' } }, required: ['fields'] },
        security: [],
        responses: [
          { status: 200, description: 'Item', schema: ItemSchema },
          { status: 404, description: '' },
        ],
      },
    },
    {
      method: 'POST',
      fullPath: '/items',
      controller: ItemsController,
      methodName: 'create',
      parameters: [{ index: 0, source: 'body' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: [],
        bodySchema: ItemSchema,
        security: [{ scheme: 'apiKey', scopes: [] }],
        responses: [{ status: 201, description: 'Created', schema: ItemSchema }],
      },
    },
  ],
};

describe('buildOpenApiDocument', () => {
  const document = buildOpenApiDocument({
    manifest,
    schemaAdapter: jsonSchemaAdapter,
    info: { title: 'Items', version: '1.0.0' },
    config: {
      tags: [{ name: 'Items', description: 'Item endpoints' }],
      servers: [{ url: 'http://localhost:3000' }],
      securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } },
    },
  });
  const paths = document.paths as Record<string, Record<string, any>>;

  test('produces an OpenAPI 3.1 document with info, servers and components', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toEqual({ title: 'Items', version: '1.0.0' });
    expect(document.servers).toEqual([{ url: 'http://localhost:3000' }]);
    expect(document.components).toEqual({ securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } });
  });

  test('keeps configured tags and adds a default tag for untagged routes', () => {
    expect(document.tags).toEqual([{ name: 'Items', description: 'Item endpoints' }, { name: 'default' }]);
    expect(paths['/items']!.post.tags).toEqual(['default']);
  });

  test('expands path and query schemas into parameters', () => {
    expect(paths['/items/{id}']!.get.parameters).toEqual([
      { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
      { in: 'query', name: 'expand', required: false, schema: { type: 'boolean' } },
      { in: 'query', name: 'fields', required: true, schema: { type: 'string' } },
    ]);
  });

  test('documents request bodies, responses and per-route security', () => {
    const post = paths['/items']!.post;
    expect(post.requestBody).toEqual({ required: true, content: { 'application/json': { schema: ItemSchema } } });
    expect(post.security).toEqual([{ apiKey: [] }]);
    expect(post.responses['201'].content['application/json'].schema).toEqual(ItemSchema);
  });

  test('falls back to a generic description and omits content without a schema', () => {
    const notFound = paths['/items/{id}']!.get.responses['404'];
    expect(notFound.description).toBe('Response');
    expect(notFound.content).toBeUndefined();
  });
});

describe('createDocsHtml', () => {
  test('points Swagger UI at the given document URL safely', () => {
    const html = createDocsHtml('/api/openapi.json?x="1"');
    expect(html).toContain('url: "/api/openapi.json?x=\\"1\\""');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });
});

describe('toOpenApiPath', () => {
  test.each([
    ['/', '/'],
    ['/users/', '/users'],
    ['/users/:id', '/users/{id}'],
    ['/orgs/:orgId/users/:user_id/', '/orgs/{orgId}/users/{user_id}'],
  ])('%p -> %p', (input, expected) => {
    expect(toOpenApiPath(input)).toBe(expected);
  });
});

describe('OpenAPI validity for routes without schemas', () => {
  class Bare {}
  const routes = [
    { method: 'GET', fullPath: '/orgs/:orgId/users/:id', controller: Bare, methodName: 'a', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } },
  ] as unknown as AppManifest<Record<string, unknown>>["routes"];
  const document = buildOpenApiDocument({ manifest: { routes }, schemaAdapter: jsonSchemaAdapter, info: { title: 't', version: '1' } }) as unknown as {
    paths: Record<string, Record<string, { parameters: Array<{ in: string; name: string; required: boolean }>; responses: Record<string, unknown> }>>;
  };
  const operation = document.paths['/orgs/{orgId}/users/{id}']!.get!;

  test('every path template variable is declared as a required path parameter', () => {
    expect(operation.parameters.map(({ in: location, name, required }) => ({ location, name, required }))).toEqual([
      { location: 'path', name: 'orgId', required: true },
      { location: 'path', name: 'id', required: true },
    ]);
  });

  test('an operation without @ApiResponse documents a 200', () => {
    expect(operation.responses).toEqual({ '200': { description: 'Success' } });
  });
});
