import { createApp, defineApplication, defineModule, type AppManifest, type RequestHook } from '@kivinjs/core';
import { createMethodOverride, createTrailingSlash } from '@kivinjs/http';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

class Posts {
  update({ params, body }: { params: { id: string }; body: unknown }) {
    return { method: 'PUT', id: params.id, body };
  }

  remove({ params }: { params: { id: string } }) {
    return { method: 'DELETE', id: params.id };
  }

  create({ body }: { body: unknown }) {
    return { method: 'POST', body };
  }

  list() {
    return { method: 'GET' };
  }
}

type Route = AppManifest['routes'][number];
const route = (method: Route['method'], fullPath: string, methodName: string, fields: Array<'params' | 'body'>, consumes?: 'application/x-www-form-urlencoded'): Route => ({
  method, fullPath, controller: Posts, methodName, parameters: fields.length ? [{ index: 0, source: 'input', fields }] : [],
  guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [], ...(consumes ? { consumes } : {}) },
});
const manifest: AppManifest = {
  routes: [
    route('PUT', '/posts/:id', 'update', ['params', 'body'], 'application/x-www-form-urlencoded'),
    route('DELETE', '/posts/:id', 'remove', ['params']),
    route('POST', '/posts', 'create', ['body'], 'application/x-www-form-urlencoded'),
    route('GET', '/posts', 'list', []),
  ],
};
const appWith = (onRequest: RequestHook) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Posts], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  onRequest,
}), manifest);

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

describe('createMethodOverride', () => {
  test('form field (default): POST routed as PUT / DELETE, body still readable by the route', async () => {
    const app = appWith(createMethodOverride());
    const put = await app.fetch(new Request('http://localhost/posts/4', form({ _method: 'put', title: 'Hello' })));
    expect(await put.json()).toEqual({ method: 'PUT', id: '4', body: { _method: 'put', title: 'Hello' } });
    const del = await app.fetch(new Request('http://localhost/posts/4', form({ _method: 'DELETE' })));
    expect(await del.json()).toEqual({ method: 'DELETE', id: '4' });
  });

  test('leaves other requests alone: no field, a method not allowed, GET, non-form bodies', async () => {
    const app = appWith(createMethodOverride());
    expect(await (await app.fetch(new Request('http://localhost/posts', form({ title: 'x' })))).json()).toEqual({ method: 'POST', body: { title: 'x' } });
    expect(await (await app.fetch(new Request('http://localhost/posts', form({ _method: 'GET', title: 'x' })))).json()).toMatchObject({ method: 'POST' });
    expect(await (await app.fetch(new Request('http://localhost/posts', form({ _method: 'CONNECT' })))).json()).toMatchObject({ method: 'POST' });
    expect(await (await app.fetch(new Request('http://localhost/posts?_method=DELETE'))).json()).toEqual({ method: 'GET' });
  });

  test('header and query sources; custom allowed methods', async () => {
    const byHeader = appWith(createMethodOverride({ from: { header: 'x-http-method-override' } }));
    const viaHeader = await byHeader.fetch(new Request('http://localhost/posts/2', { method: 'POST', headers: { 'x-http-method-override': 'DELETE' } }));
    expect(await viaHeader.json()).toEqual({ method: 'DELETE', id: '2' });

    const byQuery = appWith(createMethodOverride({ from: { query: '_method' }, methods: ['DELETE'] }));
    expect(await (await byQuery.fetch(new Request('http://localhost/posts/3?_method=delete', { method: 'POST' }))).json()).toEqual({ method: 'DELETE', id: '3' });
    // PUT is not in the allowed list: stays a POST (no POST route at /posts/3 → 405).
    expect((await byQuery.fetch(new Request('http://localhost/posts/3?_method=PUT', { method: 'POST' }))).status).toBe(405);
  });
});

describe('createTrailingSlash', () => {
  const hook = (options?: Parameters<typeof createTrailingSlash>[0]) => {
    const run = createTrailingSlash(options);
    return (url: string, method = 'GET') => run(new Request(url, { method })) as Response | undefined;
  };

  test('trim (default): 301 to the path without the slash, query kept; root and clean paths untouched', () => {
    const trim = hook();
    const redirect = trim('http://localhost/posts/?page=2')!;
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/posts?page=2');
    expect(trim('http://localhost/posts//')!.headers.get('location')).toBe('/posts');
    expect(trim('http://localhost/')).toBeUndefined();
    expect(trim('http://localhost/posts')).toBeUndefined();
    expect(trim('http://localhost/posts?next=/a/')).toBeUndefined();
  });

  test('non-GET methods get 308 (method and body are kept)', () => {
    expect(hook()('http://localhost/posts/', 'POST')!.status).toBe(308);
    expect(hook({ status: 302 })('http://localhost/posts/')!.status).toBe(302);
  });

  test('append: adds the slash except for file-like paths', () => {
    const append = hook({ mode: 'append' });
    expect(append('http://localhost/docs?x=1')!.headers.get('location')).toBe('/docs/?x=1');
    expect(append('http://localhost/docs/')).toBeUndefined();
    expect(append('http://localhost/app.js')).toBeUndefined();
  });

  test('never produces a protocol-relative Location (open redirect)', () => {
    expect(hook()('http://localhost//evil.example/')!.headers.get('location')).toBe('/evil.example');
    expect(hook()('http://localhost/%5Cevil.example/')!.headers.get('location')).toBe('/%5Cevil.example');
    expect(hook({ mode: 'append' })('http://localhost//evil')!.headers.get('location')).toBe('/evil/');
  });

  test('works as an app hook in front of routing', async () => {
    const app = appWith(createTrailingSlash());
    const response = await app.fetch(new Request('http://localhost/posts/'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/posts');
    expect(await (await app.fetch(new Request('http://localhost/posts'))).json()).toEqual({ method: 'GET' });
  });
});
