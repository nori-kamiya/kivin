/** @jsxImportSource @kivinjs/jsx */
import { createApp, defineApplication, defineModule, type AppManifest, type RequestContext } from '@kivinjs/core';
import { createJsxRenderer, render, renderToString, Suspense, useRequestContext, type Child } from '@kivinjs/jsx';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';

class Visitor {
  static created = 0;
  readonly id = ++Visitor.created;
}

const Shell = createJsxRenderer<{ title?: string }>(({ title, children }) => (
  <html lang="en"><head><title>{title ?? 'kivin'}</title></head><body>{children}</body></html>
));
const Section = createJsxRenderer(({ children }) => <section class="admin">{children}</section>);
const Streaming = createJsxRenderer(({ children }) => <body>{children}</body>, { stream: true, docType: false, nonce: 'abc' });

const WhoAmI = () => {
  const context = useRequestContext();
  return <p>visitor {context.inject(Visitor).id} on {new URL(context.request.url).pathname}</p>;
};

class Pages {
  home({ context }: { context: RequestContext }) {
    return render(context, <h1>Home</h1>, { props: { title: 'Welcome' } });
  }

  admin({ context }: { context: RequestContext }) {
    return render(context, <><WhoAmI /><WhoAmI /></>, { status: 201, headers: { 'x-page': 'admin' } });
  }

  streamed({ context }: { context: RequestContext }) {
    const Slow = async () => {
      await Bun.sleep(10);
      return <p>late</p>;
    };
    return render(context, <Suspense fallback={<p>wait</p>}><Slow /></Suspense>);
  }

  bare({ context }: { context: RequestContext }) {
    return render(context.request, <p>bare</p>);
  }
}

type Route = AppManifest['routes'][number];
const route = (methodName: string, middleware: Route['middleware']): Route => ({
  method: 'GET', fullPath: `/${methodName}`, controller: Pages, methodName, parameters: [{ index: 0, source: 'input', fields: ['context'] }], guards: [], middleware, filters: [],
  docs: { tags: [], security: [], responses: [] },
});

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [{ provide: Visitor, scope: 'request', useClass: Visitor }, Shell, Section, Streaming], controllers: [Pages], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), { routes: [route('home', [Shell]), route('admin', [Shell, Section]), route('streamed', [Streaming]), route('bare', [])] });

const get = (path: string) => app.fetch(new Request(`http://x${path}`));

describe('render with createJsxRenderer', () => {
  test('given a layout, when a page renders, then it is wrapped with the doctype and gets the layout props', async () => {
    const response = await get('/home');

    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('<!DOCTYPE html><html lang="en"><head><title>Welcome</title></head><body><h1>Home</h1></body></html>');
  });

  test('given nested renderers, when a page renders, then the outer layout wraps the inner one and components reach the request scope', async () => {
    const response = await get('/admin');
    const html = await response.text();

    expect(response.status).toBe(201);
    expect(response.headers.get('x-page')).toBe('admin');
    expect(html).toMatch(/^<!DOCTYPE html><html lang="en"><head><title>kivin<\/title><\/head><body><section class="admin"><p>visitor (\d+) on \/admin<\/p><p>visitor \1 on \/admin<\/p><\/section><\/body><\/html>$/);
  });

  test('given a streaming renderer, when a page has a Suspense boundary, then the response streams the fallback then the content', async () => {
    const html = await (await get('/streamed')).text();

    expect(html).toStartWith('<body><template id="ks:0"></template><p>wait</p><!--/ks:0--></body><template data-ks="0"><p>late</p></template><script nonce="abc">');
  });

  test('given no renderer and a bare request, when rendered, then there is no layout and useRequestContext is unavailable', async () => {
    expect(await (await get('/bare')).text()).toBe('<!DOCTYPE html><p>bare</p>');
    await expect(render(new Request('http://x/'), <WhoAmI />)).rejects.toThrow(/needs render\(context/);
  });
});

describe('JSX types', () => {
  test('given the intrinsic element types, when misused, then they do not compile', async () => {
    // @ts-expect-error unknown element
    void (<blink />);
    // @ts-expect-error boolean attribute takes a boolean
    void (<input disabled="yes" />);
    // @ts-expect-error unknown attribute
    void (<div hreff="/" />);
    // @ts-expect-error a component's props are checked
    void (<WhoAmI extra />);
    const Async = async ({ n }: { n: number }): Promise<Child> => <b>{n}</b>;
    // @ts-expect-error async component props are checked
    void (<Async n="1" />);

    expect(await renderToString(<><my-widget anything="ok" /><Async n={1} /><svg viewBox="0 0 1 1"><path d="M0 0" /></svg></>))
      .toBe('<my-widget anything="ok"></my-widget><b>1</b><svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>');
  });
});
