import { createApp, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { expect, test } from 'bun:test';
import { createSecureHeadersMiddleware, SecureHeadersMiddleware } from '../src/index';

class Routes {
  explicit(context: RequestContext) {
    return context.text('secured', { headers: { 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'SAMEORIGIN' } });
  }

  plain(context: RequestContext) {
    return context.json({ ok: true });
  }
}

const route = (fullPath: string, methodName: string): AppManifest['routes'][number] => ({
  method: 'GET', fullPath, controller: Routes, methodName, parameters: [{ index: 0, source: 'context' }], guards: [], middleware: [], filters: [],
  docs: { tags: [], security: [], responses: [] },
});
const makeApp = (middleware: unknown) => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: [middleware as never] },
}), { routes: [route('/explicit', 'explicit'), route('/plain', 'plain')] });

test('secure headers middleware adds defaults without overriding explicit headers', async () => {
  const response = await makeApp(SecureHeadersMiddleware).fetch(new Request('http://localhost/explicit'));
  expect(response.status).toBe(200);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(await response.text()).toBe('secured');
});

test('configured secure headers middleware can add CSP and override default policies', async () => {
  const Configured = createSecureHeadersMiddleware({ contentSecurityPolicy: "default-src 'self'", frameOptions: 'SAMEORIGIN', referrerPolicy: null });
  const response = await makeApp(Configured).fetch(new Request('http://localhost/plain'));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toBe("default-src 'self'");
  expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(response.headers.get('referrer-policy')).toBeNull();
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});
