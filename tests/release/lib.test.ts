import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import {
  integrityOf,
  publishOrder,
  readTarball,
  verifyReleaseTag,
  verifyTarball,
  type WorkspaceManifest,
} from '../../scripts/release/lib';
import { buildTarball, validFiles, validPackageJson } from './tar-fixture';

function pkg(name: string, extra: Partial<WorkspaceManifest> = {}): WorkspaceManifest {
  return { name, version: '1.2.3', ...extra };
}

describe('publishOrder', () => {
  test('given a dependency and a peerDependency on @kivinjs packages, when ordering, then dependencies come before their dependents', () => {
    const order = publishOrder([
      pkg('@kivinjs/static', { dependencies: { '@kivinjs/http': 'workspace:^' }, peerDependencies: { '@kivinjs/core': 'workspace:^' } }),
      pkg('@kivinjs/http', { peerDependencies: { '@kivinjs/core': 'workspace:^' } }),
      pkg('@kivinjs/core'),
    ]);
    expect(order.map((entry) => entry.name)).toEqual(['@kivinjs/core', '@kivinjs/http', '@kivinjs/static']);
  });

  test('given a devDependency on another @kivinjs package, when ordering, then it does not constrain the order', () => {
    const order = publishOrder([pkg('@kivinjs/a', { devDependencies: { '@kivinjs/b': 'workspace:*' } }), pkg('@kivinjs/b', { devDependencies: { '@kivinjs/a': 'workspace:*' } })]);
    expect(order.map((entry) => entry.name)).toEqual(['@kivinjs/a', '@kivinjs/b']);
  });

  test('given packages with no relation, when ordering, then the result is sorted by name regardless of input order', () => {
    const order = publishOrder([pkg('@kivinjs/z'), pkg('@kivinjs/a'), pkg('@kivinjs/m')]);
    expect(order.map((entry) => entry.name)).toEqual(['@kivinjs/a', '@kivinjs/m', '@kivinjs/z']);
  });

  test('given non-@kivinjs dependencies, when ordering, then they are ignored', () => {
    const order = publishOrder([pkg('@kivinjs/a', { dependencies: { valibot: '^1.5.0' } })]);
    expect(order).toHaveLength(1);
  });

  test('given a dependency cycle, when ordering, then it throws naming the packages in the cycle', () => {
    expect(() =>
      publishOrder([
        pkg('@kivinjs/a', { dependencies: { '@kivinjs/b': '^1' } }),
        pkg('@kivinjs/b', { peerDependencies: { '@kivinjs/a': '^1' } }),
        pkg('@kivinjs/c'),
      ]),
    ).toThrow(/cycle(?=[\s\S]*@kivinjs\/a)(?=[\s\S]*@kivinjs\/b)/i);
  });

  test('given a @kivinjs dependency that is not in the workspace, when ordering, then it throws', () => {
    expect(() => publishOrder([pkg('@kivinjs/a', { dependencies: { '@kivinjs/missing': '^1' } })])).toThrow(/@kivinjs\/missing/);
  });
});

describe('readTarball', () => {
  test('given a gzipped tarball, when reading, then paths are returned without the package/ prefix', () => {
    const files = readTarball(buildTarball({ 'package.json': '{}', 'dist/a.js': 'x'.repeat(1000) }));
    expect([...files.keys()].sort()).toEqual(['dist/a.js', 'package.json']);
    expect(new TextDecoder().decode(files.get('dist/a.js'))).toBe('x'.repeat(1000));
  });

  test('given bytes that are not gzip, when reading, then it throws', () => {
    expect(() => readTarball(new Uint8Array([1, 2, 3]))).toThrow();
  });

  test('given a gzip stream that is not a tar archive, when reading, then it throws', () => {
    expect(() => readTarball(gzipSync(new Uint8Array(600).fill(7)))).toThrow(/tar/i);
  });
});

describe('integrityOf', () => {
  test('given bytes, when hashing, then it returns the sha512 SRI string npm uses', () => {
    expect(integrityOf(new TextEncoder().encode('abc'))).toBe(
      'sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==',
    );
  });
});

