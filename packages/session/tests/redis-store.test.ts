import { createApp, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivinjs/core';
import { createSessionMiddleware, getSession, RedisSessionStore, type RedisCommandClient } from '@kivinjs/session';
import { describe, expect, test } from 'bun:test';

/** Just enough of Redis (GET / SET PX / DEL / PEXPIRE with expiry) to check the commands the store sends. */
class FakeRedis implements RedisCommandClient {
  readonly commands: string[][] = [];
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  async send(command: string, args: string[]) {
    this.commands.push([command, ...args]);
    const [key = '', ...rest] = args;
    switch (command) {
      case 'GET':
        return this.live(key)?.value ?? null;
      case 'SET': {
        expect(rest[1]).toBe('PX');
        const ms = Number(rest[2]);
        if (!(ms > 0)) {
          throw new Error('ERR invalid expire time in set');
        }
        this.entries.set(key, { value: rest[0]!, expiresAt: Date.now() + ms });
        return 'OK';
      }
      case 'DEL':
        return args.filter((name) => this.entries.delete(name)).length;
      case 'PEXPIRE': {
        const entry = this.live(key);
        if (!entry) {
          return 0;
        }
        const ms = Number(rest[0]);
        if (ms <= 0) {
          this.entries.delete(key);
        } else {
          entry.expiresAt = Date.now() + ms;
        }
        return 1;
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  }

  get keys() {
    return [...this.entries.keys()].filter((key) => this.live(key));
  }

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}

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
const cookieOf = (response: Response) => response.headers.getSetCookie()[0]?.split(';')[0];

describe('RedisSessionStore', () => {
  test('stores the JSON data under the prefix with the TTL in milliseconds; get / touch / delete', async () => {
    const redis = new FakeRedis();
    const store = new RedisSessionStore(redis);
    await store.set('abc', { userId: 'u1', roles: ['admin'] }, 60);
    expect(redis.commands.at(-1)).toEqual(['SET', 'kivin:sess:abc', '{"userId":"u1","roles":["admin"]}', 'PX', '60000']);
    const data = await store.get('abc');
    expect(data).toEqual({ userId: 'u1', roles: ['admin'] });
    expect(redis.commands.at(-1)).toEqual(['GET', 'kivin:sess:abc']);
    expect(await store.get('missing')).toBeUndefined();

    await store.touch('abc', {}, 1.5);
    expect(redis.commands.at(-1)).toEqual(['PEXPIRE', 'kivin:sess:abc', '1500']);
    await store.touch('missing', {}, 60);
    expect(redis.keys).toEqual(['kivin:sess:abc']);

    await store.delete('abc');
    expect(redis.commands.at(-1)).toEqual(['DEL', 'kivin:sess:abc']);
    expect(await store.get('abc')).toBeUndefined();
  });

  test('a custom prefix; a non-positive TTL leaves nothing stored (as with the memory store)', async () => {
    const redis = new FakeRedis();
    const store = new RedisSessionStore(redis, { prefix: 'app:s:' });
    await store.set('abc', { n: 1 }, 30);
    expect(redis.keys).toEqual(['app:s:abc']);
    await store.set('abc', { n: 2 }, 0);
    expect(redis.commands.at(-1)).toEqual(['DEL', 'app:s:abc']);
    expect(await store.get('abc')).toBeUndefined();
    await store.set('def', { n: 3 }, 30);
    await store.touch('def', {}, 0);
    expect(await store.get('def')).toBeUndefined();
  });

  test('drives the session middleware: login (regenerate), rolling renewal, logout', async () => {
    const redis = new FakeRedis();
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      globals: { middleware: [createSessionMiddleware({ secret: 'redis-test-secret', store: new RedisSessionStore(redis), rolling: true, ttl: 60 })] },
    }), { routes: [route('/login', 'login'), route('/me', 'me'), route('/logout', 'logout')] });
    const call = (path: string, cookie?: string) => app.fetch(new Request(`http://localhost${path}`, cookie ? { headers: { cookie } } : {}));

    const anonymous = await call('/me');
    expect(await anonymous.json()).toEqual({ userId: null });
    expect(redis.commands).toEqual([]);

    const cookie = cookieOf(await call('/login'))!;
    const id = cookie.slice(cookie.indexOf('=') + 1, cookie.lastIndexOf('.'));
    expect(redis.commands).toEqual([['SET', `kivin:sess:${id}`, '{"userId":"u1"}', 'PX', '60000']]);

    redis.commands.length = 0;
    expect(await (await call('/me', cookie)).json()).toEqual({ userId: 'u1' });
    expect(redis.commands).toEqual([['GET', `kivin:sess:${id}`], ['PEXPIRE', `kivin:sess:${id}`, '60000']]);

    const relogin = cookieOf(await call('/login', cookie))!;
    expect(relogin).not.toBe(cookie);
    expect(redis.keys).toHaveLength(1);
    expect(await (await call('/me', cookie)).json()).toEqual({ userId: null });

    await call('/logout', relogin);
    expect(redis.keys).toEqual([]);
  });
});
