import { createApp, createToken, defineApplication, defineModule, RequestContext } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

class Counter {
  static created = 0;
  readonly id = ++Counter.created;
}

const CALLER = createToken<{ user: string }>('request-context.test.caller');

class Settings {
  readonly greeting = 'hello';
}

const buildApp = () => createApp(defineApplication({
  modules: [defineModule({
    providers: [
      Settings,
      { provide: Counter, scope: 'request', useClass: Counter },
      {
        provide: CALLER,
        scope: 'request',
        useFactory: (container) => ({ user: container.resolve(RequestContext).req.raw.headers.get('x-user') ?? 'anonymous' }),
      },
    ],
    controllers: [],
    imports: [],
  })],
  schemaAdapter: createValibotAdapter(),
}), { routes: [] });

describe('app.createRequestContext (DI for native routes and adapters)', () => {
  test('given two requests, when each resolves a request-scoped provider, then each gets its own instance', () => {
    const app = buildApp();
    const first = app.createRequestContext(new Request('http://x/a'));
    const second = app.createRequestContext(new Request('http://x/b'));

    expect(first.inject(Counter)).toBe(first.inject(Counter));
    expect(first.inject(Counter)).not.toBe(second.inject(Counter));
  });

  test('given a request-scoped factory that injects RequestContext, when resolved, then it sees that request', () => {
    const app = buildApp();
    const context = app.createRequestContext(new Request('http://x/', { headers: { 'x-user': 'alice' } }));

    expect(context.inject(CALLER)).toEqual({ user: 'alice' });
    expect(context.inject(RequestContext)).toBe(context);
    expect(context.req.param('id')).toBeUndefined();
  });

  test('given path params, when passed, then the context exposes them', () => {
    const app = buildApp();
    const context = app.createRequestContext(new Request('http://x/users/7'), { id: '7' });

    expect(context.req.param('id')).toBe('7');
  });

  test('given a singleton, when resolved from a request context, then it is the instance app.get returns', () => {
    const app = buildApp();
    const context = app.createRequestContext(new Request('http://x/'));

    expect(context.inject(Settings)).toBe(app.get(Settings));
  });
});
