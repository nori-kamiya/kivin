import { lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Ranges for everything that is not a @kivinjs/* package. valibot must stay inside the peer range of
 * @kivinjs/valibot.
 */
export const TEMPLATE_RANGES = {
  valibot: '^1.5.0',
  typescript: '^7.0.2',
  '@types/bun': '^1.4.0',
} as const;

export interface InitOptions {
  /** Target directory. Relative paths resolve against `cwd`; an absolute path or `..` is honoured only because the caller passed it explicitly. */
  dir: string;
  cwd?: string;
  /** Version of the running CLI; the @kivinjs/* dependencies are pinned to ^<version>. */
  version: string;
}

export interface InitResult {
  root: string;
  name: string;
  /** Paths relative to `root`. */
  files: string[];
}

const RESERVED_NAMES = new Set(['node_modules', 'favicon.ico']);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Returns why `name` cannot be an npm package name for the scaffold, or null when it can. Scoped names are not offered. */
export function validatePackageName(name: string): string | null {
  if (name.length === 0) return 'it is empty';
  if (name.length > 214) return 'it is longer than 214 characters';
  if (!/^[a-z0-9]/.test(name)) return 'it must start with a lowercase letter or digit';
  if (!/^[a-z0-9._-]+$/.test(name)) return 'it may only contain lowercase letters, digits, ".", "_" and "-"';
  if (RESERVED_NAMES.has(name)) return 'it is reserved';
  return null;
}

function templateFiles(name: string, version: string): Record<string, string> {
  const range = `^${version}`;
  const manifest = {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'kivin dev --entry src/app.ts --outDir .kivin/generated --main src/main.ts --watch src',
      generate: 'kivin generate --entry src/app.ts --outDir .kivin/generated',
      build: `kivin generate --entry src/app.ts --outDir .kivin/generated && bun build src/main.ts --compile --outfile bin/${name}`,
      typecheck: 'tsc',
      test: 'bun test',
    },
    dependencies: {
      '@kivinjs/core': range,
      '@kivinjs/decorators': range,
      '@kivinjs/valibot': range,
      valibot: TEMPLATE_RANGES.valibot,
    },
    devDependencies: {
      '@kivinjs/cli': range,
      '@types/bun': TEMPLATE_RANGES['@types/bun'],
      typescript: TEMPLATE_RANGES.typescript,
    },
  };

  // No experimentalDecorators: Bun and tsc then both use TC39 decorators.
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ESNext'],
      types: ['bun'],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src/**/*.ts', '.kivin/generated/**/*.ts'],
  };

  return {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify(tsconfig, null, 2)}\n`,
    '.gitignore': `node_modules/
.kivin/
dist/
bin/
*.tsbuildinfo
*.log
.DS_Store
`,
    'src/greeting.schemas.ts': `import * as v from 'valibot';

export const NameParamSchema = v.object({ name: v.string() });
export const CreateGreetingSchema = v.object({ name: v.pipe(v.string(), v.minLength(1)) });
export const GreetingSchema = v.object({ message: v.string() });
`,
    'src/greeting.service.ts': `import { Injectable } from '@kivinjs/decorators';

