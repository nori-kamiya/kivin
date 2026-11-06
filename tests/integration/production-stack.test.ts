// End-to-end check of the production features combined, over real HTTP: CORS, CSRF, rate limiting,
// compression, ETag, timeout, Basic / Bearer guards, validation (params / query / body / headers /
// multipart), static files and error responses. Each feature has its own tests; this file catches
// problems that only show up when they are stacked (ordering, duplicated or missing headers).
import { createApp, defineApplication, defineModule, type AppManifest } from '@kivin/core';
import { createCompressMiddleware, createEtagMiddleware, createTimeoutMiddleware } from '@kivin/http';
import { createBasicAuthGuard, createBearerAuthGuard, createCsrfMiddleware, createRateLimitMiddleware } from '@kivin/security';
import { serveStatic } from '@kivin/static';
import { createValibotAdapter } from '@kivin/valibot';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import * as v from 'valibot';

const UserSchema = v.object({ name: v.pipe(v.string(), v.minLength(1)), email: v.pipe(v.string(), v.email()) });
const IdParams = v.object({ id: v.pipe(v.string(), v.regex(/^\d+$/)) });
const SearchQuery = v.object({ search: v.optional(v.string()) });
const VersionHeaders = v.object({ 'x-api-version': v.picklist(['1', '2']) });
const AvatarForm = v.object({ avatar: v.file() });

const users = Array.from({ length: 40 }, (_, index) => ({ id: String(index + 1), name: `User ${index + 1}`, email: `user${index + 1}@example.com` }));

class UsersController {
  list({ query }: { query: v.InferOutput<typeof SearchQuery> }) {
    return query.search ? users.filter((user) => user.name.includes(query.search!)) : users;
  }

  find({ params }: { params: v.InferOutput<typeof IdParams> }) {
    return users.find((user) => user.id === params.id) ?? null;
  }

  create({ body }: { body: v.InferOutput<typeof UserSchema> }) {
    return { id: '999', ...body };
  }

  avatar({ body }: { body: v.InferOutput<typeof AvatarForm> }) {
    return { size: body.avatar.size, type: body.avatar.type };
  }

  version({ headers }: { headers: v.InferOutput<typeof VersionHeaders> }) {
    return { version: headers['x-api-version'] };
  }

  admin() {
    return { admin: true };
  }

  async slow() {
    await Bun.sleep(300);
    return { late: true };
  }

  crash() {
    throw new Error('boom');
  }
}

const AdminGuard = createBasicAuthGuard({ users: { admin: 'secret' } });
const ApiKeyGuard = createBearerAuthGuard({ tokens: ['key-1'] });

type Route = AppManifest['routes'][number];
const route = (method: Route['method'], fullPath: string, methodName: string, extra: Partial<Route> = {}): Route => ({
  method, fullPath, controller: UsersController, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});
const docs = (extra: Partial<Route['docs']>): Route['docs'] => ({ tags: [], security: [], responses: [], ...extra });
const input = (...fields: Array<'params' | 'query' | 'body' | 'headers'>) => [{ index: 0, source: 'input' as const, fields }];

const routes: Route[] = [
  route('GET', '/users', 'list', { parameters: input('query'), docs: docs({ querySchema: SearchQuery }) }),
  route('GET', '/users/:id', 'find', { parameters: input('params'), docs: docs({ paramSchema: IdParams }) }),
  route('POST', '/users', 'create', { parameters: input('body'), guards: [ApiKeyGuard], docs: docs({ bodySchema: UserSchema, responses: [{ status: 201, description: 'created' }] }) }),
  route('POST', '/users/:id/avatar', 'avatar', { parameters: input('body'), guards: [ApiKeyGuard], docs: docs({ bodySchema: AvatarForm, consumes: 'multipart/form-data' }) }),
  route('GET', '/version', 'version', { parameters: input('headers'), docs: docs({ headerSchema: VersionHeaders }) }),
  route('GET', '/admin', 'admin', { guards: [AdminGuard] }),
  route('GET', '/slow', 'slow'),
  route('GET', '/crash', 'crash'),
];

const ORIGIN = 'https://app.example';
let base = '';
let tempDir = '';
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'kivin-stack-'));
  await mkdir(join(tempDir, 'public'));
  await writeFile(join(tempDir, 'public', 'app.js'), 'console.log("app");\n'.repeat(200));
  await writeFile(join(tempDir, 'secret.txt'), 'outside');

  const app = createApp(defineApplication({
    modules: [defineModule({ providers: [], controllers: [UsersController], imports: [] })],
    schemaAdapter: createValibotAdapter(),
    cors: { origin: ORIGIN, credentials: true },
    globals: {
      middleware: [
        createRateLimitMiddleware({ limit: 5, windowMs: 60_000, key: (request) => request.headers.get('x-client') ?? undefined }),
        createCompressMiddleware(),
        createEtagMiddleware(),
        createCsrfMiddleware(),
        createTimeoutMiddleware(150),
      ],
    },
  }), { routes });
  const server = app.listen({
    port: 0,
    hostname: '127.0.0.1',
    routes: { '/assets/*': serveStatic({ root: join(tempDir, 'public'), prefix: '/assets', cacheControl: 'public, max-age=60' }) },
  });
  base = `http://127.0.0.1:${server.port}`;
  close = () => app.close();
});

