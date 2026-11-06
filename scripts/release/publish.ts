// Self-contained on purpose: pack.ts copies this file into .release/, and the publish job (the only one holding
// id-token: write) runs that copy with plain Node. It must import nothing from the repository, so the job needs
// no checkout and no install.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ReleaseEntry {
  name: string;
  version: string;
  tarball: string;
  integrity: string;
}

export interface ReleaseManifest {
  packages: ReleaseEntry[];
}

export function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function verifyChecksums(dir: string, entries: readonly ReleaseEntry[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(dir, entry.tarball));
    } catch {
      problems.push(`${entry.name}: tarball ${entry.tarball} is missing`);
      continue;
    }
    const actual = integrityOf(bytes);
    if (actual !== entry.integrity) {
      problems.push(`${entry.name}: ${entry.tarball} does not match manifest.json (expected ${entry.integrity}, got ${actual})`);
    }
  }
  return problems;
}

export interface PublishPlan {
  entries: readonly ReleaseEntry[];
  /** Resolves the registry's dist.integrity for name@version, or null when that version does not exist. */
  lookup: (name: string, version: string) => Promise<string | null>;
  publish: (entry: ReleaseEntry) => Promise<void>;
  log: (message: string) => void;
}

// A rerun after a partial failure must be safe, so the registry is the source of truth: same integrity means a
// previous run already published it, a different one means someone else's bytes hold that version and we stop.
export async function publishAll(plan: PublishPlan): Promise<{ published: string[]; skipped: string[] }> {
  const published: string[] = [];
  const skipped: string[] = [];
  for (const entry of plan.entries) {
    const remote = await plan.lookup(entry.name, entry.version);
    if (remote === null) {
      plan.log(`publishing ${entry.name}@${entry.version}`);
      await plan.publish(entry);
      published.push(entry.name);
    } else if (remote === entry.integrity) {
      plan.log(`skipping ${entry.name}@${entry.version}: already published with the same integrity`);
      skipped.push(entry.name);
    } else {
      throw new Error(`${entry.name}@${entry.version} exists on the registry with integrity ${remote}, but the local tarball is ${entry.integrity}`);
    }
  }
  return { published, skipped };
}

function npmLookup(name: string, version: string): Promise<string | null> {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'dist.integrity', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    if (/E404|404 Not Found/.test(`${result.stderr}${result.stdout}`)) return Promise.resolve(null);
    return Promise.reject(new Error(`npm view ${name}@${version} failed:\n${result.stderr}`));
  }
  // An existing package with an unknown version prints nothing and exits 0.
  const text = result.stdout.trim();
  return Promise.resolve(text === '' ? null : (JSON.parse(text) as string));
}

function npmPublish(dir: string, dryRun: boolean): (entry: ReleaseEntry) => Promise<void> {
  return (entry) => {
    const args = ['publish', join(dir, entry.tarball), '--access', 'public'];
    // Provenance needs the Actions OIDC token, which a local dry run does not have.
    if (dryRun) args.push('--dry-run');
    else args.push('--provenance');
    const result = spawnSync('npm', args, { stdio: 'inherit' });
    return result.status === 0 ? Promise.resolve() : Promise.reject(new Error(`npm publish ${entry.name}@${entry.version} exited with ${result.status}`));
  };
}

async function main(argv: string[]): Promise<void> {
  const dirIndex = argv.indexOf('--dir');
  const dir = resolve(dirIndex === -1 ? '.release' : (argv[dirIndex + 1] ?? '.release'));
  const dryRun = argv.includes('--dry-run');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ReleaseManifest;

  const problems = verifyChecksums(dir, manifest.packages);
  if (problems.length > 0) {
    throw new Error(`Checksum verification failed:\n${problems.join('\n')}`);
  }
  console.log(`checksums ok for ${manifest.packages.length} tarballs`);
  if (argv.includes('--check')) return;

  if (!dryRun && process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Refusing to publish outside GitHub Actions. Use --dry-run locally.');
  }

  const result = await publishAll({ entries: manifest.packages, lookup: npmLookup, publish: npmPublish(dir, dryRun), log: (message) => console.log(message) });
  console.log(`done: ${result.published.length} published, ${result.skipped.length} already present`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
