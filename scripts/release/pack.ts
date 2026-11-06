// Builds, then packs every package into .release/ with `bun pm pack`.
// npm pack is not an option: it leaves "workspace:" ranges in package.json, which no registry client can install.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { integrityOf, publishOrder, readWorkspaceManifests, SCOPE } from './lib';
import type { ReleaseManifest } from './publish';

const root = resolve(import.meta.dir, '../..');
const releaseDir = join(root, '.release');

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited with ${result.exitCode} in ${cwd}`);
  }
}

// Tarballs are published without lifecycle scripts, so dist/ must exist before packing.
run(['bun', 'run', 'build'], root);

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir);

const packages: ReleaseManifest['packages'] = [];
for (const manifest of publishOrder(readWorkspaceManifests(root))) {
  const directory = join(root, 'packages', manifest.name.slice(SCOPE.length));
  run(['bun', 'pm', 'pack', '--ignore-scripts', '--destination', releaseDir], directory);
  const tarball = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
  packages.push({ name: manifest.name, version: manifest.version, tarball, integrity: integrityOf(readFileSync(join(releaseDir, tarball))) });
}

writeFileSync(join(releaseDir, 'manifest.json'), `${JSON.stringify({ packages } satisfies ReleaseManifest, null, 2)}\n`);
console.log(`packed ${packages.length} packages into ${releaseDir}`);
