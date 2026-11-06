import { describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateArtifacts } from '../src/index';

const dir = join(import.meta.dir, '.generated/atomic-generate');
const outDir = join(dir, 'out/generated');
const artifacts = ['manifest.ts', 'contracts.ts', 'client.ts', 'openapi.json'];

const controllerSource = (path: string) => `import { ApiResponse, Controller, Get } from '@kivin/decorators';

@Controller('/atomic')
export class AtomicController {
  @Get(${JSON.stringify(path)})
  @ApiResponse(200, { kind: 'ok' }, 'ok')
  read() {
    return { ok: true };
  }
}
`;

const appSource = `import { defineApplication, defineModule } from '@kivin/core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AtomicController } from './controller';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [AtomicController], imports: [] })],
  schemaAdapter: {
    name: 'test',
    parse: (_schema: unknown, input: unknown) => ({ success: true as const, value: input as never }),
    toOpenApiSchema() {
      if (existsSync(join(import.meta.dir, 'boom'))) {
        throw new Error('openapi conversion failed');
      }
      return { type: 'object' };
    },
  },
});
`;

async function snapshot() {
  return Promise.all(artifacts.map((name) => readFile(join(outDir, name), 'utf8')));
}

describe('generateArtifacts atomicity', () => {
  test('given a previous successful run, when openapi generation fails, then every previous artifact is untouched and no staging files remain', async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'app.ts'), appSource);
    await writeFile(join(dir, 'controller.ts'), controllerSource('/first'));
    await generateArtifacts({ entry: join(dir, 'app.ts'), outDir });
    const before = await snapshot();

    await writeFile(join(dir, 'controller.ts'), controllerSource('/second'));
    await writeFile(join(dir, 'boom'), '');
    await expect(generateArtifacts({ entry: join(dir, 'app.ts'), outDir })).rejects.toThrow('openapi conversion failed');

    expect(await snapshot()).toEqual(before);
    expect(await readdir(join(dir, 'out'))).toEqual(['generated']);
  });

  test('given no previous run, when generation fails, then the output directory holds no partial artifacts', async () => {
    await rm(join(dir, 'out'), { recursive: true, force: true });
    await generateArtifacts({ entry: join(dir, 'app.ts'), outDir }).catch(() => undefined);
    const left = await readdir(outDir).catch(() => [] as string[]);
    expect(left).toEqual([]);
  });
});
