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
