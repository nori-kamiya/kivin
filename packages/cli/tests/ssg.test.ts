import { generateStaticSite } from '@kivinjs/cli';
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class Pages {}

const route = (fullPath: string, method = 'GET') => ({
  method, fullPath, controller: Pages, methodName: 'any', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] },
}) as never;

// The app is stood in for: generateStaticSite only calls `fetch`.
const app = {
  fetch(request: Request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/broken') {
      return new Response('boom', { status: 500 });
    }
    if (pathname === '/redirect') {
      return new Response(null, { status: 302, headers: { location: '/' } });
    }
    if (pathname === '/binary') {
      return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (pathname === '/stats') {
      return Response.json({ ok: true });
    }
    if (pathname === '/feed.xml') {
      return new Response('<rss/>', { headers: { 'content-type': 'application/rss+xml' } });
    }
    return new Response(`<p>${pathname}</p>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};

const tempDir = () => join(tmpdir(), `kivin-ssg-${crypto.randomUUID()}`);
const listFiles = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1)).sort();

describe('generateStaticSite', () => {
  test('given HTML and other content types, when generated, then files are named by format and media type', async () => {
    const outDir = tempDir();
    try {
      const result = await generateStaticSite({
        app, outDir,
        manifest: { routes: [route('/'), route('/about'), route('/docs/'), route('/stats'), route('/feed.xml'), route('/legacy.html'), route('/items', 'POST')] },
      });

      expect(listFiles(outDir)).toEqual(['about/index.html', 'docs/index.html', 'feed.xml', 'index.html', 'legacy.html', 'stats.json']);
      expect(readFileSync(join(outDir, 'about/index.html'), 'utf8')).toBe('<p>/about</p>');
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('given the file format, when generated, then pages are written as <path>.html', async () => {
    const outDir = tempDir();
    try {
      await generateStaticSite({ app, outDir, format: 'file', manifest: { routes: [route('/'), route('/about'), route('/a/b')] } });

      expect(listFiles(outDir)).toEqual(['a/b.html', 'about.html', 'index.html']);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('given dynamic routes, when params are declared, then each value is rendered and undeclared routes are skipped with a warning', async () => {
    const outDir = tempDir();
    try {
      const result = await generateStaticSite({
        app, outDir,
        manifest: { routes: [route('/posts/:slug'), route('/users/:id'), route('/files/*')] },
        params: { '/posts/:slug': async () => [{ slug: 'a' }, { slug: 'b c' }, { other: 'x' }], '/files/*': [{ '*': 'docs/guide' }] },
      });

      expect(listFiles(outDir)).toEqual(['files/docs/guide/index.html', 'posts/a/index.html', 'posts/b c/index.html']);
      expect(readFileSync(join(outDir, 'posts/b c/index.html'), 'utf8')).toBe('<p>/posts/b%20c</p>');
      expect(result.warnings).toEqual([
        '/posts/:slug: skipped {"other":"x"} (a path param is missing)',
        '/users/:id: skipped (path params without @StaticParams or the params option)',
      ]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('given param values that try to leave outDir, when generated, then nothing is written outside it', async () => {
    const root = tempDir();
    const outDir = join(root, 'out');
    try {
      const result = await generateStaticSite({
        app, outDir,
        manifest: { routes: [route('/p/:id'), route('/w/*')] },
        params: { '/p/:id': [{ id: '../../escape' }, { id: '..' }], '/w/*': [{ '*': '../../escape' }] },
      });

      expect(existsSync(join(root, 'escape'))).toBe(false);
      expect(existsSync(join(root, 'escape.html'))).toBe(false);
      expect(existsSync(outDir) ? listFiles(outDir) : []).toEqual([]);
      expect(result.files).toEqual([]);
      expect(result.warnings).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('given errors, redirects, unknown types and exclusions, when generated, then they are skipped and reported', async () => {
    const outDir = tempDir();
    try {
      const result = await generateStaticSite({
        app, outDir,
        manifest: { routes: [route('/broken'), route('/redirect'), route('/binary'), route('/admin'), route('/admin/users'), route('/ok')] },
        exclude: ['/admin', /^\/admin\//],
      });

      expect(listFiles(outDir)).toEqual(['ok/index.html']);
      expect(result.warnings).toEqual([
        '/broken: skipped (status 500)',
        '/redirect: skipped (status 302)',
        '/binary: skipped (no file name for "application/octet-stream")',
      ]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('given two routes that map to one file, when generated, then the second is skipped instead of overwriting', async () => {
    const outDir = tempDir();
    try {
      const result = await generateStaticSite({ app, outDir, manifest: { routes: [route('/a'), route('/a/')] } });

      expect(listFiles(outDir)).toEqual(['a/index.html']);
      expect(result.warnings).toEqual(['/a/: skipped (a/index.html was already written for /a)']);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('kivin ssg', () => {
  test('given the fixture app, when generated then rendered, then startup hooks ran, @StaticParams pages exist and output is escaped', async () => {
    const bin = join(import.meta.dir, '../src/bin.ts');
    const entry = join(import.meta.dir, 'fixtures/ssg-app/src/app.ts');
    const root = tempDir();
    const run = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    try {
      expect((await run('generate', '--entry', entry, '--outDir', join(root, 'generated'))).code).toBe(0);
      const { stdout, stderr, code } = await run('ssg', '--entry', entry, '--manifest', join(root, 'generated/manifest.ts'), '--outDir', join(root, 'site'), '--exclude', '/admin');

      expect(code).toBe(0);
      expect(stderr).toBe('warning: /users/:id: skipped (path params without @StaticParams or the params option)\n');
      expect(stdout).toContain('ssg: 4 file(s)');
      expect(listFiles(join(root, 'site'))).toEqual(['api/posts.json', 'index.html', 'posts/hello/index.html', 'posts/second/index.html']);
      expect(readFileSync(join(root, 'site/posts/hello/index.html'), 'utf8')).toBe('<!DOCTYPE html><html><body><h1>Hello &lt;world&gt;</h1></body></html>');
      expect(JSON.parse(readFileSync(join(root, 'site/api/posts.json'), 'utf8'))).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