afterAll(async () => {
  await close();
  await rm(tempDir, { recursive: true, force: true });
});

// `decompress: false`: Bun's fetch would otherwise decode the body (and the encoding) transparently.
const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { origin: ORIGIN, ...init.headers }, decompress: false } as RequestInit);
const expectCors = (response: Response) => {
  expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(response.headers.get('access-control-allow-credentials')).toBe('true');
};

describe('production stack over HTTP', () => {
  test('a list is compressed, tagged, CORS-enabled and revalidates to 304 with CORS headers', async () => {
    const response = await call('/users', { headers: { 'accept-encoding': 'br, gzip' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('br');
    const vary = response.headers.get('vary')!.toLowerCase();
    expect(vary).toContain('origin');
    expect(vary).toContain('accept-encoding');
    expectCors(response);
    const etag = response.headers.get('etag')!;
    expect(etag).toMatch(/^W\//);
    const body = JSON.parse(new TextDecoder().decode(brotliDecompressSync(new Uint8Array(await response.arrayBuffer()))));
    expect(body).toHaveLength(40);

    const revalidated = await call('/users', { headers: { 'accept-encoding': 'br', 'if-none-match': etag } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
    expectCors(revalidated);
  });

  test('validation errors are 400 with CORS headers and normalised issues', async () => {
    const badParam = await call('/users/abc');
    expect(badParam.status).toBe(400);
    expectCors(badParam);
    expect(await badParam.json()).toEqual({ message: 'params validation failed', issues: [{ path: ['id'], message: expect.any(String) }] });

    const badHeader = await call('/version', { headers: { 'x-api-version': '9' } });
    expect(badHeader.status).toBe(400);
    expectCors(badHeader);
    expect(await (await call('/version', { headers: { 'x-api-version': '2' } })).json()).toEqual({ version: '2' });
  });

  test('POST: CSRF first, then auth, then body validation', async () => {
    const json = { 'content-type': 'application/json' };
    const crossSite = await call('/users', { method: 'POST', headers: { ...json, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', authorization: 'Bearer key-1' }, body: '{}' });
    expect(crossSite.status).toBe(403);

    const noToken = await call('/users', { method: 'POST', headers: { ...json, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ name: 'A', email: 'a@example.com' }) });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('www-authenticate')).toBe('Bearer realm="api"');
    expectCors(noToken);

    const authed = { ...json, 'sec-fetch-site': 'same-origin', authorization: 'Bearer key-1' };
    const malformed = await call('/users', { method: 'POST', headers: authed, body: '{oops' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ message: 'Invalid JSON body' });

    const invalid = await call('/users', { method: 'POST', headers: authed, body: JSON.stringify({ name: '', email: 'x', password: 'hunter2' }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('hunter2');

    const created = await call('/users', { method: 'POST', headers: authed, body: JSON.stringify({ name: 'Ada', email: 'ada@example.com' }) });
    expect(created.status).toBe(201);
    expectCors(created);
    expect(await created.json()).toEqual({ id: '999', name: 'Ada', email: 'ada@example.com' });
  });

  test('multipart upload behind auth', async () => {
    const form = new FormData();
    form.append('avatar', new File([new Uint8Array(2048)], 'me.png', { type: 'image/png' }));
    const response = await call('/users/1/avatar', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', authorization: 'Bearer key-1' }, body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ size: 2048, type: 'image/png' });
  });

  test('preflight, Basic auth, timeout, unhandled errors and unknown routes', async () => {
    const preflight = await fetch(`${base}/users`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' } });
    expect(preflight.status).toBe(204);
    expectCors(preflight);

    expect((await call('/admin')).headers.get('www-authenticate')).toStartWith('Basic');
    expect((await call('/admin', { headers: { authorization: `Basic ${btoa('admin:secret')}` } })).status).toBe(200);

    const slow = await call('/slow');
    expect(slow.status).toBe(504);
    expectCors(slow);

    const crash = await call('/crash');
    expect(crash.status).toBe(500);
    expect(await crash.json()).toEqual({ message: 'Internal Server Error' });
    expectCors(crash);

    const missing = await call('/nope');
    expect(missing.status).toBe(404);
    expectCors(missing);
  });

  test('rate limiting per client with headers and a CORS-enabled 429', async () => {
    const headers = { 'x-client': 'limited' };
    for (let index = 0; index < 5; index += 1) {
      const response = await call('/users/1', { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get('ratelimit-remaining')).toBe(String(4 - index));
    }
    const limited = await call('/users/1', { headers });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expectCors(limited);
  });

  test('static files next to the app', async () => {
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=60');
    const revalidated = await fetch(`${base}/assets/app.js`, { headers: { 'if-none-match': asset.headers.get('etag')! } });
    expect(revalidated.status).toBe(304);
    const traversal = await fetch(`${base}/assets/%2e%2e/secret.txt`);
    expect(traversal.status).toBe(404);
  });
});
