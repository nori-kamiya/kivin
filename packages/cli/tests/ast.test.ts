import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildManifestSourceFromAst } from '../src/ast';
import { generateArtifacts, inspectModules, inspectRoutes, loadAppDefinition } from '../src/index';

const testsDir = import.meta.dir;
const repoRoot = resolve(testsDir, '../../..');
const exampleApp = join(repoRoot, 'examples/basic/src/app.ts');
const cliBin = join(repoRoot, 'packages/cli/src/bin.ts');
const inspectScopesApp = join(testsDir, 'fixtures/inspect-scopes-app/src/app.ts');

describe('buildManifestSourceFromAst', () => {
  test('matches the example manifest snapshot', async () => {
    const outFile = join(testsDir, '__snapshots__/example-manifest.ts');
    const result = await buildManifestSourceFromAst({
      entry: exampleApp,
      outFile,
    });
    const snapshot = await readFile(outFile, 'utf8');

    expect(result.source).toBe(snapshot);
  });

  test('resolves path aliases and avoids import collisions', async () => {
    const outFile = join(testsDir, '__snapshots__/path-alias-manifest.ts');
    const result = await buildManifestSourceFromAst({
      entry: join(testsDir, 'fixtures/path-alias-app/src/app.ts'),
      outFile,
    });
    const snapshot = await readFile(outFile, 'utf8');

    expect(result.source).toBe(snapshot);
  });

  test('supports local module constants and inline defineModule calls', async () => {
    const result = await buildManifestSourceFromAst({
      entry: join(testsDir, 'fixtures/module-like-app/src/app.ts'),
      outFile: join(testsDir, '.generated', 'module-like-manifest.ts'),
    });

    expect(result.source).toContain('fullPath: "/inline/"');
    expect(result.source).toContain('fullPath: "/inline-second/"');
  });
});

describe('generateArtifacts', () => {
  test('matches the example OpenAPI snapshot', async () => {
    const outDir = join(testsDir, '.generated/example-openapi');
    const result = await generateArtifacts({
      entry: exampleApp,
      outDir,
    });
    const generated = await readFile(result.openApiPath, 'utf8');
    const snapshot = await readFile(join(testsDir, '__snapshots__/example-openapi.json'), 'utf8');

    expect(generated.trim()).toBe(snapshot.trim());
  });

  test('generated manifest can be imported and executed', async () => {
    const outDir = join(testsDir, '.generated/importable-manifest');
    const result = await generateArtifacts({
      entry: exampleApp,
      outDir,
    });

    const moduleNamespace = await import(`${pathToFileURL(result.manifestPath).href}?t=${Date.now()}`);
    const manifest = moduleNamespace.default ?? moduleNamespace.manifest;

    expect(Array.isArray(manifest.routes)).toBe(true);
    expect(manifest.routes).toHaveLength(6);
    expect(manifest.routes[2].docs.operationId).toBe('users.create');
    expect(manifest.routes[5].docs.operationId).toBe('users.delete');
  });

  test('generated OpenAPI stays aligned with manifest request and response contracts', async () => {
    await expectOpenApiContractAlignment({
      entry: exampleApp,
      outDir: join(testsDir, '.generated/contract-diff'),
    });
  });

  test('generated OpenAPI stays aligned for edge-case fixture routes', async () => {
    const openApi = await expectOpenApiContractAlignment({
      entry: join(testsDir, 'fixtures/openapi-contract-app/src/app.ts'),
      outDir: join(testsDir, '.generated/openapi-contract-fixture'),
    });

    expect(openApi.security).toEqual([{ bearerAuth: ['contracts:read'] }]);
    expect(openApi.tags).toEqual([
      { name: 'Contracts', description: 'Contract read endpoints.' },
      { name: 'Mutations', description: 'Contract mutation endpoints.' },
    ]);
    expect(openApi.components?.securitySchemes).toEqual({
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    });
    expect(openApi.paths['/contracts/']?.get?.tags).toEqual(['Contracts']);
    expect(openApi.paths['/contracts/:id']?.post?.tags).toEqual(['Contracts', 'Mutations']);
    expect(openApi.paths['/contracts/:id']?.delete?.responses?.['204']).toEqual({
      description: 'Deleted',
    });
  });
});

