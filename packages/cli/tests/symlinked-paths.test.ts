import { generateArtifacts, inspectRoutes } from '@kivinjs/cli';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bun resolves a module's relative imports from its real location, so paths kivin computes for the
// generated files must hold from there too (macOS's tmpdir is itself behind /var → /private/var).
const fixture = join(import.meta.dir, 'fixtures/static-app/src');

// The link sits at a different depth than its target, like /var → /private/var: relative paths
// counted from the link climb the wrong number of levels from the real location.
function withSymlink(target: string | undefined, run: (linked: string) => Promise<void>) {
  const root = join(realpathSync(tmpdir()), `kivin-symlink-${crypto.randomUUID()}`);
  const real = target ?? join(root, 'a/b/c/real');
  const linked = join(root, 'linked');
  mkdirSync(target ? root : real, { recursive: true });
  symlinkSync(real, linked, 'dir');
  return run(linked).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('generated files under a symlinked directory', () => {
  test('given an outDir reached through a symlink, when generated, then the manifest imports the controllers', async () => {
    await withSymlink(undefined, async (linked) => {
      const outDir = join(linked, 'deep/generated');
      const result = await generateArtifacts({ entry: join(fixture, 'app.ts'), outDir });

      expect(result.manifestPath).toBe(join(outDir, 'manifest.ts'));
      const manifest = (await import(result.manifestPath)) as { manifest: { routes: unknown[] } };
      expect(manifest.manifest.routes.length).toBeGreaterThan(0);
    });
  });

  test('given an entry inside a symlinked directory, when inspected, then its routes are listed', async () => {
    await withSymlink(fixture, async (linked) => {
      const routes = await inspectRoutes({ entry: join(linked, 'app.ts') });

      expect(routes.length).toBeGreaterThan(0);
    });
  });
});
