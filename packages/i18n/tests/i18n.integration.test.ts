import { createApp, defineApplication, defineModule, forbidden, type AppManifest, type CanActivate, type ExceptionFilter, type RequestContext } from '@kivinjs/core';
import { createI18n, defineMessages, defineTranslation, fromAcceptLanguage, fromCookie, fromPathPrefix, fromQuery, type Translator } from '@kivinjs/i18n';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

const en = defineMessages({
  greeting: 'Hello, {name}',
  denied: 'You may not pass',
  validation: { tooShort: 'Must be at least {min} characters', failed: 'Invalid {label}' },
});
const ja = defineTranslation(en, {
  greeting: 'こんにちは、{name}さん',
  denied: '通れません',
  validation: { tooShort: '{min} 文字以上にしてください', failed: '{label} が不正です' },
});

const i18n = createI18n({
  messages: { en, ja },
  defaultLocale: 'en',
  detect: [fromPathPrefix(), fromQuery(), fromCookie(), fromAcceptLanguage()],
  validation: {
    issue: (issue, { t }) => {
      const raw = issue as { type?: string; requirement?: number };
      return raw.type === 'min_length' ? t('validation.tooShort', { min: raw.requirement ?? 0 }) : undefined;
    },
    message: (label, { t }) => t('validation.failed', { label }),
  },
});
type AppTranslator = Translator<typeof en, 'en' | 'ja'>;

class Greeter {
  constructor(private readonly translator: AppTranslator) {}

  greet(name: string) {
    return this.translator.t('greeting', { name });
  }
}

class DeniedFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (error instanceof Error && error.message === 'gate') {
      return Response.json({ message: i18n.translator(context.request).t('denied') }, { status: 403 });
    }
  }
}

class Gate implements CanActivate {
  canActivate(context: RequestContext) {
    if (context.request.headers.get('x-block') === 'guard') {
      throw forbidden(i18n.translator(context.request).t('denied'));
    }
    return true;
  }
}

const Signup = v.object({ name: v.pipe(v.string(), v.minLength(3)) });
const Versioned = v.object({ 'x-token': v.pipe(v.string(), v.minLength(8)) });

class Routes {
  hello({ context }: { context: RequestContext }) {
    return { message: context.inject(Greeter).greet('Ada'), locale: i18n.locale(context.request) };
  }

  signup({ body }: { body: unknown }) {
    return body;
  }

  versioned() {
    return { ok: true };
  }

  explode() {
    throw new Error('gate');
  }

  localized() {
    return new Response('fixed', { headers: { 'content-language': 'x-custom', vary: 'Origin' } });
  }
}

type Route = AppManifest['routes'][number];
const route = (input: Pick<Route, 'method' | 'fullPath' | 'methodName'> & Partial<Route>): Route => ({
  controller: Routes, parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] }, ...input,
});

const app = createApp(defineApplication({
  modules: [defineModule({
    providers: [i18n.provider, { provide: Greeter, scope: 'request', useFactory: (container) => new Greeter(container.resolve(i18n.token)) }, Gate, DeniedFilter],
    controllers: [Routes],
    imports: [],
  })],
  schemaAdapter: createValibotAdapter(),
  onRequest: [i18n.onRequest],
}), {
  routes: [
    route({ method: 'GET', fullPath: '/hello', methodName: 'hello', parameters: [{ index: 0, source: 'input', fields: ['context'] }], guards: [Gate] }),
    route({ method: 'POST', fullPath: '/signup', methodName: 'signup', parameters: [{ index: 0, source: 'input', fields: ['body'] }], docs: { tags: [], security: [], responses: [], bodySchema: Signup } }),
    route({ method: 'GET', fullPath: '/versioned', methodName: 'versioned', docs: { tags: [], security: [], responses: [], headerSchema: Versioned } }),
    route({ method: 'GET', fullPath: '/explode', methodName: 'explode', filters: [DeniedFilter] }),
    route({ method: 'GET', fullPath: '/localized', methodName: 'localized' }),
  ],
});

const get = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(`http://x${path}`, { headers }));

