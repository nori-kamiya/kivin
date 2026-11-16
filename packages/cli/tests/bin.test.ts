import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import pkg from '../package.json';

const bin = join(import.meta.dir, '../src/bin.ts');

async function run(...args: string[]) {
  const proc = Bun.spawn([process.execPath, bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe('kivin bin', () => {
  for (const flag of ['--help', '-h']) {
    test(`given ${flag}, when run, then usage goes to stdout with exit 0`, async () => {
      const { stdout, code } = await run(flag);
      expect(code).toBe(0);
      expect(stdout).toContain('Usage: kivin');
      expect(stdout).toContain('generate');
    });
  }

  for (const flag of ['--version', '-v']) {
    test(`given ${flag}, when run, then prints the CLI package version with exit 0`, async () => {
      const { stdout, code } = await run(flag);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe(pkg.version);
    });
  }

  test('given an unknown command, when run, then usage goes to stderr with non-zero exit', async () => {
    const { stdout, stderr, code } = await run('bogus');
    expect(code).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('Usage: kivin');
    expect(stderr).toContain('bogus');
  });
});

describe('kivin generate and the entry it imports', () => {
  const fixture = join(import.meta.dir, 'fixtures/build-side-effects-app/src/app.ts');

  test('exits after writing the files although an imported module keeps a handle open, and runs no provider or hook', async () => {
    const outDir = join(import.meta.dir, '.generated/build-side-effects');
    const proc = Bun.spawn([process.execPath, bin, 'generate', '--entry', fixture, '--outDir', outDir], { stdout: 'pipe', stderr: 'pipe' });
    // Before the fix the process never exited (the module's interval kept it alive).
    const timeout = setTimeout(() => proc.kill(), 20_000);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timeout);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('manifest: ');
    expect(stdout).toContain('openapi: ');
    expect(await Bun.file(join(outDir, 'manifest.ts')).text()).toContain('ItemsController');
  }, 30_000);

  test('a failing command still exits non-zero with the message', async () => {
    const { stderr, code } = await run('generate', '--entry', join(import.meta.dir, 'fixtures/does-not-exist/app.ts'), '--outDir', join(import.meta.dir, '.generated/missing'));
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
