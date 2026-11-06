import { createApp, defineApplication, defineModule, getSignedCookie, serializeSignedCookie, signCookieValue, verifyCookieValue, type AppManifest, type RequestContext } from '@kivinjs/core';
import { describe, expect, test } from 'bun:test';

const SECRET = 'a-long-random-secret-for-tests';

describe('signCookieValue / verifyCookieValue', () => {
  test('round-trips and produces <value>.<43-char base64url signature>', async () => {
    const signed = await signCookieValue('session', 'user-42', SECRET);
    expect(signed).toMatch(/^user-42\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyCookieValue('session', signed, SECRET)).toBe('user-42');
  });

  test('values may contain dots and be empty', async () => {
    for (const value of ['a.b.c', '', '{"id":1}', 'ü✓']) {
      expect(await verifyCookieValue('c', await signCookieValue('c', value, SECRET), SECRET)).toBe(value);
    }
  });

  test('rejects a tampered value or signature', async () => {
    const signed = await signCookieValue('session', 'user-42', SECRET);
    const signature = signed.slice(signed.lastIndexOf('.') + 1);
    expect(await verifyCookieValue('session', `user-43.${signature}`, SECRET)).toBe(false);
    const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
    expect(await verifyCookieValue('session', `user-42.${flipped}`, SECRET)).toBe(false);
  });

  test('rejects another secret, another cookie name, and malformed input', async () => {
    const signed = await signCookieValue('session', 'user-42', SECRET);
    expect(await verifyCookieValue('session', signed, 'another-secret')).toBe(false);
    // The name is part of the signed data: a value cannot be moved to another cookie.
    expect(await verifyCookieValue('admin', signed, SECRET)).toBe(false);
    for (const malformed of ['user-42', 'user-42.', 'user-42.short', `user-42.${'!'.repeat(43)}`, '.']) {
      expect(await verifyCookieValue('session', malformed, SECRET)).toBe(false);
    }
  });

  test('rotation: signs with the first secret, accepts any', async () => {
    const old = await signCookieValue('s', 'v', 'old-secret');
    const rotated = ['new-secret', 'old-secret'];
    expect(await verifyCookieValue('s', old, rotated)).toBe('v');
    const fresh = await signCookieValue('s', 'v', rotated);
    expect(await verifyCookieValue('s', fresh, 'new-secret')).toBe('v');
    expect(await verifyCookieValue('s', fresh, 'old-secret')).toBe(false);
  });

  test('accepts raw key bytes and CryptoKey secrets', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const signed = await signCookieValue('k', 'v', bytes);
    expect(await verifyCookieValue('k', signed, bytes)).toBe('v');
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    expect(await verifyCookieValue('k', signed, key)).toBe('v');
    expect(await verifyCookieValue('k', await signCookieValue('k', 'v', key), bytes)).toBe('v');
  });

  test('rejects empty secrets', async () => {
    await expect(signCookieValue('k', 'v', '')).rejects.toThrow(TypeError);
    await expect(signCookieValue('k', 'v', [])).rejects.toThrow(TypeError);
    await expect(signCookieValue('k', 'v', new Uint8Array(0))).rejects.toThrow(TypeError);
  });
});

describe('getSignedCookie / serializeSignedCookie', () => {
  test('reads a signed cookie from a request', async () => {
    const header = await serializeSignedCookie('session', 'abc', SECRET, { httpOnly: true });
    expect(header).toContain('HttpOnly');
    const cookie = header.split(';')[0]!;
    const request = new Request('http://localhost/', { headers: { cookie } });
    expect(await getSignedCookie(request, 'session', SECRET)).toBe('abc');
    expect(await getSignedCookie(request, 'missing', SECRET)).toBeUndefined();
    expect(await getSignedCookie(new Request('http://localhost/', { headers: { cookie: 'session=abc' } }), 'session', SECRET)).toBe(false);
  });
});

describe('RequestContext signed cookies', () => {
  class Routes {
    async login({ context }: { context: RequestContext }) {
      await context.setSignedCookie('session', 'user-7', SECRET, { httpOnly: true, sameSite: 'Lax' });
      context.setCookie('plain', '1');
      return { ok: true };
    }

    async me({ context }: { context: RequestContext }) {
      const user = await context.signedCookie('session', SECRET);
      return { user: user === false ? 'tampered' : user ?? null };
    }
  }

  type Route = AppManifest['routes'][number];
  const route = (fullPath: string, methodName: string): Route => ({
    method: 'GET', fullPath, controller: Routes, methodName, parameters: [{ index: 0, source: 'input', fields: ['context'] }],
    guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] },
  });
  const app = createApp(defineApplication({ modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })] }), {
    routes: [route('/login', 'login'), route('/me', 'me')],
  });

  test('sets a signed cookie next to other cookies and reads it back', async () => {
    const login = await app.fetch(new Request('http://localhost/login'));
    const cookies = login.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(/^session=user-7\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(cookies[1]).toBe('plain=1; Path=/');

    const sessionCookie = cookies[0]!.split(';')[0]!;
    const me = await app.fetch(new Request('http://localhost/me', { headers: { cookie: sessionCookie } }));
    expect(await me.json()).toEqual({ user: 'user-7' });

    const forged = await app.fetch(new Request('http://localhost/me', { headers: { cookie: sessionCookie.replace('user-7', 'user-1') } }));
    expect(await forged.json()).toEqual({ user: 'tampered' });

    const anonymous = await app.fetch(new Request('http://localhost/me'));
    expect(await anonymous.json()).toEqual({ user: null });
  });
});
