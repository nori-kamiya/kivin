// Against a real Redis: runs when REDIS_URL is set (CI's Linux job starts one), skipped otherwise.
import { createApp, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivinjs/core';
import { createSessionMiddleware, getSession, RedisSessionStore } from '@kivinjs/session';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';

const redisUrl = process.env.REDIS_URL;
const prefix = `kivin-test:session:${crypto.randomUUID()}:`;

class Routes {
  login({ context }: { context: RequestContext }) {
    const session = getSession<{ userId: string }>(context.request);
    session.regenerate();
    session.set('userId', 'u1');
    return { ok: true };
  }

  me({ context }: { context: RequestContext }) {
    return { userId: getSession<{ userId: string }>(context.request).get('userId') ?? null };
  }

  logout({ context }: { context: RequestContext }) {
    getSession(context.request).destroy();
    return { ok: true };
  }
}

type Route = AppManifest['routes'][number];
const route = (fullPath: string, methodName: string): Route => ({
  method: 'GET', fullPath, controller: Routes, methodName, parameters: [{ index: 0, source: 'input', fields: ['context'] }],
  guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] },
});

describe.skipIf(!redisUrl)('RedisSessionStore on Redis', () => {
  // The describe body runs even when skipped; hooks do not, so the client is only made with a URL.
  let client: RedisClient;
  beforeAll(() => {
    client = new RedisClient(redisUrl);
  });

  afterAll(async () => {
    const keys = (await client.send('KEYS', [`${prefix}*`])) as string[];
    if (keys.length > 0) {
      await client.send('DEL', keys);
    }
    client.close();
  });

  test('set / get / touch / delete, with the session lifetime as the key expiry', async () => {
    const store = new RedisSessionStore(client, { prefix });
    await store.set('a', { userId: 'u1', roles: ['admin'], nested: { n: 1 } }, 60);
    expect(await store.get('a')).toEqual({ userId: 'u1', roles: ['admin'], nested: { n: 1 } });
    const ttl = Number(await client.send('PTTL', [`${prefix}a`]));
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(60_000);

    await store.touch('a', {}, 600);
    expect(Number(await client.send('PTTL', [`${prefix}a`]))).toBeGreaterThan(590_000);
    await store.touch('missing', {}, 600);
    expect(await client.send('EXISTS', [`${prefix}missing`])).toBe(0);

    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
  });

  test('Redis expires the session', async () => {
    const store = new RedisSessionStore(client, { prefix });
    await store.set('short', { x: 1 }, 0.1);
    expect(await store.get('short')).toEqual({ x: 1 });
    await Bun.sleep(150);
    expect(await store.get('short')).toBeUndefined();
  });

  test('two app instances share sessions through Redis', async () => {
    const instance = () => {
      const app = createApp(defineApplication({
        modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
        globals: { middleware: [createSessionMiddleware({ secret: 'redis-integration-secret', store: new RedisSessionStore(client, { prefix }) })] },
      }), { routes: [route('/login', 'login'), route('/me', 'me'), route('/logout', 'logout')] });
      return (path: string, cookie?: string) => app.fetch(new Request(`http://localhost${path}`, cookie ? { headers: { cookie } } : {}));
    };
    const a = instance();
    const b = instance();

    const cookie = (await a('/login')).headers.getSetCookie()[0]!.split(';')[0]!;
    expect(await (await b('/me', cookie)).json()).toEqual({ userId: 'u1' });
    await b('/logout', cookie);
    expect(await (await a('/me', cookie)).json()).toEqual({ userId: null });
  });
});
