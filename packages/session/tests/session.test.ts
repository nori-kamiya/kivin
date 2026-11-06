import { createApp, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivinjs/core';
import { createSessionMiddleware, getSession, MemorySessionStore, type SessionStore } from '@kivinjs/session';
import { describe, expect, test } from 'bun:test';

const SECRET = 'session-test-secret';

class Routes {
  login({ context }: { context: RequestContext }) {
    const session = getSession<{ userId: string; visits: number }>(context.request);
    session.regenerate();
    session.set('userId', 'u1');
    return { id: session.id };
  }

  me({ context }: { context: RequestContext }) {
    const session = getSession<{ userId: string; visits: number }>(context.request);
    return { userId: session.get('userId') ?? null, isNew: session.isNew };
  }

  visit({ context }: { context: RequestContext }) {
    const session = getSession<{ visits: number }>(context.request);
    session.set('visits', (session.get('visits') ?? 0) + 1);
    return { visits: session.get('visits') };
  }

  logout({ context }: { context: RequestContext }) {
    getSession(context.request).destroy();
    return { ok: true };
  }

  fail({ context }: { context: RequestContext }) {
    getSession(context.request).set('userId', 'nope');
    throw new Error('handler failed');
  }
}

type Route = AppManifest['routes'][number];
const route = (fullPath: string, methodName: string): Route => ({
  method: 'GET', fullPath, controller: Routes, methodName, parameters: [{ index: 0, source: 'input', fields: ['context'] }],
  guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] },
});
const build = (options: Partial<Parameters<typeof createSessionMiddleware>[0]> = {}) => {
  const store = (options.store ?? new MemorySessionStore()) as MemorySessionStore;
  const app = createApp(defineApplication({
    modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
    globals: { middleware: [createSessionMiddleware({ secret: SECRET, store, ...options })] },
  }), { routes: [route('/login', 'login'), route('/me', 'me'), route('/visit', 'visit'), route('/logout', 'logout'), route('/fail', 'fail')] });
  const call = async (path: string, cookie?: string) => app.fetch(new Request(`http://localhost${path}`, cookie ? { headers: { cookie } } : {}));
  return { app, store, call };
};
const cookieOf = (response: Response) => response.headers.getSetCookie()[0]?.split(';')[0];

describe('session middleware', () => {
  test('no session is created (no cookie, nothing stored) until something is set', async () => {
    const { store, call } = build();
    const anonymous = await call('/me');
    expect(await anonymous.json()).toEqual({ userId: null, isNew: true });
    expect(anonymous.headers.getSetCookie()).toEqual([]);
    expect(store.size).toBe(0);
  });

  test('login sets a signed cookie; later requests see the data', async () => {
    const { store, call } = build();
    const login = await call('/login');
    const header = login.headers.getSetCookie()[0]!;
    expect(header).toMatch(/^sid=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; Max-Age=86400; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(store.size).toBe(1);
    const me = await call('/me', cookieOf(login));
    expect(await me.json()).toEqual({ userId: 'u1', isNew: false });
    expect(me.headers.getSetCookie()).toEqual([]);
  });

  test('changes are saved; forged or unknown IDs get a fresh session (never the client value)', async () => {
    const { store, call } = build();
    const first = await call('/visit');
    const cookie = cookieOf(first)!;
    expect(await (await call('/visit', cookie)).json()).toEqual({ visits: 2 });
    expect(await (await call('/visit', cookie)).json()).toEqual({ visits: 3 });

    const id = cookie.slice(4, cookie.lastIndexOf('.'));
    const forged = await call('/me', `sid=${id}.${'A'.repeat(43)}`);
    expect(await forged.json()).toEqual({ userId: null, isNew: true });
    const unsigned = await call('/me', `sid=${id}`);
    expect(await unsigned.json()).toMatchObject({ isNew: true });
    store.delete(id);
    const expired = await call('/visit', cookie);
    expect(await expired.json()).toEqual({ visits: 1 });
    expect(cookieOf(expired)).not.toBe(cookie);
  });

  test('regenerate() moves the data to a new ID and deletes the old one (session fixation)', async () => {
    const { store, call } = build();
    const before = cookieOf(await call('/visit'))!;
    const login = await call('/login', before);
    const after = cookieOf(login)!;
    expect(after).not.toBe(before);
    expect(store.size).toBe(1);
    expect(await (await call('/me', before)).json()).toEqual({ userId: null, isNew: true });
    expect(await (await call('/me', after)).json()).toEqual({ userId: 'u1', isNew: false });
  });

  test('destroy() deletes the session and clears the cookie', async () => {
    const { store, call } = build({ cookie: { secure: true, domain: 'example.com' } });
    const cookie = cookieOf(await call('/login'))!;
    const logout = await call('/logout', cookie);
    expect(logout.headers.getSetCookie()[0]).toMatch(/^sid=; Max-Age=0; .*Domain=example\.com; Path=\/; Secure; SameSite=Lax$/);
    expect(store.size).toBe(0);
    expect(await (await call('/me', cookie)).json()).toEqual({ userId: null, isNew: true });
  });

  test('rolling sessions renew the lifetime on every request; failed handlers do not save', async () => {
    const touched: string[] = [];
    const memory = new MemorySessionStore();
    const store: SessionStore = {
      get: (id) => memory.get(id),
      set: (id, data, ttl) => memory.set(id, data, ttl),
      delete: (id) => memory.delete(id),
      touch: (id, data, ttl) => {
        touched.push(id);
        memory.touch(id, data, ttl);
      },
    };
    const { call } = build({ store, rolling: true, ttl: 60, name: 'app_session' });
    const login = await call('/login');
    const cookie = cookieOf(login)!;
    expect(cookie).toStartWith('app_session=');
    const me = await call('/me', cookie);
    expect(me.headers.getSetCookie()[0]).toContain('Max-Age=60');
    expect(touched).toHaveLength(1);

    const original = console.error;
    console.error = () => undefined;
    try {
      const failed = await call('/fail', cookie);
      expect(failed.status).toBe(500);
    } finally {
      console.error = original;
    }
    expect(await (await call('/me', cookie)).json()).toEqual({ userId: 'u1', isNew: false });
  });

  test('getSession without the middleware is a clear error; the memory store expires entries', async () => {
    expect(() => getSession(new Request('http://localhost/'))).toThrow(/createSessionMiddleware/);
    const store = new MemorySessionStore({ sweepIntervalMs: 0 });
    store.set('a', { x: 1 }, 0.05);
    expect(store.get('a')).toEqual({ x: 1 });
    await Bun.sleep(80);
    expect(store.get('a')).toBeUndefined();
    store.set('b', { x: 2 }, 0.05);
    await Bun.sleep(80);
    expect(store.size).toBe(0);
  });
});