@Injectable({ deps: [] })
export class GreetingService {
  greet(name: string) {
    return { message: \`Hello, \${name}\` };
  }
}
`,
    'src/greeting.controller.ts': `import type { RouteInput } from '@kivinjs/core';
import { ApiResponse, Controller, Get, Injectable, OperationId, Post, UseBodySchema, UseParamSchema } from '@kivinjs/decorators';
import { CreateGreetingSchema, GreetingSchema, NameParamSchema } from './greeting.schemas';
import { GreetingService } from './greeting.service';

@Controller('/greetings')
@Injectable({ deps: [GreetingService] })
export class GreetingController {
  constructor(private readonly greetings: GreetingService) {}

  @Get('/:name')
  @OperationId('greetings.greet')
  @UseParamSchema(NameParamSchema)
  @ApiResponse(200, GreetingSchema, 'A greeting')
  greet({ params }: RouteInput<{ params: typeof NameParamSchema }>) {
    return this.greetings.greet(params.name);
  }

  @Post('/')
  @OperationId('greetings.create')
  @UseBodySchema(CreateGreetingSchema)
  @ApiResponse(201, GreetingSchema, 'A created greeting')
  create({ body, context }: RouteInput<{ body: typeof CreateGreetingSchema }>) {
    return context.json(this.greetings.greet(body.name), { status: 201 });
  }
}
`,
    'src/greeting.module.ts': `import { Module } from '@kivinjs/decorators';
import { GreetingController } from './greeting.controller';
import { GreetingService } from './greeting.service';

@Module({ providers: [GreetingService], controllers: [GreetingController] })
export class GreetingModule {}
`,
    'src/app.ts': `import { defineApplication } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { GreetingModule } from './greeting.module';

export default defineApplication({
  modules: [GreetingModule],
  schemaAdapter: createValibotAdapter(),
  globals: { guards: [], middleware: [], filters: [] },
});
`,
    'src/main.ts': `import { createApp } from '@kivinjs/core';
import manifest from '../.kivin/generated/manifest';
import app from './app';

createApp(app, manifest).listen({ port: Number(process.env.PORT ?? 3000) });
console.log(\`listening on http://localhost:\${process.env.PORT ?? 3000}\`);
`,
    // createTestingApp builds its manifest from decorator metadata, so this test needs no generated files.
    'src/greeting.test.ts': `import { createTestingApp } from '@kivinjs/core';
import { describe, expect, test } from 'bun:test';
import app from './app';

const testing = createTestingApp(app);

describe('greetings', () => {
  test('given a name, when GET /greetings/:name, then it greets', async () => {
    const response = await testing.request('/greetings/Ada');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Hello, Ada' });
  });

  test('given a valid body, when POST /greetings, then it responds 201', async () => {
    const response = await testing.request('/greetings', { method: 'POST', json: { name: 'Grace' } });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ message: 'Hello, Grace' });
  });

  test('given an empty name, when POST /greetings, then validation rejects it', async () => {
    const response = await testing.request('/greetings', { method: 'POST', json: { name: '' } });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
`,
    'README.md': `# ${name}

A [kivin](https://github.com/nori-kamiya/kivin) application.

\`\`\`sh
bun install
bun run dev        # generate, then serve on http://localhost:3000 and reload on change
bun test           # in-process tests, no generated files needed
bun run typecheck  # tsc; run after generate, it also checks handlers against their schemas
bun run generate   # write .kivin/generated (manifest, client, OpenAPI)
bun run build      # compile a single binary to bin/${name}
\`\`\`

Try it: \`curl localhost:3000/greetings/Ada\`.

The routes live in \`src/greeting.controller.ts\`; \`src/app.ts\` wires the modules together.
`,
  };
}

/**
 * Scaffolds a project. Installs nothing and runs no scripts. Refuses a target that exists and is not an empty
 * directory, and writes with the exclusive flag so an existing file is never replaced.
 */
export function initProject(options: InitOptions): InitResult {
  if (!SEMVER.test(options.version)) {
    throw new Error(`init: cannot derive @kivinjs/* ranges from CLI version "${options.version}"`);
  }
  if (options.dir.length === 0) {
    throw new Error('init requires a target directory');
  }

  const root = resolve(options.cwd ?? process.cwd(), options.dir);
  const name = basename(root);
  const problem = validatePackageName(name);
  if (problem) {
    throw new Error(`init: "${name}" is not a usable package name: ${problem}. Choose another directory name.`);
  }

  // lstat: a dangling symlink at the target still counts as existing.
  if (lstatSync(root, { throwIfNoEntry: false })) {
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`init: ${root} exists and is not a directory`);
    }
    if (readdirSync(root).length > 0) {
      throw new Error(`init: ${root} is not empty; nothing was written`);
    }
  }

  const files = templateFiles(name, options.version);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: 'wx' });
  }

  return { root, name, files: Object.keys(files) };
}
