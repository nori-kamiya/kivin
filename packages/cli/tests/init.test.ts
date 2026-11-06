import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import valibotPackage from '../../valibot/package.json';
import { initProject, TEMPLATE_RANGES, validatePackageName } from '../src/init';

const bin = join(import.meta.dir, '../src/bin.ts');
const repoRoot = resolve(import.meta.dir, '../../..');
const scratch = mkdtempSync(join(tmpdir(), 'kivin-init-'));
let counter = 0;

function freshCwd(): string {
  const cwd = join(scratch, `case-${counter++}`);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function listFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(root, join(prefix, entry.name)) : [join(prefix, entry.name)],
  );
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('kivin init: generated files', () => {
  test('given a new directory, when initialised, then exactly the scaffold files are written', () => {
    const cwd = freshCwd();
    const result = initProject({ dir: 'my-app', cwd, version: '1.2.3' });

    expect(result.name).toBe('my-app');
    expect(listFiles(join(cwd, 'my-app')).sort()).toEqual(
      [
        '.gitignore',
        'README.md',
        'package.json',
        'src/app.ts',
        'src/greeting.controller.ts',
        'src/greeting.module.ts',
        'src/greeting.schemas.ts',
        'src/greeting.service.ts',
        'src/greeting.test.ts',
        'src/main.ts',
        'tsconfig.json',
      ].sort(),
    );
    expect([...result.files].sort()).toEqual(listFiles(join(cwd, 'my-app')).sort());
  });

  test('given the generated package.json, then it has the five scripts and the expected dependency split', () => {
    const cwd = freshCwd();
    initProject({ dir: 'my-app', cwd, version: '1.2.3' });
    const manifest = JSON.parse(readFileSync(join(cwd, 'my-app/package.json'), 'utf8'));

    expect(manifest.name).toBe('my-app');
    expect(manifest.private).toBe(true);
    expect(Object.keys(manifest.scripts).sort()).toEqual(['build', 'dev', 'generate', 'test', 'typecheck']);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@kivin/core', '@kivin/decorators', '@kivin/valibot', 'valibot']);
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(['@kivin/cli', '@types/bun', 'typescript']);
    expect(manifest.scripts.test).toBe('bun test');
    expect(manifest.scripts.typecheck).toBe('tsc');
  });

  test('given the generated tsconfig, then it uses TC39 decorators with strict, bun types and ESNext lib', () => {
    const cwd = freshCwd();
    initProject({ dir: 'my-app', cwd, version: '1.2.3' });
    const { compilerOptions } = JSON.parse(readFileSync(join(cwd, 'my-app/tsconfig.json'), 'utf8'));

    expect(compilerOptions).not.toHaveProperty('experimentalDecorators');
    expect(compilerOptions).not.toHaveProperty('emitDecoratorMetadata');
    expect(compilerOptions.types).toEqual(['bun']);
    expect(compilerOptions.lib).toEqual(['ESNext']);
    expect(compilerOptions.strict).toBe(true);
  });

  test('given the generated .gitignore, then node_modules, .kivin and build outputs are ignored', () => {
    const cwd = freshCwd();
    initProject({ dir: 'my-app', cwd, version: '1.2.3' });
    const lines = readFileSync(join(cwd, 'my-app/.gitignore'), 'utf8').split('\n');

    expect(lines).toEqual(expect.arrayContaining(['node_modules/', '.kivin/', 'dist/', 'bin/']));
  });

  test('given the generated test, then it does not import anything under .kivin', () => {
    const cwd = freshCwd();
    initProject({ dir: 'my-app', cwd, version: '1.2.3' });
    const generatedTest = readFileSync(join(cwd, 'my-app/src/greeting.test.ts'), 'utf8');

    expect(generatedTest).toContain('createTestingApp');
    expect(generatedTest).not.toContain('.kivin');
  });
});

