import { buildManifest, createApp, defineApplication, defineModule, setControllerMetadata, setRouteMetadata } from '@kivinjs/core';
import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildManifestSourceFromAst } from '../src/ast';

const fixture = join(import.meta.dir, 'fixtures/base-path-app/src/app.ts');

describe('defineApplication({ basePath })', () => {
  test('kivin generate prefixes every route in the manifest and the client', async () => {
    const result = await buildManifestSourceFromAst({
      entry: fixture,
      outFile: join(import.meta.dir, '.generated/base-path/manifest.ts'),
      clientOutFile: join(import.meta.dir, '.generated/base-path/client.ts'),
    });
    expect([...result.source.matchAll(/fullPath: "([^"]+)"/g)].map((match) => match[1])).toEqual(['/api/v1/users/', '/api/v1/users/:id', '/api/v1/']);
    expect(result.clientSource).toContain('/api/v1/users');
    expect(result.clientSource).not.toMatch(/['"`]\/users/);
  });

  test('basePath must be a string literal starting with "/"', async () => {
    const dir = join(import.meta.dir, '.generated/base-path-invalid');
    await mkdir(dir, { recursive: true });
    const entry = join(dir, 'app.ts');
    await writeFile(entry, "import { defineApplication } from '@kivinjs/core';\nexport default defineApplication({ basePath: 'api', modules: [] });\n");
    await expect(buildManifestSourceFromAst({ entry, outFile: join(dir, 'manifest.ts') })).rejects.toThrow(/must start with "\/"/);
    await writeFile(entry, "import { defineApplication } from '@kivinjs/core';\nconst prefix = '/api';\nexport default defineApplication({ basePath: prefix, modules: [] });\n");
    await expect(buildManifestSourceFromAst({ entry, outFile: join(dir, 'manifest.ts') })).rejects.toThrow(/basePath/);
  });

  test('the runtime manifest (no CLI) applies it too, and defineApplication validates it', async () => {
    class Health {
      ok() {
        return { ok: true };
      }
    }
    setControllerMetadata(Health, { basePath: '/health', tags: [], guards: [], middleware: [], filters: [] });
    setRouteMetadata(Health.prototype, 'ok', { method: 'GET', path: '/' });
    const definition = defineApplication({
      basePath: '/internal/',
      modules: [defineModule({ providers: [], controllers: [Health], imports: [] })],
      schemaAdapter: { name: 'none', parse: (_schema, input) => ({ success: true, output: input as never }), toOpenApiSchema: () => ({}) },
    });
    const manifest = buildManifest(definition);
    expect(manifest.routes.map((route) => route.fullPath)).toEqual(['/internal/health/']);
    const app = createApp(definition, manifest);
    expect((await app.fetch(new Request('http://x/internal/health'))).status).toBe(200);
    expect((await app.fetch(new Request('http://x/health'))).status).toBe(404);
    expect(() => defineApplication({ basePath: 'api', modules: [], schemaAdapter: undefined as never })).toThrow(TypeError);
  });
});
