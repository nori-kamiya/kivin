import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildManifestSourceFromAst } from '../src/ast';

const dir = join(import.meta.dir, '.generated/inline-schemas');
const bin = join(import.meta.dir, '../src/bin.ts');

const controllerSource = `import * as v from 'valibot';
import type { RouteInput } from '@kivinjs/core';
import { ApiResponse, Controller, Get, Post, UseBodySchema, UseQuerySchema } from '@kivinjs/decorators';

export const BodySchema = v.object({ name: v.string() });

@Controller('/mixed')
export class MixedController {
  @Get('/')
  @UseQuerySchema(v.object({ a: v.string() }))
  inlineQuery({ query }: { query: { a: string } }) {
    return { a: query.a };
  }

  @Post('/')
  @UseBodySchema(BodySchema)
  @ApiResponse(201, v.object({ ok: v.boolean() }), 'created')
  exportedBody({ body }: RouteInput<{ body: typeof BodySchema }>) {
    return { ok: body.name.length > 0 };
  }
}
`;

const appSource = `import { defineApplication, defineModule } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { MixedController } from './controller';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [MixedController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
`;

async function seed() {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'app.ts'), appSource);
  await writeFile(join(dir, 'controller.ts'), controllerSource);
}

describe('inline schemas', () => {
  test('given a handler with an inline schema, when building contracts, then no input check is emitted for it', async () => {
    await seed();

    const result = await buildManifestSourceFromAst({
      entry: join(dir, 'app.ts'),
      outFile: join(dir, 'out/manifest.ts'),
      contractsOutFile: join(dir, 'out/contracts.ts'),
    });

    expect(result.contractsSource).not.toContain('MixedController["inlineQuery"]');
    expect(result.contractsSource).toContain('RouteContract.Input<{ body: typeof BodySchema }, Parameters<MixedController["exportedBody"]>[0]');
  });

  test('given inline schemas, when building, then each affected route gets a warning naming it and telling to export the schema', async () => {
    await seed();

    const result = await buildManifestSourceFromAst({ entry: join(dir, 'app.ts'), outFile: join(dir, 'out/manifest.ts') });

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('MixedController.inlineQuery');
    expect(result.warnings[0]).toContain('GET /mixed');
    expect(result.warnings[0]).toContain('export the schema');
    expect(result.warnings[1]).toContain('MixedController.exportedBody');
    expect(result.warnings[1]).toContain('201 response');
  });

  test('given only exported schemas, when building, then there are no warnings', async () => {
    await seed();
    await writeFile(join(dir, 'controller.ts'), controllerSource
      .replace('@UseQuerySchema(v.object({ a: v.string() }))', '@UseQuerySchema(BodySchema)')
      .replace("{ query }: { query: { a: string } }", "{ query }: RouteInput<{ query: typeof BodySchema }>")
      .replace('query.a', 'query.name')
      .replace("@ApiResponse(201, v.object({ ok: v.boolean() }), 'created')", "@ApiResponse(201, BodySchema, 'created')")
      .replace('return { ok: body.name.length > 0 };', 'return { name: body.name };'));

    const result = await buildManifestSourceFromAst({ entry: join(dir, 'app.ts'), outFile: join(dir, 'out/manifest.ts') });

    expect(result.warnings).toEqual([]);
  });

  test('given inline schemas, when running kivin generate, then the warning goes to stderr and the exit code is 0', async () => {
    await seed();
    const proc = Bun.spawn([process.execPath, bin, 'generate', '--entry', join(dir, 'app.ts'), '--outDir', join(dir, '.kivin/generated')], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

    expect(code).toBe(0);
    expect(stderr).toContain('MixedController.inlineQuery');
    expect(stderr).toContain('export the schema');
    expect(stdout).not.toContain('export the schema');
  });
});