describe('kivin init: target directory', () => {
  test('given an empty existing directory, when initialised, then it is used', () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, 'empty-app'));

    expect(() => initProject({ dir: 'empty-app', cwd, version: '1.0.0' })).not.toThrow();
    expect(existsSync(join(cwd, 'empty-app/package.json'))).toBe(true);
  });

  test('given a non-empty directory, when initialised, then it throws and leaves the existing file untouched', () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, 'busy'));
    writeFileSync(join(cwd, 'busy/package.json'), 'precious');

    expect(() => initProject({ dir: 'busy', cwd, version: '1.0.0' })).toThrow(/not empty/);
    expect(readFileSync(join(cwd, 'busy/package.json'), 'utf8')).toBe('precious');
    expect(listFiles(join(cwd, 'busy'))).toEqual(['package.json']);
  });

  test('given a target that is a file, when initialised, then it throws', () => {
    const cwd = freshCwd();
    writeFileSync(join(cwd, 'afile'), 'x');

    expect(() => initProject({ dir: 'afile', cwd, version: '1.0.0' })).toThrow(/not a directory/);
  });

  test('given an explicit path outside the cwd, when initialised, then it is scaffolded there with the basename as the name', () => {
    const cwd = freshCwd();
    const elsewhere = freshCwd();
    const result = initProject({ dir: join(elsewhere, 'far-app'), cwd, version: '1.0.0' });

    expect(result.name).toBe('far-app');
    expect(existsSync(join(elsewhere, 'far-app/src/app.ts'))).toBe(true);
    expect(existsSync(join(cwd, 'far-app'))).toBe(false);
  });

  test('given a relative path with .., when initialised, then it resolves against the cwd and uses the final segment as the name', () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, 'a'));
    const result = initProject({ dir: 'a/../b/c-app', cwd, version: '1.0.0' });

    expect(result.root).toBe(join(cwd, 'b/c-app'));
    expect(result.name).toBe('c-app');
  });

  test('given a directory holding a symlink, when initialised, then it is treated as non-empty and nothing is overwritten', () => {
    const cwd = freshCwd();
    const victim = join(cwd, 'victim.txt');
    writeFileSync(victim, 'keep');
    mkdirSync(join(cwd, 'linked'));
    symlinkSync(victim, join(cwd, 'linked/package.json'));

    expect(() => initProject({ dir: 'linked', cwd, version: '1.0.0' })).toThrow(/not empty/);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });
});

describe('kivin init: package name', () => {
  for (const name of ['my-app', 'app', 'a.b_c-1', 'x'.repeat(214)]) {
    test(`given "${name.slice(0, 20)}", when validated, then it is accepted`, () => {
      expect(validatePackageName(name)).toBeNull();
    });
  }

  for (const name of ['', 'My-App', 'has space', '.hidden', '_private', '-dash', '@scope/pkg', 'node_modules', 'a/b', 'x'.repeat(215), 'emoji-😀']) {
    test(`given "${name.slice(0, 20)}", when validated, then it is rejected with a reason`, () => {
      expect(validatePackageName(name)).toEqual(expect.any(String));
    });
  }

  test('given a directory whose name is not a valid package name, when initialised, then it throws before writing anything', () => {
    const cwd = freshCwd();

    expect(() => initProject({ dir: 'Bad Name', cwd, version: '1.0.0' })).toThrow(/package name/);
    expect(existsSync(join(cwd, 'Bad Name'))).toBe(false);
  });
});

describe('kivin init: dependency ranges', () => {
  test('given a CLI version, when initialised, then @kivin/* use ^<version> and the rest use the constants', () => {
    const cwd = freshCwd();
    initProject({ dir: 'my-app', cwd, version: '0.3.7' });
    const manifest = JSON.parse(readFileSync(join(cwd, 'my-app/package.json'), 'utf8'));

    for (const name of ['@kivin/core', '@kivin/decorators', '@kivin/valibot']) {
      expect(manifest.dependencies[name]).toBe('^0.3.7');
    }
    expect(manifest.devDependencies['@kivin/cli']).toBe('^0.3.7');
    expect(manifest.dependencies.valibot).toBe(TEMPLATE_RANGES.valibot);
    expect(manifest.devDependencies.typescript).toBe(TEMPLATE_RANGES.typescript);
    expect(manifest.devDependencies['@types/bun']).toBe(TEMPLATE_RANGES['@types/bun']);
  });

  test('given a prerelease CLI version, when initialised, then the range is still ^<version>', () => {
    const cwd = freshCwd();
    initProject({ dir: 'my-app', cwd, version: '0.1.0-rc.1' });
    const manifest = JSON.parse(readFileSync(join(cwd, 'my-app/package.json'), 'utf8'));

    expect(manifest.dependencies['@kivin/core']).toBe('^0.1.0-rc.1');
  });

  test('given a version that is not semver, when initialised, then it throws', () => {
    expect(() => initProject({ dir: 'my-app', cwd: freshCwd(), version: '../evil' })).toThrow(/version/);
  });

  test('given the valibot constant, then it satisfies the @kivin/valibot peer range and stays in sync with it', () => {
    const peer = valibotPackage.peerDependencies.valibot;
    const floor = TEMPLATE_RANGES.valibot.replace(/^\^/, '');

    expect(Bun.semver.satisfies(floor, peer)).toBe(true);
    expect(TEMPLATE_RANGES.valibot).toBe(peer);
  });
});