describe('inspect commands', () => {
  test('inspects generated routes from the example app', async () => {
    const routes = await inspectRoutes({
      entry: exampleApp,
    });

    expect(routes.map((route) => route.method)).toEqual(['GET', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    expect(routes[2]).toMatchObject({
      fullPath: '/users/',
      controller: 'UserController',
      controllerScope: 'singleton',
      executionMode: 'context-runtime',
      methodName: 'create',
      operationId: 'users.create',
    });
    expect(routes[5]).toMatchObject({
      fullPath: '/users/:id',
      controller: 'UserController',
      controllerScope: 'singleton',
      executionMode: 'context-runtime',
      methodName: 'delete',
      operationId: 'users.delete',
    });
  });

  test('inspects request-scoped route execution metadata', async () => {
    const routes = await inspectRoutes({
      entry: inspectScopesApp,
    });

    expect(routes[0]).toMatchObject({
      fullPath: '/inspect/static',
      controller: 'SingletonController',
      controllerScope: 'singleton',
      executionMode: 'native-static',
      guardScopes: [],
      middlewareScopes: [],
      filterScopes: [],
    });

    expect(routes[1]).toMatchObject({
      fullPath: '/inspect/scoped',
      controller: 'RequestScopedController',
      controllerScope: 'request',
      executionMode: 'request-runtime',
      guards: ['RequestScopedGuard'],
      guardScopes: ['request'],
      middleware: ['RequestScopedMiddleware'],
      middlewareScopes: ['request'],
    });

    expect(routes[2]).toMatchObject({
      fullPath: '/inspect/boom',
      controller: 'RequestScopedController',
      controllerScope: 'request',
      executionMode: 'request-runtime',
      filters: ['RequestScopedFilter'],
      filterScopes: ['request'],
    });
  });

  test('cli inspect command lets the last --entry flag override script defaults', async () => {
    const processHandle = Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        cliBin,
        'inspect',
        'routes',
        '--entry',
        exampleApp,
        '--format',
        'json',
        '--entry',
        inspectScopesApp,
      ],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(processHandle.stdout).text();
    const stderr = await new Response(processHandle.stderr).text();
    const exitCode = await processHandle.exited;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    const routes = JSON.parse(stdout) as Array<{ fullPath: string }>;
    expect(routes[0]?.fullPath).toBe('/inspect/static');
  });

  test('inspects module graph from the example app', async () => {
    const modules = await inspectModules({
      entry: exampleApp,
    });

    expect(modules[0]?.providers).toContain('@kivin.logger -> factory');
    expect(modules[0]?.providers).toContain('RequestLoggerMiddleware');
    expect(modules[0]?.globalMiddleware).toEqual([
      'ConfiguredSecureHeadersMiddleware',
      'RequestIdMiddleware',
      'RequestLoggerMiddleware',
    ]);
    expect(modules[0]?.globalMiddlewareScopes).toEqual(['singleton', 'singleton', 'singleton']);
    expect(modules[1]?.controllers).toContain('UserController');
    expect(modules[1]?.controllerScopes).toEqual(['singleton']);
  });

  test('inspects module scopes from the request-scoped fixture app', async () => {
    const modules = await inspectModules({
      entry: inspectScopesApp,
    });

    expect(modules[0]).toMatchObject({
      name: 'inline-module-0',
      providers: [
        'RequestScopedGuard -> RequestScopedGuard [request]',
        'RequestScopedMiddleware -> RequestScopedMiddleware [request]',
        'RequestScopedFilter -> RequestScopedFilter [request]',
        'RequestScopedController -> RequestScopedController [request]',
        'cli.inspect.requestTrace -> factory [request]',
      ],
      controllers: ['SingletonController', 'RequestScopedController'],
      controllerScopes: ['singleton', 'request'],
      globalGuards: [],
      globalMiddleware: [],
      globalFilters: [],
    });
  });
});

function buildExpectedParameters<TSchema>(
  location: 'path' | 'query',
  schema: TSchema | undefined,
  schemaAdapter: { toOpenApiSchema: (value: TSchema) => Record<string, unknown> },
) {
  if (!schema) {
    return [];
  }

  const jsonSchema = schemaAdapter.toOpenApiSchema(schema);
  const properties = isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
  const required = Array.isArray(jsonSchema.required)
    ? new Set(jsonSchema.required.filter((item): item is string => typeof item === 'string'))
    : new Set<string>();

  return Object.entries(properties).map(([name, value]) => ({
    in: location,
    name,
    required: location === 'path' ? true : required.has(name),
    schema: isRecord(value) ? value : {},
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function expectOpenApiContractAlignment(input: { entry: string; outDir: string }) {
  const result = await generateArtifacts({
    entry: input.entry,
    outDir: input.outDir,
  });
  const appDefinition = await loadAppDefinition(input.entry);
  const moduleNamespace = await import(`${pathToFileURL(result.manifestPath).href}?t=${Date.now()}`);
  const manifest = moduleNamespace.default ?? moduleNamespace.manifest;
  const openApi = JSON.parse(await readFile(result.openApiPath, 'utf8')) as OpenApiDocument;

  for (const route of manifest.routes) {
    const operation = openApi.paths[route.fullPath]?.[route.method.toLowerCase()];
    expect(operation).toBeDefined();
    expect(operation?.operationId).toBe(route.docs.operationId);
    expect(operation?.summary).toBe(route.docs.summary);
    expect(operation?.description).toBe(route.docs.description);
    expect(operation?.tags).toEqual(route.docs.tags.length > 0 ? route.docs.tags : ['default']);

    const expectedParameters = [
      ...buildExpectedParameters('path', route.docs.paramSchema, appDefinition.schemaAdapter),
      ...buildExpectedParameters('query', route.docs.querySchema, appDefinition.schemaAdapter),
    ];
    expect(operation?.parameters ?? []).toEqual(expectedParameters);

    const expectedRequestBody = route.docs.bodySchema
      ? {
          required: true,
          content: {
            'application/json': {
              schema: appDefinition.schemaAdapter.toOpenApiSchema(route.docs.bodySchema),
            },
          },
        }
      : undefined;
    expect(operation?.requestBody).toEqual(expectedRequestBody);

    const expectedResponses = Object.fromEntries(
      route.docs.responses.map((response) => [
        String(response.status),
        {
          description: response.description || 'Response',
          ...(response.schema
            ? {
                content: {
                  'application/json': {
                    schema: appDefinition.schemaAdapter.toOpenApiSchema(response.schema),
                  },
                },
              }
            : {}),
        },
      ]),
    );
    expect(operation?.responses).toEqual(expectedResponses);

    const expectedSecurity = route.docs.security.length > 0
      ? route.docs.security.map((entry) => ({ [entry.scheme]: entry.scopes }))
      : undefined;
    expect(operation?.security).toEqual(expectedSecurity);
  }

  return openApi;
}

interface OpenApiDocument {
  security?: Array<Record<string, string[]>>;
  tags?: Array<{ name: string; description?: string }>;
  components?: {
    securitySchemes?: Record<string, unknown>;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: Array<{ in: string; name: string; required?: boolean; schema?: unknown }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
  security?: Array<Record<string, string[]>>;
}
