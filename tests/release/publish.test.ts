import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrityOf, publishAll, verifyChecksums, type ReleaseEntry } from '../../scripts/release/publish';
import { publishOrder, readWorkspaceManifests } from '../../scripts/release/lib';

const entries: ReleaseEntry[] = [
  { name: '@kivinjs/core', version: '1.0.0', tarball: 'kivin-core-1.0.0.tgz', integrity: 'sha512-core' },
  { name: '@kivinjs/http', version: '1.0.0', tarball: 'kivin-http-1.0.0.tgz', integrity: 'sha512-http' },
  { name: '@kivinjs/cli', version: '1.0.0', tarball: 'kivin-cli-1.0.0.tgz', integrity: 'sha512-cli' },
];

function run(remote: Record<string, string | null>, failOn?: string) {
  const published: string[] = [];
  const looked: string[] = [];
  const result = publishAll({
    entries,
    lookup: async (name) => {
      looked.push(name);
      return remote[name] ?? null;
    },
    publish: async (entry) => {
      if (entry.name === failOn) throw new Error('npm publish exited with 1');
      published.push(entry.name);
    },
    log: () => undefined,
  });
  return { result, published, looked };
}

describe('publishAll', () => {
  test('given nothing on the registry, when publishing, then every package is published in manifest order', async () => {
    const { result, published } = run({});
    expect(await result).toEqual({ published: ['@kivinjs/core', '@kivinjs/http', '@kivinjs/cli'], skipped: [] });
    expect(published).toEqual(['@kivinjs/core', '@kivinjs/http', '@kivinjs/cli']);
  });

  test('given a version already on the registry with the same integrity, when publishing, then it is skipped and the rest are published', async () => {
    const { result, published } = run({ '@kivinjs/core': 'sha512-core' });
    expect(await result).toEqual({ published: ['@kivinjs/http', '@kivinjs/cli'], skipped: ['@kivinjs/core'] });
    expect(published).toEqual(['@kivinjs/http', '@kivinjs/cli']);
  });

  test('given every version already published, when rerunning, then nothing is published', async () => {
    const { result, published } = run({ '@kivinjs/core': 'sha512-core', '@kivinjs/http': 'sha512-http', '@kivinjs/cli': 'sha512-cli' });
    expect((await result).published).toEqual([]);
    expect(published).toEqual([]);
  });

  test('given a registry integrity that differs from the local tarball, when publishing, then it fails naming both and publishes nothing after it', async () => {
    const { result, published, looked } = run({ '@kivinjs/http': 'sha512-other' });
    await expect(result).rejects.toThrow(/@kivinjs\/http.*sha512-other.*sha512-http/s);
    expect(published).toEqual(['@kivinjs/core']);
    expect(looked).not.toContain('@kivinjs/cli');
  });

  test('given npm publish failing midway, when publishing, then it stops and later packages are not touched', async () => {
    const { result, published } = run({}, '@kivinjs/http');
    await expect(result).rejects.toThrow(/exited with 1/);
    expect(published).toEqual(['@kivinjs/core']);
  });
});

describe('verifyChecksums', () => {
  test('given tarballs matching the manifest, when verifying, then there are no problems', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kivin-checksums-'));
    try {
      writeFileSync(join(dir, 'a.tgz'), 'alpha');
      const problems = verifyChecksums(dir, [{ name: '@kivinjs/a', version: '1.0.0', tarball: 'a.tgz', integrity: integrityOf(new TextEncoder().encode('alpha')) }]);
      expect(problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('given a tampered tarball and a missing one, when verifying, then both are reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kivin-checksums-'));
    try {
      writeFileSync(join(dir, 'a.tgz'), 'tampered');
      const problems = verifyChecksums(dir, [
        { name: '@kivinjs/a', version: '1.0.0', tarball: 'a.tgz', integrity: integrityOf(new TextEncoder().encode('alpha')) },
        { name: '@kivinjs/b', version: '1.0.0', tarball: 'b.tgz', integrity: 'sha512-x' },
      ]);
      expect(problems.join('\n')).toMatch(/@kivinjs\/a.*does not match/s);
      expect(problems.join('\n')).toMatch(/@kivinjs\/b.*b\.tgz/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the real workspace', () => {
  test('given the repository packages, when ordering them, then all 16 are present, core comes first and the order is acyclic', () => {
    const order = publishOrder(readWorkspaceManifests(join(import.meta.dir, '../..'))).map((manifest) => manifest.name);
    expect(order).toHaveLength(16);
    expect(order[0]).toBe('@kivinjs/core');
    expect(order.indexOf('@kivinjs/core')).toBeLessThan(order.indexOf('@kivinjs/http'));
    expect(order.indexOf('@kivinjs/http')).toBeLessThan(order.indexOf('@kivinjs/static'));
    expect(order.indexOf('@kivinjs/decorators')).toBeLessThan(order.indexOf('@kivinjs/logger'));
  });
});
