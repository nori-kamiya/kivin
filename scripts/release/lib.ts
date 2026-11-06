import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export { integrityOf } from './publish';

export interface WorkspaceManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export const SCOPE = '@kivinjs/';

export function readWorkspaceManifests(root: string): WorkspaceManifest[] {
  const packagesDir = join(root, 'packages');
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8')) as WorkspaceManifest)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// devDependencies are left out on purpose: they are not installed by consumers, and every package lists core there,
// so including them would turn the order into a cycle with nothing to say about publishing.
export function publishOrder<T extends WorkspaceManifest>(manifests: readonly T[]): T[] {
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const remaining = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    const needs = new Set<string>();
    for (const group of [manifest.dependencies, manifest.peerDependencies]) {
      for (const name of Object.keys(group ?? {})) {
        if (!name.startsWith(SCOPE)) continue;
        if (!byName.has(name)) {
          throw new Error(`${manifest.name} depends on ${name}, which is not a workspace package`);
        }
        needs.add(name);
      }
    }
    remaining.set(manifest.name, needs);
  }

  const ordered: T[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, needs]) => needs.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) {
      throw new Error(`Dependency cycle among: ${[...remaining.keys()].sort().join(', ')}`);
    }
    // One name per round keeps the result stable: an unrelated package never jumps ahead of an earlier name.
    const next = ready[0]!;
    ordered.push(byName.get(next)!);
    remaining.delete(next);
    for (const needs of remaining.values()) needs.delete(next);
  }
  return ordered;
}

function readString(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function parsePax(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const text = new TextDecoder().decode(data);
  for (const line of text.split('\n')) {
    const match = /^\d+ ([^=]+)=(.*)$/.exec(line);
    if (match) records.set(match[1]!, match[2]!);
  }
  return records;
}

/** Reads a gzip-compressed tar archive into `path -> bytes`, dropping the leading `package/` directory npm packs under. */
export function readTarball(tarball: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(tarball);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;

    const expectedSum = Number.parseInt(readString(block, 148, 8).trim(), 8);
    let actualSum = 0;
    for (let index = 0; index < 512; index++) actualSum += index >= 148 && index < 156 ? 32 : block[index]!;
    if (Number.isNaN(expectedSum) || expectedSum !== actualSum) {
      throw new Error(`Not a tar archive: bad header checksum at offset ${offset}`);
    }

    const size = Number.parseInt(readString(block, 124, 12).trim() || '0', 8);
    const type = readString(block, 156, 1) || '0';
    const prefix = readString(block, 345, 155);
    const name = prefix ? `${prefix}/${readString(block, 0, 100)}` : readString(block, 0, 100);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      nextPath = parsePax(data).get('path') ?? nextPath;
    } else if (type === 'L') {
      nextPath = readString(data, 0, data.length);
    } else if (type === '0') {
      const path = (nextPath ?? name).replace(/^package\//, '');
      nextPath = undefined;
      files.set(path, data.slice());
    } else if (type !== 'g') {
      nextPath = undefined;
    }
  }
  if (files.size === 0) {
    throw new Error('Not a tar archive: no file entries');
  }
  return files;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function collectTargets(value: Json | undefined, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectTargets(item, into);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectTargets(item, into);
  }
}

function targetExists(target: string, paths: readonly string[]): boolean {
  const normalized = target.replace(/^\.\//, '');
  if (!normalized.includes('*')) return paths.includes(normalized);
  const pattern = new RegExp(`^${normalized.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return paths.some((path) => pattern.test(path));
}

const FORBIDDEN_DIRECTORIES = new Set(['src', 'test', 'tests', '__tests__']);

export function verifyTarball(input: { files: ReadonlyMap<string, Uint8Array>; expectedVersion: string }): string[] {
  const problems: string[] = [];
  const paths = [...input.files.keys()];
  const rawManifest = input.files.get('package.json');
  if (!rawManifest) {
    return ['package.json is missing from the tarball'];
  }

  const text = new TextDecoder().decode(rawManifest);
  const manifest = JSON.parse(text) as Record<string, Json>;
  const label = typeof manifest.name === 'string' ? manifest.name : '(unnamed)';
  const report = (message: string) => problems.push(`${label}: ${message}`);

  if (text.includes('workspace:')) report('package.json still contains a "workspace:" protocol; pack with bun pm pack, not npm pack');
  if (manifest.version !== input.expectedVersion) report(`version ${String(manifest.version)} does not equal the expected ${input.expectedVersion}`);

  // npm accepts main/types/bin without a leading "./"; exports targets must have it or npm rejects the package.
  const exportTargets: string[] = [];
  collectTargets(manifest.exports, exportTargets);
  for (const target of new Set(exportTargets)) {
    if (!target.startsWith('./')) report(`exports target ${target} must start with "./"`);
    else if (!targetExists(target, paths)) report(`entry point ${target} is not in the tarball`);
  }
  const fileTargets: string[] = [];
  collectTargets(manifest.main, fileTargets);
  collectTargets(manifest.types, fileTargets);
  collectTargets(manifest.bin, fileTargets);
  for (const target of new Set(fileTargets)) {
    if (!targetExists(target, paths)) report(`entry point ${target} is not in the tarball`);
  }

  for (const required of ['README.md', 'LICENSE']) {
    if (!input.files.has(required)) report(`${required} is missing`);
  }
  for (const path of paths) {
    if (path.endsWith('.map')) report(`${path} is a source map`);
    if (path.endsWith('.tsbuildinfo')) report(`${path} is a build cache file`);
    if (path.split('/').slice(0, -1).some((segment) => FORBIDDEN_DIRECTORIES.has(segment))) report(`${path} is a source or test file`);
  }

  const engines = manifest.engines as { bun?: unknown } | undefined;
  if (typeof engines?.bun !== 'string' || engines.bun === '') report('engines.bun is not set');
  const publishConfig = manifest.publishConfig as { access?: unknown } | undefined;
  if (publishConfig?.access !== 'public') report('publishConfig.access is not "public"');

  return problems;
}

export function verifyReleaseTag(input: { tag: string; manifests: readonly WorkspaceManifest[]; changelog: string }): string[] {
  const problems: string[] = [];
  const [first] = input.manifests;
  if (!first) return ['no packages found'];
  const version = first.version;

  for (const manifest of input.manifests) {
    if (manifest.version !== version) {
      problems.push(`${manifest.name} is at ${manifest.version}, but ${first.name} is at ${version}; all packages share one version`);
    }
  }
  // Every release goes to the default dist-tag, and npm refuses a prerelease there only after the approval step.
  if (version.includes('-')) {
    problems.push(`${version} is a prerelease; releases are published to latest, which npm refuses for prereleases`);
  }
  if (input.tag !== `v${version}`) {
    problems.push(`tag ${input.tag} does not equal v${version}`);
  }
  const escaped = version.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^##\\s+\\[?${escaped}\\]?(\\s|$)`, 'm').test(input.changelog)) {
    problems.push(`CHANGELOG.md has no heading for ${version}`);
  }
  return problems;
}
