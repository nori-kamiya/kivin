import { expect, test } from 'bun:test';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../..');

// Not part of tsconfig.build.json: with `skipLibCheck: false` the installed bun-types fails its own check against
// the installed @types/node, so `tsc -b` exits non-zero for reasons outside this repository. The assertion below
// is therefore on diagnostics located in our files only.
test('given a consumer on lib ["ESNext"] with skipLibCheck false, when type-checking the packages and the generated client, then no diagnostic points at kivin code', async () => {
  const proc = Bun.spawn([process.execPath, 'x', 'tsc', '-b', 'tests/lib-esnext', '--pretty', 'false'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  const own = `${stdout}\n${stderr}`.split('\n').filter((line) => /\(\d+,\d+\): error TS\d+/.test(line) && !line.startsWith('node_modules/'));
  expect(own).toEqual([]);
}, 180_000);