describe('kivin init: template compiles', () => {
  const projectParent = join(import.meta.dir, '.generated');
  const projectDir = join(projectParent, 'init-compile');

  beforeAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
    mkdirSync(projectParent, { recursive: true });
    initProject({ dir: projectDir, cwd: projectParent, version: '0.0.0' });
  });

  test('given the scaffold, when type-checked strictly against the workspace sources, then tsc reports no errors', async () => {
    // The scaffold names published @kivin/* packages; map them to the workspace sources, and take the lib and
    // types from the monorepo setup, because the workspace sources are checked against node and bun-types, not @types/bun. main.ts needs the generated manifest, so it is excluded here;
    // pack:smoke covers generate, build and run end to end.
    const paths = Object.fromEntries(
      ['core', 'decorators', 'valibot', 'standard-schema', 'logger', 'openapi'].map((name) => [`@kivin/${name}`, [join(repoRoot, `packages/${name}/src/index.ts`)]]),
    );
    writeFileSync(
      join(projectDir, 'tsconfig.check.json'),
      JSON.stringify({
        extends: './tsconfig.json',
        compilerOptions: { lib: ['ES2022', 'ESNext.Decorators', 'DOM', 'DOM.Iterable'], types: ['node', 'bun-types'], typeRoots: [join(repoRoot, 'node_modules/@types'), join(repoRoot, 'node_modules')], paths, noEmit: true },
        include: ['src/**/*.ts'],
        exclude: ['src/main.ts'],
      }),
    );
    const proc = Bun.spawn([join(repoRoot, 'node_modules/.bin/tsc'), '-p', 'tsconfig.check.json', '--pretty', 'false'], { cwd: projectDir, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(stdout).toBe('');
    expect(code).toBe(0);
  }, 60_000);
});

describe('kivin init: command line', () => {
  async function run(cwd: string, ...args: string[]) {
    const proc = Bun.spawn([process.execPath, bin, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  test('given --help, when run, then init is listed', async () => {
    const { stdout } = await run(freshCwd(), '--help');

    expect(stdout).toContain('init');
  });

  test('given a new directory, when run, then it prints the next steps and exits 0', async () => {
    const cwd = freshCwd();
    const { stdout, code } = await run(cwd, 'init', 'cli-app');

    expect(code).toBe(0);
    expect(stdout).toContain('cd cli-app');
    expect(stdout).toContain('bun install');
    expect(stdout).toContain('bun run dev');
    expect(existsSync(join(cwd, 'cli-app/package.json'))).toBe(true);
  });

  test('given a parent path with spaces and quotes, when run, then the cd line is shell-quoted', async () => {
    const cwd = freshCwd();
    const { stdout, code } = await run(cwd, 'init', "my projects/it's$(x)/app");

    expect(code).toBe(0);
    expect(stdout).toContain(`cd 'my projects/it'\\''s$(x)/app'`);
    expect(existsSync(join(cwd, "my projects/it's$(x)/app/package.json"))).toBe(true);
  });

  test('given a non-empty directory, when run, then it exits non-zero with a clear error and writes nothing', async () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, 'busy'));
    writeFileSync(join(cwd, 'busy/keep.txt'), 'keep');
    const { stderr, code } = await run(cwd, 'init', 'busy');

    expect(code).not.toBe(0);
    expect(stderr).toContain('not empty');
    expect(listFiles(join(cwd, 'busy'))).toEqual(['keep.txt']);
  });

  test('given no directory argument, when run, then it exits non-zero with a usage error', async () => {
    const { stderr, code } = await run(freshCwd(), 'init');

    expect(code).not.toBe(0);
    expect(stderr).toContain('init requires');
  });

  test('given the generated README, then it documents the typecheck script', () => {
    const cwd = freshCwd();
    initProject({ dir: 'my-app', cwd, version: '1.2.3' });

    expect(readFileSync(join(cwd, 'my-app/README.md'), 'utf8')).toContain('bun run typecheck');
  });
});