describe('i18n.onRequest with an app', () => {
  test('given Accept-Language, when a route answers, then the DI translator speaks it and the response says so', async () => {
    const response = await get('/hello', { 'accept-language': 'ja-JP, en;q=0.5' });

    expect(await response.json()).toEqual({ message: 'こんにちは、Adaさん', locale: 'ja' });
    expect(response.headers.get('content-language')).toBe('ja');
    expect(response.headers.get('vary')).toBe('Cookie, Accept-Language');
  });

  test('given no hint, when a route answers, then the default language answers', async () => {
    const response = await get('/hello');

    expect(await response.json()).toEqual({ message: 'Hello, Ada', locale: 'en' });
    expect(response.headers.get('content-language')).toBe('en');
  });

  test('given a language path prefix, when routed, then the prefix is stripped and wins over later detectors', async () => {
    const response = await get('/ja/hello?lang=en', { cookie: 'lang=en' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'こんにちは、Adaさん', locale: 'ja' });
  });

  test('given a query and a cookie, when both are present, then the earlier detector decides', async () => {
    expect(await (await get('/hello?lang=ja', { cookie: 'lang=en' })).json()).toMatchObject({ locale: 'ja' });
    expect(await (await get('/hello', { cookie: 'lang=ja', 'accept-language': 'en' })).json()).toMatchObject({ locale: 'ja' });
  });

  test('given an unsupported language, when detected, then it never reaches Content-Language', async () => {
    const response = await get('/hello?lang=%3Cscript%3E', { 'accept-language': 'de' });

    expect(response.headers.get('content-language')).toBe('en');
  });

  test('given invalid input, when the body fails validation, then the issues and the message are translated', async () => {
    const response = await app.fetch(new Request('http://x/ja/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"a"}' }));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-language')).toBe('ja');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ message: 'body が不正です', issues: [{ path: ['name'], message: '3 文字以上にしてください' }] });
  });

  test('given invalid headers, when validated before the route runs, then the issues are translated too', async () => {
    const response = await get('/versioned?lang=ja', { 'x-token': 'short' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: 'headers が不正です', issues: [{ path: ['x-token'], message: '8 文字以上にしてください' }] });
  });

  test('given a guard or an exception filter, when they translate, then they use the request language', async () => {
    const guarded = await get('/hello', { 'accept-language': 'ja', 'x-block': 'guard' });
    const filtered = await get('/explode?lang=ja');

    expect(guarded.status).toBe(403);
    expect(await guarded.json()).toEqual({ message: '通れません' });
    expect(guarded.headers.get('content-language')).toBe('ja');
    expect(filtered.status).toBe(403);
    expect(await filtered.json()).toEqual({ message: '通れません' });
    expect(filtered.headers.get('content-language')).toBe('ja');
  });

  test('given a handler that sets Content-Language and Vary, when answered, then its value stays and Vary is extended', async () => {
    const response = await get('/localized');

    expect(response.headers.get('content-language')).toBe('x-custom');
    expect(response.headers.get('vary')).toBe('Origin, Cookie, Accept-Language');
  });

  test('given a request no route matches, when answered, then it is a plain 404', async () => {
    const response = await get('/ja/missing');

    expect(response.status).toBe(404);
  });
});

describe('i18n without the hook', () => {
  test('given a bare request, when asked, then the language is detected lazily from it', () => {
    const request = new Request('http://x/ja/anything');

    expect(i18n.locale(request)).toBe('ja');
    expect(i18n.translator(request).t('denied')).toBe('通れません');
  });
});

describe('i18n.onRequest after another rewriting hook', () => {
  test('given an earlier hook rewrote the request, when the handler asks, then it gets the language the i18n hook detected', async () => {
    const stripVersion = (request: Request) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/v1/')) {
        return undefined;
      }
      url.pathname = url.pathname.slice(3);
      return new Request(url, request);
    };
    class Probe {
      probe({ context }: { context: RequestContext }) {
        return { locale: i18n.locale(context.request) };
      }
    }
    const chained = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Probe], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      onRequest: [stripVersion, i18n.onRequest],
    }), { routes: [{ method: 'GET', fullPath: '/probe', controller: Probe, methodName: 'probe', parameters: [{ index: 0, source: 'input', fields: ['context'] }], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } }] });

    const response = await chained.fetch(new Request('http://x/v1/ja/probe'));

    expect(await response.json()).toEqual({ locale: 'ja' });
    expect(response.headers.get('content-language')).toBe('ja');
  });
});
