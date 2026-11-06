import {
  createApp,
  createTestingApp,
  defineApplication,
  defineModule,
  defineWebSocket,
  formatEvent,
  parseCookies,
  serializeCookie,
  setInjectableMetadata,
  type AppManifest,
  type RequestContext,
} from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

type Route = AppManifest['routes'][number];
const route = (input: Pick<Route, 'method' | 'fullPath' | 'controller' | 'methodName'> & Partial<Route>): Route => ({
  parameters: [{ index: 0, source: 'context' }],
  guards: [],
  middleware: [],
  filters: [],
  docs: { tags: [], security: [], responses: [] },
  ...input,
});

class Greeter {
  greet() {
    return 'hello';
  }
}

const shutdownLog: string[] = [];

class Database {
  onApplicationShutdown(signal?: string) {
    shutdownLog.push(`database:${signal ?? 'none'}`);
  }
}

class Cache {
  constructor(readonly database: Database) {}

  onApplicationShutdown() {
    shutdownLog.push('cache');
  }
}
setInjectableMetadata(Cache, { deps: [Database] });

class FeatureController {
  constructor(private readonly greeter: Greeter, private readonly cache: Cache) {}

  greet(context: RequestContext) {
    return context.json({ message: this.greeter.greet(), cached: this.cache instanceof Cache });
  }

  login(context: RequestContext) {
    context.setCookie('session', 'abc 123', { httpOnly: true, sameSite: 'Lax', maxAge: 3600 });
    context.setCookie('theme', 'dark');
    return { user: context.cookie('user') ?? null, all: context.cookies() };
  }

  logout(context: RequestContext) {
    context.deleteCookie('session');
    return context.noContent();
  }

  async upload(context: RequestContext) {
    const form = await context.form();
    const file = form.avatar as File;
    return { name: form.name, tags: form.tag, fileName: file.name, size: file.size, text: await file.text() };
  }

  events(context: RequestContext) {
    return context.sse(async (stream) => {
      stream.send({ event: 'greeting', id: '1', data: { hello: 'world' } });
      stream.send('plain\ntext');
    }, { keepAliveMs: 0 });
  }

  slow() {
    return Bun.sleep(150).then(() => ({ done: true }));
  }
}
setInjectableMetadata(FeatureController, { deps: [Greeter, Cache] });

const manifest: AppManifest = {
  routes: [
    route({ method: 'GET', fullPath: '/greet', controller: FeatureController, methodName: 'greet' }),
    route({ method: 'POST', fullPath: '/login', controller: FeatureController, methodName: 'login' }),
    route({ method: 'POST', fullPath: '/logout', controller: FeatureController, methodName: 'logout' }),
    route({ method: 'POST', fullPath: '/upload', controller: FeatureController, methodName: 'upload' }),
    route({ method: 'GET', fullPath: '/events', controller: FeatureController, methodName: 'events' }),
    route({ method: 'GET', fullPath: '/slow', controller: FeatureController, methodName: 'slow', parameters: [] }),
  ],
};

