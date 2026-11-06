import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrityOf, publishAll, verifyChecksums, type ReleaseEntry } from '../../scripts/release/publish';
import { publishOrder, readWorkspaceManifests } from '../../scripts/release/lib';

const entries: ReleaseEntry[] = [
  { name: '@kivin/core', version: '1.0.0', tarball: 'kivin-core-1.0.0.tgz', integrity: 'sha512-core' },
  { name: '@kivin/http', version: '1.0.0', tarball: 'kivin-http-1.0.0.tgz', integrity: 'sha512-http' },
  { name: '@kivin/cli', version: '1.0.0', tarball: 'kivin-cli-1.0.0.tgz', integrity: 'sha512-cli' },
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
    expect(await result).toEqual({ published: ['@kivin/core', '@kivin/http', '@kivin/cli'], skipped: [] });
    expect(published).toEqual(['@kivin/core', '@kivin/http', '@kivin/cli']);
  });

  test('given a version already on the registry with the same integrity, when publishing, then it is skipped and the rest are published', async () => {
    const { result, published } = run({ '@kivin/core': 'sha512-core' });
    expect(await result).toEqual({ published: ['@kivin/http', '@kivin/cli'], skipped: ['@kivin/core'] });
    expect(published).toEqual(['@kivin/http', '@kivin/cli']);
  });

  test('given every version already published, when rerunning, then nothing is published', async () => {
    const { result, published } = run({ '@kivin/core': 'sha512-core', '@kivin/http': 'sha512-http', '@kivin/cli': 'sha512-cli' });
    expect((await result).published).toEqual([]);
    expect(published).toEqual([]);
  });

  test('given a registry integrity that differs from the local tarball, when publishing, then it fails naming both and publishes nothing after it', async () => {
    const { result, published, looked } = run({ '@kivin/http': 'sha512-other' });
    await expect(result).rejects.toThrow(/@kivin\/http.*sha512-other.*sha512-http/s);
    expect(published).toEqual(['@kivin/core']);
    expect(looked).not.toContain('@kivin/cli');
  });

  test('given npm publish failing midway, when publishing, then it stops and later packages are not touched', async () => {
    const { result, published } = run({}, '@kivin/http');
    await expect(result).rejects.toThrow(/exited with 1/);
    expect(published).toEqual(['@kivin/core']);
  });
});

describe('verifyChecksums', () => {
  test('given tarballs matching the manifest, when verifying, then there are no problems', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kivin-checksums-'));
    try {
      writeFileSync(join(dir, 'a.tgz'), 'alpha');
      const problems = verifyChecksums(dir, [{ name: '@kivin/a', version: '1.0.0', tarball: 'a.tgz', integrity: integrityOf(new TextEncoder().encode('alpha')) }]);
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
        { name: '@kivin/a', version: '1.0.0', tarball: 'a.tgz', integrity: integrityOf(new TextEncoder().encode('alpha')) },
        { name: '@kivin/b', version: '1.0.0', tarball: 'b.tgz', integrity: 'sha512-x' },
      ]);
      expect(problems.join('\n')).toMatch(/@kivin\/a.*does not match/s);
      expect(problems.join('\n')).toMatch(/@kivin\/b.*b\.tgz/s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the real workspace', () => {
  test('given the repository packages, when ordering them, then all 16 are present, core comes first and the order is acyclic', () => {
    const order = publishOrder(readWorkspaceManifests(join(import.meta.dir, '../..'))).map((manifest) => manifest.name);
    expect(order).toHaveLength(16);
    expect(order[0]).toBe('@kivin/core');
    expect(order.indexOf('@kivin/core')).toBeLessThan(order.indexOf('@kivin/http'));
    expect(order.indexOf('@kivin/http')).toBeLessThan(order.indexOf('@kivin/static'));
    expect(order.indexOf('@kivin/decorators')).toBeLessThan(order.indexOf('@kivin/logger'));
  });
});
