import { describe, expect, test } from 'bun:test';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateArtifacts } from '../src/index';

const root = join(import.meta.dir, '.generated/generated-import');

const controllerSource = `import { ApiResponse, Controller, Get } from '@kivinjs/decorators';
import { createClient } from './.kivin/generated/client';

@Controller('/self')
export class SelfController {
  @Get('/')
  @ApiResponse(200, { kind: 'ok' }, 'ok')
  read() {
    return { ok: typeof createClient };
  }
}
`;

const appSource = `import { defineApplication, defineModule } from '@kivinjs/core';
import { SelfController } from './controller';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [SelfController], imports: [] })],
  schemaAdapter: {
    name: 'test',
    parse: (_schema: unknown, input: unknown) => ({ success: true as const, value: input as never }),
    toOpenApiSchema: () => ({ type: 'object' }),
  },
});
`;

// A distinct directory per call: the module cache would otherwise replay the first run's failed import.
async function generateWith(name: string, controller: string) {
  const dir = join(root, name);
  const outDir = join(dir, '.kivin/generated');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'app.ts'), appSource);
  await writeFile(join(dir, 'controller.ts'), controller);
  const error = await generateArtifacts({ entry: join(dir, 'app.ts'), outDir }).then(() => undefined, (caught: unknown) => caught as Error);
  return { error, left: await readdir(outDir).catch(() => [] as string[]) };
}

describe('generateArtifacts on a clean checkout', () => {
  test('given the entry imports a generated file at runtime, when generating, then the error says the entry must not import generated files and points at main.ts', async () => {
    const { error, left } = await generateWith('runtime-import', controllerSource);

    expect(error?.message).toContain('must not import generated files at runtime');
    expect(error?.message).toContain('main.ts');
    expect(error?.message).toContain('.kivin/generated/client');
    expect(left).toEqual([]);
  });

  test('given an unrelated missing module, when generating, then the original error is not rewritten', async () => {
    const { error } = await generateWith('unrelated', controllerSource.replace('./.kivin/generated/client', './nowhere/helper'));

    expect(error?.message).toContain('nowhere/helper');
    expect(error?.message).not.toContain('must not import generated files');
  });
});