describe('verifyTarball', () => {
  const verify = (files: Record<string, string>) => verifyTarball({ files: readTarball(buildTarball(files)), expectedVersion: '1.2.3' });

  test('given a well-formed package, when verifying, then there are no problems', () => {
    expect(verify(validFiles())).toEqual([]);
  });

  test('given a tarball without package.json, when verifying, then it is reported', () => {
    const { 'package.json': _omit, ...rest } = validFiles();
    expect(verify(rest).join('\n')).toMatch(/package\.json is missing/);
  });

  test('given a workspace: protocol anywhere in package.json, when verifying, then it is reported', () => {
    const problems = verify(validFiles(validPackageJson({ peerDependencies: { '@kivinjs/core': 'workspace:^' } })));
    expect(problems.join('\n')).toMatch(/workspace:/);
  });

  test('given exports, main, types and bin targets missing from the tarball, when verifying, then each is reported', () => {
    const problems = verify(
      validFiles(validPackageJson({ main: './dist/gone-main.js', types: './dist/gone-types.d.ts', bin: { kivin: './dist/gone-bin.js' }, exports: { '.': { default: './dist/gone-export.js' } } })),
    );
    const text = problems.join('\n');
    for (const target of ['gone-main.js', 'gone-types.d.ts', 'gone-bin.js', 'gone-export.js']) {
      expect(text).toContain(target);
    }
  });

  test('given main, types and bin targets without a leading ./ that are missing, when verifying, then each is reported', () => {
    const problems = verify(validFiles(validPackageJson({ main: 'dist/gone-main.js', types: 'dist/gone-types.d.ts', bin: { kivin: 'bin/gone-bin.js' } })));
    const text = problems.join('\n');
    for (const target of ['gone-main.js', 'gone-types.d.ts', 'gone-bin.js']) expect(text).toContain(target);
  });

  test('given main and bin targets without a leading ./ that exist, when verifying, then there are no problems', () => {
    const files = { ...validFiles(validPackageJson({ main: 'dist/index.js', bin: 'dist/cli.js' })), 'dist/cli.js': '#!/usr/bin/env bun' };
    expect(verify(files)).toEqual([]);
  });

  test('given an exports target without a leading ./, when verifying, then it is reported', () => {
    const problems = verify(validFiles(validPackageJson({ exports: { '.': 'dist/index.js' } })));
    expect(problems.join('\n')).toMatch(/must start with "\.\/"/);
  });

  test('given a string bin and a nested conditional export that exist, when verifying, then there are no problems', () => {
    const files = {
      ...validFiles(validPackageJson({ bin: './dist/cli.js', exports: { '.': { import: { types: './dist/index.d.ts', default: './dist/index.js' } }, './package.json': './package.json' } })),
      'dist/cli.js': '#!/usr/bin/env bun',
    };
    expect(verify(files)).toEqual([]);
  });

  test('given an exports pattern with a wildcard, when files match it, then it is satisfied and when none do it is reported', () => {
    const matching = validPackageJson({ main: undefined, types: undefined, exports: { './*': './dist/*.js' } });
    expect(verify(validFiles(matching))).toEqual([]);
    const unmatched = validPackageJson({ main: undefined, types: undefined, exports: { './x/*': './nope/*.js' } });
    expect(verify(validFiles(unmatched)).join('\n')).toMatch(/nope/);
  });

  test('given a missing README.md or LICENSE, when verifying, then each is reported', () => {
    const { 'README.md': _readme, LICENSE: _license, ...rest } = validFiles();
    const text = verify(rest).join('\n');
    expect(text).toMatch(/README\.md/);
    expect(text).toMatch(/LICENSE/);
  });

  test('given source maps, tsbuildinfo, src or tests files in the tarball, when verifying, then each is reported', () => {
    const text = verify({
      ...validFiles(),
      'dist/index.js.map': '{}',
      'tsconfig.tsbuildinfo': '{}',
      'src/index.ts': '',
      'tests/a.test.ts': '',
    }).join('\n');
    for (const path of ['index.js.map', 'tsconfig.tsbuildinfo', 'src/index.ts', 'tests/a.test.ts']) {
      expect(text).toContain(path);
    }
  });

  test('given a file merely named like a source directory inside dist, when verifying, then it is not flagged', () => {
    expect(verify({ ...validFiles(), 'dist/src.js': '' })).toEqual([]);
  });

  test('given no engines.bun, when verifying, then it is reported', () => {
    expect(verify(validFiles(validPackageJson({ engines: { node: '>=22' } }))).join('\n')).toMatch(/engines\.bun/);
  });

  test('given publishConfig.access other than public, when verifying, then it is reported', () => {
    expect(verify(validFiles(validPackageJson({ publishConfig: {} }))).join('\n')).toMatch(/publishConfig\.access/);
  });

  test('given a version different from the expected one, when verifying, then it is reported', () => {
    const problems = verifyTarball({ files: readTarball(buildTarball(validFiles())), expectedVersion: '9.9.9' });
    expect(problems.join('\n')).toMatch(/1\.2\.3.*9\.9\.9/);
  });
});

describe('verifyReleaseTag', () => {
  const manifests = [pkg('@kivinjs/a'), pkg('@kivinjs/b')];
  const changelog = '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-11-06\n';

  test('given a tag v+version shared by all packages and a changelog heading, when verifying, then there are no problems', () => {
    expect(verifyReleaseTag({ tag: 'v1.2.3', manifests, changelog })).toEqual([]);
  });

  test('given a tag that is not v + the version, when verifying, then it is reported', () => {
    expect(verifyReleaseTag({ tag: 'v1.2.4', manifests, changelog }).join('\n')).toMatch(/v1\.2\.4.*v1\.2\.3/);
    expect(verifyReleaseTag({ tag: '1.2.3', manifests, changelog }).join('\n')).toMatch(/v1\.2\.3/);
  });

  test('given packages at different versions, when verifying, then the mismatching package is named', () => {
    const problems = verifyReleaseTag({ tag: 'v1.2.3', manifests: [pkg('@kivinjs/a'), pkg('@kivinjs/b', { version: '1.2.4' })], changelog });
    expect(problems.join('\n')).toMatch(/@kivinjs\/b.*1\.2\.4/);
  });

  test('given no changelog heading for the version, when verifying, then it is reported', () => {
    expect(verifyReleaseTag({ tag: 'v1.2.3', manifests, changelog: '## [Unreleased]\n## [1.2.30]\n' }).join('\n')).toMatch(/CHANGELOG/);
  });

  test('given a prerelease version, when verifying, then it is rejected because it would be published to latest and npm refuses that', () => {
    const prerelease = [pkg('@kivinjs/a', { version: '1.2.3-rc.1' }), pkg('@kivinjs/b', { version: '1.2.3-rc.1' })];
    const problems = verifyReleaseTag({ tag: 'v1.2.3-rc.1', manifests: prerelease, changelog: '## [1.2.3-rc.1]\n' });
    expect(problems.join('\n')).toMatch(/prerelease/);
  });

  test('given a heading without brackets, when verifying, then it is accepted', () => {
    expect(verifyReleaseTag({ tag: 'v1.2.3', manifests, changelog: '## 1.2.3\n' })).toEqual([]);
  });
});
