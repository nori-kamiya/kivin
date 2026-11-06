import { describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateOpenApi } from '../src/index';

const dir = join(import.meta.dir, '.generated/openapi-output');

const controllerSource = `import { ApiResponse, Controller, Get } from '@kivinjs/decorators';

@Controller('/docs')
export class DocsController {
  @Get('/')
  @ApiResponse(200, { kind: 'ok' }, 'ok')
  read() {
    return { ok: true };
  }
}
`;

const appSource = `import { defineApplication, defineModule } from '@kivinjs/core';
import { DocsController } from './controller';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [DocsController], imports: [] })],
  schemaAdapter: {
    name: 'test',
    parse: (_schema: unknown, input: unknown) => ({ success: true as const, value: input as never }),
    toOpenApiSchema: () => ({ type: 'object' }),
  },
});
`;

async function seed() {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'app.ts'), appSource);
  await writeFile(join(dir, 'controller.ts'), controllerSource);
}

describe('generateOpenApi output', () => {
  test('given an output directory with its own manifest.ts, when generating, then that file is left untouched', async () => {
    await seed();
    await mkdir(join(dir, 'api-docs'), { recursive: true });
    await writeFile(join(dir, 'api-docs/manifest.ts'), 'export const MY_OWN_MANIFEST = "precious";\n');

    await generateOpenApi({ entry: join(dir, 'app.ts'), output: join(dir, 'api-docs/openapi.json') });

    expect(await readFile(join(dir, 'api-docs/manifest.ts'), 'utf8')).toBe('export const MY_OWN_MANIFEST = "precious";\n');
    expect(JSON.parse(await readFile(join(dir, 'api-docs/openapi.json'), 'utf8')).paths['/docs']).toBeDefined();
  });

  test('given a fresh output directory, when generating, then only the named file is written', async () => {
    await seed();

    await generateOpenApi({ entry: join(dir, 'app.ts'), output: join(dir, 'fresh/spec.json') });

    expect(await readdir(join(dir, 'fresh'))).toEqual(['spec.json']);
  });

  test('given an output directory reached through a symlinked path, when generating, then it still resolves the entry and writes the file', async () => {
    await seed();
    const out = join(tmpdir(), `kivin-openapi-${crypto.randomUUID()}`);
    try {
      await generateOpenApi({ entry: join(dir, 'app.ts'), output: join(out, 'spec.json') });
      expect(await readdir(out)).toEqual(['spec.json']);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
