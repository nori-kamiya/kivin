import { createApp, createBasicAuthGuard, createBearerAuthGuard, createCsrfMiddleware, defineApplication, defineModule, readBasicCredentials, type AppManifest, type RequestContext } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';

const basic = (user: string, pass: string) => `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${pass}`)))}`;

class Routes {
  admin({ context }: { context: RequestContext }) {
    return { user: readBasicCredentials(context.request)?.username };
  }

  api() {
    return { ok: true };
  }

  write() {
    return { written: true };
  }
}

const BasicGuard = createBasicAuthGuard({ users: { admin: 'p@ss:word', ユーザー: 'パスワード' }, realm: 'Admin' });
const AsyncBasicGuard = createBasicAuthGuard({ verify: async ({ username, password }) => username === 'x' && password === await Promise.resolve('y') });
const BearerGuard = createBearerAuthGuard({ tokens: ['key-1', 'key-2'] });

type Route = AppManifest['routes'][number];
const route = (fullPath: string, methodName: string, extra: Partial<Route> = {}): Route => ({
  method: 'GET', fullPath, controller: Routes, methodName, parameters: [], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] }, ...extra,
});
const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), {
  routes: [
    route('/admin', 'admin', { guards: [BasicGuard], parameters: [{ index: 0, source: 'input', fields: ['context'] }] }),
    route('/verify', 'api', { guards: [AsyncBasicGuard] }),
    route('/api', 'api', { guards: [BearerGuard] }),
  ],
});
const get = (path: string, authorization?: string) => app.fetch(new Request(`http://x${path}`, { headers: authorization ? { authorization } : {} }));

describe('createBasicAuthGuard', () => {
  test('valid credentials pass (passwords may contain ":", UTF-8 works)', async () => {
    expect(await (await get('/admin', basic('admin', 'p@ss:word'))).json()).toEqual({ user: 'admin' });
    expect(await (await get('/admin', basic('ユーザー', 'パスワード'))).json()).toEqual({ user: 'ユーザー' });
  });

  test.each([
    ['missing', undefined],
    ['wrong password', basic('admin', 'nope')],
    ['unknown user', basic('root', 'p@ss:word')],
    ['malformed base64', 'Basic !!!'],
    ['no separator', `Basic ${btoa('adminonly')}`],
    ['other scheme', 'Bearer key-1'],
  ])('%s is 401 with a Basic challenge', async (_name, header) => {
    const response = await get('/admin', header);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Basic realm="Admin", charset="UTF-8"');
  });

  test('custom async verify', async () => {
    expect((await get('/verify', basic('x', 'y'))).status).toBe(200);
    expect((await get('/verify', basic('x', 'z'))).status).toBe(401);
  });

  test('requires users or verify', () => {
    expect(() => createBasicAuthGuard({})).toThrow('users or verify');
  });
});

describe('createBearerAuthGuard', () => {
  test('accepted tokens pass, others are 401 with a Bearer challenge', async () => {
    expect((await get('/api', 'Bearer key-2')).status).toBe(200);
    const missing = await get('/api');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="api"');
    const wrong = await get('/api', 'Bearer key-3');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer realm="api", error="invalid_token"');
  });
});

describe('createCsrfMiddleware', () => {
  const csrfApp = createApp(defineApplication({
    modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
    schemaAdapter: createValibotAdapter(),
    globals: { middleware: [createCsrfMiddleware({ trustedOrigins: ['https://partner.example'] })] },
  }), { routes: [route('/write', 'write', { method: 'POST' }), route('/read', 'api')] });
  const post = (headers: Record<string, string>, path = '/write', method = 'POST') => csrfApp.fetch(new Request(`http://api.example${path}`, { method, headers: { host: 'api.example', ...headers } }));

  test.each([
    ['same-origin fetch', { 'sec-fetch-site': 'same-origin', origin: 'http://api.example' }, 200],
    ['user navigation (none)', { 'sec-fetch-site': 'none' }, 200],
    ['cross-site form post', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, 403],
    ['same-site but other origin', { 'sec-fetch-site': 'same-site', origin: 'https://sub.api.example' }, 403],
    ['cross-site JSON', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', 'content-type': 'application/json' }, 403],
    ['trusted origin', { 'sec-fetch-site': 'cross-site', origin: 'https://partner.example' }, 200],
    ['old browser, matching Origin', { origin: 'http://api.example' }, 200],
    ['old browser, foreign Origin', { origin: 'https://evil.example' }, 403],
    ['old browser, malformed Origin', { origin: 'null' }, 403],
    ['non-browser client (no headers)', {}, 200],
  ])('%s', async (_name, headers, status) => {
    expect((await post(headers as Record<string, string>)).status).toBe(status);
  });

  test('safe methods are never blocked', async () => {
    expect((await post({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, '/read', 'GET')).status).toBe(200);
  });
});
