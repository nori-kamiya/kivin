import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildManifestSourceFromAst } from '../src/ast';

describe('static responses', () => {
  test('only handlers that return a constant literal, or are marked @StaticResponse(), are static', async () => {
    const result = await buildManifestSourceFromAst({
      entry: join(import.meta.dir, 'fixtures/static-app/src/app.ts'),
      outFile: join(import.meta.dir, 'fixtures/static-app/.kivin/generated/manifest.ts'),
    });
    const staticRoutes = [...result.source.matchAll(/fullPath: "([^"]+)"[\s\S]*?docs: \{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)]
      .filter((match) => match[2]!.includes('staticResponse: true'))
      .map((match) => match[1]);
    expect(staticRoutes).toEqual(['/literal', '/string', '/as-const', '/declared']);
  });
});