const definition = (extra: Partial<Parameters<typeof defineApplication>[0]> = {}) => defineApplication({
  modules: [defineModule({ providers: [Greeter, Database, Cache], controllers: [FeatureController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  ...extra,
});

describe('cookies', () => {
  test('parses and serializes cookies', () => {
    expect(parseCookies('a=1; b="two"; c=x%20y; a=ignored')).toEqual({ a: '1', b: 'two', c: 'x y' });
    expect(serializeCookie('s', 'a b', { httpOnly: true, sameSite: 'None', maxAge: 60 })).toBe('s=a%20b; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=None');
    expect(() => serializeCookie('bad name', 'x')).toThrow('Invalid cookie name');
    // Attribute values cannot inject attributes or split the header.
    expect(() => serializeCookie('a', 'v', { path: '/x; Domain=evil.example' })).toThrow('Invalid cookie path');
    expect(() => serializeCookie('a', 'v', { domain: 'example.com\r\nSet-Cookie: x=1' })).toThrow('Invalid cookie domain');
    expect(() => serializeCookie('a', 'v', { path: '' })).toThrow('Invalid cookie path');
    expect(() => serializeCookie('a', 'v', { sameSite: 'Lax; Secure' as never })).toThrow('Invalid cookie sameSite');
    expect(() => serializeCookie('a', 'v', { priority: 'High; x' as never })).toThrow('Invalid cookie priority');
    expect(serializeCookie('a', 'v', { path: '/app/v1', domain: '.example.com', priority: 'High' })).toBe('a=v; Domain=.example.com; Path=/app/v1; Priority=High');
  });

  test('reads request cookies and sets several response cookies', async () => {
    const app = createApp(definition(), manifest);
    const response = await app.fetch(new Request('http://x/login', { method: 'POST', headers: { cookie: 'user=ada; lang=ja' } }));
    expect(await response.json()).toEqual({ user: 'ada', all: { user: 'ada', lang: 'ja' } });
    expect(response.headers.getSetCookie()).toEqual([
      'session=abc%20123; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax',
      'theme=dark; Path=/',
    ]);
  });

  test('deletes cookies on no-content responses', async () => {
    const app = createApp(definition(), manifest);
    const response = await app.fetch(new Request('http://x/logout', { method: 'POST' }));
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()[0]).toStartWith('session=; Max-Age=0; Expires=Thu, 01 Jan 1970');
  });
});

describe('cors', () => {
  const app = createApp(definition({ cors: { origin: ['https://app.example'], credentials: true, exposeHeaders: ['x-request-id'], maxAge: 600 } }), manifest);

  test('adds CORS headers to route responses for allowed origins only', async () => {
    const allowed = await app.fetch(new Request('http://x/greet', { headers: { origin: 'https://app.example' } }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('access-control-expose-headers')).toBe('x-request-id');
    expect(allowed.headers.get('vary')).toContain('Origin');

    const denied = await app.fetch(new Request('http://x/greet', { headers: { origin: 'https://evil.example' } }));
    expect(denied.status).toBe(200);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('answers preflight requests with the methods the path serves', async () => {
    const response = await app.fetch(new Request('http://x/login', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type, authorization');
    expect(response.headers.get('access-control-max-age')).toBe('600');
  });

  test('keeps CORS headers on 404 so browsers can read the error', async () => {
    const response = await app.fetch(new Request('http://x/missing', { headers: { origin: 'https://app.example' } }));
    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
  });

  test('plain OPTIONS without CORS headers still gets the Allow list', async () => {
    const response = await app.fetch(new Request('http://x/login', { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('allow')).toContain('POST');
  });
});

describe('multipart forms', () => {
  test('parses fields, repeated fields and files', async () => {
    const app = createApp(definition(), manifest);
    const form = new FormData();
    form.append('name', 'Ada');
    form.append('tag', 'a');
    form.append('tag', 'b');
    form.append('avatar', new File(['image-bytes'], 'avatar.png', { type: 'image/png' }));
    const response = await app.fetch(new Request('http://x/upload', { method: 'POST', body: form }));
    expect(await response.json()).toEqual({ name: 'Ada', tags: ['a', 'b'], fileName: 'avatar.png', size: 11, text: 'image-bytes' });
  });
});

describe('server-sent events', () => {
  test('formats events', () => {
    expect(formatEvent({ event: 'tick', id: '7', retry: 1000, data: { n: 1 } })).toBe('event: tick\nid: 7\nretry: 1000\ndata: {"n":1}\n\n');
    expect(formatEvent({ data: 'a\nb' })).toBe('data: a\ndata: b\n\n');
  });

  test('streams events and closes when the handler finishes', async () => {
    const app = createApp(definition(), manifest);
    const response = await app.fetch(new Request('http://x/events'));
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await response.text()).toBe('event: greeting\nid: 1\ndata: {"hello":"world"}\n\ndata: plain\ndata: text\n\n');
  });
});

describe('websockets', () => {
  test('upgrades, rejects via upgrade(), and dispatches messages by route', async () => {
    const app = createApp(definition(), manifest);
    const server = app.listen({
      port: 0,
      hostname: '127.0.0.1',
      websockets: {
        '/rooms/:room': defineWebSocket({
          upgrade(request) {
            const user = new URL(request.url).searchParams.get('user');
            return user ? { user } : new Response('unauthorized', { status: 401 });
          },
          open(socket) {
            socket.send(`joined ${socket.data.params.room} as ${socket.data.data.user}`);
          },
          message(socket, message) {
            socket.send(`echo:${String(message)}`);
          },
        }),
      },
    });

    try {
      const rejected = await fetch(new URL('/rooms/lobby', server.url), { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
      expect(rejected.status).toBe(401);

      const messages: string[] = [];
      const socket = new WebSocket(`${server.url.href.replace('http', 'ws')}rooms/lobby?user=ada`);
      await new Promise<void>((resolve, reject) => {
        socket.onerror = () => reject(new Error('socket error'));
        socket.onmessage = (event) => {
          messages.push(String(event.data));
          if (messages.length === 1) {
            socket.send('hi');
          } else {
            resolve();
          }
        };
      });
      socket.close();
      expect(messages).toEqual(['joined lobby as ada', 'echo:hi']);

      expect((await fetch(new URL('/greet', server.url))).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  test('rejects websocket paths that collide with app routes', () => {
    const app = createApp(definition(), manifest);
    expect(() => app.listen({ port: 0, websockets: { '/greet': defineWebSocket({}) } })).toThrow('collides with an application route');
  });
});

describe('graceful shutdown', () => {
  test('waits for in-flight requests, then runs shutdown hooks newest first', async () => {
    shutdownLog.length = 0;
    const app = createApp(definition(), manifest);
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    const inFlight = fetch(new URL('/slow', server.url));
    await Bun.sleep(30);
    await app.close({ signal: 'SIGTERM' });
    expect((await inFlight).status).toBe(200);
    // Cache depends on Database, so Cache is created later and shut down first.
    expect(shutdownLog).toEqual(['cache', 'database:SIGTERM']);
    await app.close();
    expect(shutdownLog).toHaveLength(2);
  });
});

describe('createTestingApp', () => {
  test('overrides providers and calls routes in-process', async () => {
    const app = createTestingApp(definition(), {
      manifest,
      overrides: [{ provide: Greeter, useValue: { greet: () => 'stubbed' } }],
    });
    const response = await app.request('/greet');
    expect(await response.json()).toEqual({ message: 'stubbed', cached: true });

    const login = await app.request('/login', { method: 'POST', json: {} });
    expect(login.status).toBe(200);
    expect(app.get(Greeter).greet()).toBe('stubbed');
  });
});

describe('global enhancers on static routes', () => {
  class StaticController {
    ping() {
      return { pong: true };
    }
  }

  class DenyAllGuard {
    canActivateRaw() {
      return false;
    }

    canActivate() {
      return false;
    }
  }

  class StampMiddleware {
    async handle(_context: unknown, next: () => Promise<Response>) {
      const response = await next();
      response.headers.set('x-stamp', 'global');
      return response;
    }
  }

  const staticManifest: AppManifest = {
    routes: [{
      method: 'GET', fullPath: '/ping', controller: StaticController, methodName: 'ping',
      parameters: [], guards: [], middleware: [], filters: [],
      docs: { tags: [], security: [], responses: [] },
    }],
  };

  const build = (globals: { guards?: unknown[]; middleware?: unknown[] }, cors?: Parameters<typeof defineApplication>[0]['cors']) => createApp(defineApplication({
    modules: [defineModule({ providers: [DenyAllGuard, StampMiddleware], controllers: [StaticController], imports: [] })],
    schemaAdapter: createValibotAdapter(),
    globals: { guards: (globals.guards ?? []) as never[], middleware: (globals.middleware ?? []) as never[], filters: [] },
    ...(cors ? { cors } : {}),
  }), staticManifest);

  test('a global guard is enforced on a parameterless GET route (in-process and native routes)', async () => {
    const app = build({ guards: [DenyAllGuard] });
    expect((await app.fetch(new Request('http://x/ping'))).status).toBe(403);
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      expect((await fetch(new URL('/ping', server.url))).status).toBe(403);
    } finally {
      await app.close();
    }
  });

  test('global middleware and CORS run on a parameterless GET route', async () => {
    const app = build({ middleware: [StampMiddleware] }, { origin: '*' });
    const response = await app.fetch(new Request('http://x/ping', { headers: { origin: 'https://a.example' } }));
    expect(response.headers.get('x-stamp')).toBe('global');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('without any enhancer the route is still served as a precomputed static response', async () => {
    const app = build({});
    expect(await (await app.fetch(new Request('http://x/ping'))).json()).toEqual({ pong: true });
  });
});

describe('precomputed handler result under enhancers', () => {
  let calls = 0;
  class CountingController {
    status() {
      calls += 1;
      return { ok: true };
    }
  }
  class HeaderMiddleware {
    handleRaw(_request: Request, _params: Record<string, string>, state: { setResponseHeader(name: string, value: string): void }, next: () => Response | PromiseLike<Response>) {
      state.setResponseHeader('x-mw', 'raw');
      return next();
    }

    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      context.setResponseHeader('x-mw', 'context');
      return next();
    }
  }

  test('a static response is computed once and middleware still runs on every request', async () => {
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [HeaderMiddleware], controllers: [CountingController], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      globals: { guards: [], middleware: [HeaderMiddleware], filters: [] },
    }), {
      routes: [{
        method: 'GET', fullPath: '/status', controller: CountingController, methodName: 'status',
        parameters: [], guards: [], middleware: [], filters: [],
        docs: { tags: [], security: [], responses: [], staticResponse: true },
      }],
    });
    for (let index = 0; index < 3; index += 1) {
      const response = await app.fetch(new Request('http://x/status'));
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get('x-mw')).not.toBeNull();
    }
    expect(calls).toBe(1);
  });
});

describe('handlers are not frozen at startup unless declared static', () => {
  test('a parameterless GET handler reading mutable state answers fresh data on every request', async () => {
    const items: string[] = [];
    let calls = 0;
    class ListController {
      list() {
        calls += 1;
        return { items: [...items], at: calls };
      }
    }
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [ListController], imports: [] })],
      schemaAdapter: createValibotAdapter(),
    }), {
      routes: [{
        method: 'GET', fullPath: '/items', controller: ListController, methodName: 'list',
        parameters: [], guards: [], middleware: [], filters: [],
        docs: { tags: [], security: [], responses: [] },
      }],
    });
    expect(calls).toBe(0);
    expect(await (await app.fetch(new Request('http://x/items'))).json()).toEqual({ items: [], at: 1 });
    items.push('a');
    expect(await (await app.fetch(new Request('http://x/items'))).json()).toEqual({ items: ['a'], at: 2 });
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      items.push('b');
      expect(await (await fetch(new URL('/items', server.url))).json()).toEqual({ items: ['a', 'b'], at: 3 });
    } finally {
      await app.close();
    }
  });
});
