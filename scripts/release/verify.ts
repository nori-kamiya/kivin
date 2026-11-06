// Checks .release/ against the workspace. With --tag <tag> it also enforces the tag rules.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { publishOrder, readTarball, readWorkspaceManifests, verifyReleaseTag, verifyTarball } from './lib';
import { integrityOf, type ReleaseManifest } from './publish';

const root = resolve(import.meta.dir, '../..');
const releaseDir = join(root, '.release');
const problems: string[] = [];

function git(...args: string[]): { ok: boolean; stdout: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim() };
}

const manifestPath = join(releaseDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('.release/manifest.json not found. Run `bun run release:pack` first.');
  process.exit(1);
}

const release = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest;
const workspace = publishOrder(readWorkspaceManifests(root));
const expectedVersion = workspace[0]?.version ?? '';

const expectedOrder = workspace.map((manifest) => manifest.name).join(', ');
const actualOrder = release.packages.map((entry) => entry.name).join(', ');
if (expectedOrder !== actualOrder) {
  problems.push(`manifest.json lists [${actualOrder}], but the workspace publish order is [${expectedOrder}]`);
}

for (const entry of release.packages) {
  const path = join(releaseDir, entry.tarball);
  if (!existsSync(path)) {
    problems.push(`${entry.name}: ${entry.tarball} is missing`);
    continue;
  }
  const bytes = readFileSync(path);
  if (integrityOf(bytes) !== entry.integrity) {
    problems.push(`${entry.name}: ${entry.tarball} does not match the integrity in manifest.json`);
  }
  if (entry.version !== expectedVersion) {
    problems.push(`${entry.name}: manifest.json says ${entry.version}, expected ${expectedVersion}`);
  }
  try {
    const files = readTarball(bytes);
    problems.push(...verifyTarball({ files, expectedVersion }));
    const packed = JSON.parse(new TextDecoder().decode(files.get('package.json') ?? new Uint8Array())) as { name?: string };
    if (packed.name !== entry.name) {
      problems.push(`${entry.tarball} contains ${String(packed.name)}, expected ${entry.name}`);
    }
  } catch (error) {
    problems.push(`${entry.name}: cannot read ${entry.tarball}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const tagIndex = process.argv.indexOf('--tag');
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1];
  if (!tag) {
    problems.push('--tag needs a value');
  } else {
    problems.push(...verifyReleaseTag({ tag, manifests: workspace, changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8') }));
    const commit = git('rev-parse', '--verify', `${tag}^{commit}`);
    if (!commit.ok) {
      problems.push(`tag ${tag} does not exist in this checkout`);
    } else if (!git('merge-base', '--is-ancestor', commit.stdout, 'origin/main').ok) {
      problems.push(`${tag} (${commit.stdout.slice(0, 12)}) is not an ancestor of origin/main`);
    }
  }
}

if (problems.length > 0) {
  console.error(`release verification failed (${problems.length}):\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`release verification passed: ${release.packages.length} packages at ${expectedVersion}${tagIndex === -1 ? '' : ` (tag ${process.argv[tagIndex + 1]})`}`);
