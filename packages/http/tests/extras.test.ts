import { createApp, defineApplication, defineModule, type AppManifest } from '@kivinjs/core';
import { createRequestStorageMiddleware, escapeHtml, getCurrentRequest, getRequestValue, html, htmlResponse, proxy, raw, setRequestValue } from '@kivinjs/http';
import { describe, expect, spyOn, test } from 'bun:test';
import { gzipSync } from 'node:zlib';

describe('html', () => {
  test('escapes interpolations, keeps nested html / raw, joins arrays, drops null / booleans', () => {
    const name = '<script>alert("x")</script> & \'co\'';
    const items = ['a<b', 'c'];
    const page = html`<p title="${name}">${name}</p><ul>${items.map((item) => html`<li>${item}</li>`)}</ul>${null}${false}${undefined}${0}${raw('<hr>')}${true && html`<b>yes</b>`}`;
    expect(page.toString()).toBe('<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39;</p><ul><li>a&lt;b</li><li>c</li></ul>0<hr><b>yes</b>');
  });

  test('escapeHtml is stable across calls (no regex state) and htmlResponse sets the type', async () => {
    for (let index = 0; index < 5; index += 1) {
      expect(escapeHtml('a<b')).toBe('a&lt;b');
      expect(escapeHtml('plain')).toBe('plain');
    }
    const response = htmlResponse(html`<h1>${'Hi'}</h1>`, { status: 201 });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<h1>Hi</h1>');
  });
});

describe('proxy', () => {
  test('forwards method, body, headers (minus hop-by-hop) and X-Forwarded-*; passes encoded bodies through', async () => {
    const seen: Array<{ method: string; path: string; headers: Record<string, string>; body: string }> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const url = new URL(request.url);
        seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers), body: await request.text() });
        if (url.pathname === '/gzip') {
          return new Response(gzipSync('compressed body'), { headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain', connection: 'x-internal', 'x-internal': '1' } });
        }
        return Response.json({ ok: true }, { status: 201, headers: { 'keep-alive': 'timeout=5', 'x-upstream': 'yes' } });
      },
    });
    try {
      const response = await proxy(new URL('/items?x=1', upstream.url), new Request('http://front.example/api/items?x=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'keep-alive, x-secret-hop', 'x-secret-hop': 'drop me', 'proxy-authorization': 'Basic xyz', 'x-forwarded-for': '203.0.113.9', cookie: 'a=1' },
        body: '{"name":"Ada"}',
      }), { headers: { 'x-api-key': 'k' } });
      expect(response.status).toBe(201);
      expect(response.headers.get('x-upstream')).toBe('yes');
      expect(response.headers.get('keep-alive')).toBeNull();
      expect(await response.json()).toEqual({ ok: true });
      const forwarded = seen[0]!;
      expect(forwarded.method).toBe('POST');
      expect(forwarded.path).toBe('/items?x=1');
      expect(forwarded.body).toBe('{"name":"Ada"}');
      expect(forwarded.headers['x-secret-hop']).toBeUndefined();
      expect(forwarded.headers['proxy-authorization']).toBeUndefined();
      expect(forwarded.headers.cookie).toBe('a=1');
      expect(forwarded.headers['x-api-key']).toBe('k');
      // No server address for app.fetch-style calls: the existing chain is kept as is.
      expect(forwarded.headers['x-forwarded-for']).toBe('203.0.113.9');
      expect(forwarded.headers['x-forwarded-host']).toBe('front.example');
      expect(forwarded.headers['x-forwarded-proto']).toBe('http');
      expect(forwarded.headers.host).toBe(new URL(upstream.url).host);

      const encoded = await proxy(new URL('/gzip', upstream.url), new Request('http://front.example/gzip'), { forwarded: false });
      expect(encoded.headers.get('content-encoding')).toBe('gzip');
      expect(encoded.headers.get('x-internal')).toBeNull();
      expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await encoded.arrayBuffer())))).toBe('compressed body');
      expect(seen[1]!.headers['x-forwarded-host']).toBeUndefined();
    } finally {
      upstream.stop(true);
    }
  });

  test('502 when the upstream is unreachable, 504 on timeout', async () => {
    const log = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failed = await proxy('http://127.0.0.1:1/', new Request('http://front/'));
      expect(failed.status).toBe(502);
    } finally {
      log.mockRestore();
    }
    const slow = await proxy('http://upstream/', new Request('http://front/'), {
      timeoutMs: 20,
      fetch: (request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    expect(slow.status).toBe(504);
  });
});

describe('request storage', () => {
  class Repo {
    find() {
      return { path: new URL(getCurrentRequest()!.url).pathname, tenant: getRequestValue<string>('tenant') ?? null };
    }
  }
  const repo = new Repo();

  class Routes {
    async show() {
      setRequestValue('tenant', 'acme');
      await Bun.sleep(1);
      return repo.find();
    }
  }

  test('the current request (and values) are visible across awaits; isolated between requests', async () => {
    const manifest: AppManifest = { routes: [{ method: 'GET', fullPath: '/r/:id', controller: Routes, methodName: 'show', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } }] };
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      globals: { middleware: [createRequestStorageMiddleware()] },
    }), manifest);
    const results = await Promise.all(['/r/1', '/r/2', '/r/3'].map(async (path) => (await app.fetch(new Request(`http://localhost${path}`))).json()));
    expect(results).toEqual([{ path: '/r/1', tenant: 'acme' }, { path: '/r/2', tenant: 'acme' }, { path: '/r/3', tenant: 'acme' }]);
    expect(getCurrentRequest()).toBeUndefined();
    expect(() => setRequestValue('x', 1)).toThrow(/no current request/);
  });
});
