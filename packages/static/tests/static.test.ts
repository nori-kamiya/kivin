import { createApp, defineApplication, defineModule } from '@kivin/core';
import { serveStatic } from '../src/index';
import { createValibotAdapter } from '@kivin/valibot';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = await mkdtemp(join(tmpdir(), 'kivin-static-'));
const root = join(base, 'public');
await mkdir(join(root, 'docs'), { recursive: true });
await writeFile(join(root, 'app.js'), 'console.log("hi");\n');
await writeFile(join(root, 'index.html'), '<h1>home</h1>');
await writeFile(join(root, 'docs', 'index.html'), '<h1>docs</h1>');
await writeFile(join(root, '.env'), 'SECRET=1');
await writeFile(join(root, 'big.txt'), '0123456789');
await writeFile(join(root, 'style.css'), 'body{}');
await writeFile(join(root, 'style.css.br'), 'BROTLI');
await writeFile(join(root, 'style.css.gz'), 'GZIP');
await writeFile(join(base, 'secret.txt'), 'outside root');
afterAll(() => rm(base, { recursive: true, force: true }));

const handler = serveStatic({ root, prefix: '/assets', cacheControl: 'public, max-age=60' });
const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => handler(new Request(`http://x${path}`, { method, headers }));

describe('serveStatic', () => {
  test('serves files with type, length, validators and cache headers', async () => {
    const response = await get('/assets/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/javascript');
    expect(response.headers.get('content-length')).toBe('19');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('etag')).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.headers.get('last-modified')).toBeTruthy();
    expect(await response.text()).toBe('console.log("hi");\n');
  });

  test('serves index.html for directories', async () => {
    expect(await (await get('/assets/docs')).text()).toBe('<h1>docs</h1>');
    expect(await (await get('/assets/')).text()).toBe('<h1>home</h1>');
  });

  test.each([
    '/assets/../secret.txt',
    '/assets/%2e%2e/secret.txt',
    '/assets/..%2fsecret.txt',
    '/assets/docs/%2e%2e/%2e%2e/secret.txt',
    '/assets/app.js%00.png',
    '/assets/..%5csecret.txt',
    '/assets/.env',
    '/assets/%2eenv',
    '/assets/missing.js',
    '/other/app.js',
    '/assets/%E0%A4%A',
  ])('refuses %p', async (path) => {
    const response = await get(path);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('outside root');
  });

  test('conditional requests answer 304', async () => {
    const first = await get('/assets/app.js');
    const etag = first.headers.get('etag')!;
    expect((await get('/assets/app.js', { 'if-none-match': etag })).status).toBe(304);
    expect((await get('/assets/app.js', { 'if-none-match': `"other", ${etag.slice(2)}` })).status).toBe(304);
    expect((await get('/assets/app.js', { 'if-none-match': '"other"' })).status).toBe(200);
    expect((await get('/assets/app.js', { 'if-modified-since': first.headers.get('last-modified')! })).status).toBe(304);
    expect((await get('/assets/app.js', { 'if-modified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' })).status).toBe(200);
  });

  test('byte ranges', async () => {
    const partial = await get('/assets/big.txt', { range: 'bytes=2-5' });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await partial.text()).toBe('2345');
    expect(await (await get('/assets/big.txt', { range: 'bytes=-3' })).text()).toBe('789');
    expect(await (await get('/assets/big.txt', { range: 'bytes=7-' })).text()).toBe('789');
    const unsatisfiable = await get('/assets/big.txt', { range: 'bytes=20-30' });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */10');
    // Multiple ranges / garbage: the whole file.
    expect((await get('/assets/big.txt', { range: 'bytes=0-1,3-4' })).status).toBe(200);
    // If-Range with a stale validator: the whole file.
    expect((await get('/assets/big.txt', { range: 'bytes=0-1', 'if-range': 'Thu, 01 Jan 1970 00:00:00 GMT' })).status).toBe(200);
  });

  test('HEAD has headers and no body; other methods are 405', async () => {
    const head = await get('/assets/app.js', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('19');
    expect(await head.text()).toBe('');
    const post = await get('/assets/app.js', {}, 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  test('precompressed variants follow Accept-Encoding', async () => {
    const precompressed = serveStatic({ root, precompressed: true });
    const br = await precompressed(new Request('http://x/style.css', { headers: { 'accept-encoding': 'gzip, br' } }));
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('content-type')).toStartWith('text/css');
    expect(br.headers.get('vary')).toBe('Accept-Encoding');
    expect(await br.arrayBuffer()).toEqual(new TextEncoder().encode('BROTLI').buffer);
    const gz = await precompressed(new Request('http://x/style.css', { headers: { 'accept-encoding': 'gzip, br;q=0' } }));
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    const plain = await precompressed(new Request('http://x/style.css'));
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe('body{}');
  });

  test('SPA fallback for HTML navigations only', async () => {
    const spa = serveStatic({ root, fallback: 'index.html' });
    const page = await spa(new Request('http://x/settings/profile', { headers: { accept: 'text/html,application/xhtml+xml' } }));
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<h1>home</h1>');
    expect((await spa(new Request('http://x/missing.js', { headers: { accept: '*/*' } }))).status).toBe(404);
    expect((await spa(new Request('http://x/../secret.txt', { headers: { accept: 'text/html' } }))).status).not.toBe(500);
    expect(() => serveStatic({ root, fallback: '../secret.txt' })).toThrow('outside root');
  });

  test('works as a Bun native route next to the app', async () => {
    const app = createApp(defineApplication({ modules: [defineModule({ providers: [], controllers: [], imports: [] })], schemaAdapter: createValibotAdapter() }), { routes: [] });
    const server = app.listen({ port: 0, hostname: '127.0.0.1', routes: { '/assets/*': handler } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/assets/app.js`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('console.log("hi");\n');
      const traversal = await fetch(`http://127.0.0.1:${server.port}/assets/%2e%2e/secret.txt`);
      expect(await traversal.text()).not.toContain('outside root');
    } finally {
      await app.close();
    }
  });
});
