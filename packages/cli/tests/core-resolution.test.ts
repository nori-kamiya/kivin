import { afterAll, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectModules } from '../src/index';

const repoPackages = join(import.meta.dir, '../..');
let root: string | undefined;

// Outside the repo on purpose: inside it, tsconfig `paths` would map @kivinjs/core to the workspace source and hide the second copy.
async function installCopy(appDir: string, name: 'core' | 'decorators') {
  const target = join(appDir, 'node_modules/@kivinjs', name);
  await mkdir(target, { recursive: true });
  await cp(join(repoPackages, name, 'src'), join(target, 'src'), { recursive: true });
  await writeFile(join(target, 'package.json'), JSON.stringify({ name: `@kivinjs/${name}`, version: '0.0.0', type: 'module', exports: { '.': './src/index.ts' } }));
}

afterAll(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('loadAppDefinition core resolution', () => {
  test('given an app whose @kivinjs/core is a different copy than the CLI own, when inspecting modules, then metadata is read through the app copy', async () => {
    root = await mkdtemp(join(tmpdir(), 'kivin-two-core-'));
    await installCopy(root, 'core');
    await installCopy(root, 'decorators');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'consumer', type: 'module' }));
    await writeFile(join(root, 'app.ts'), `import { Module } from '@kivinjs/decorators';

@Module({ providers: [], controllers: [], imports: [] })
class UsersModule {}

export default { modules: [UsersModule], schemaAdapter: {}, globals: { guards: [], middleware: [], filters: [] } };
`);

    const modules = await inspectModules({ entry: join(root, 'app.ts') });

    expect(modules.map((module) => module.name)).toEqual(['UsersModule']);
  });
});
