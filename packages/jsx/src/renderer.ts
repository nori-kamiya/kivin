// Layouts for kivin routes (Hono's `jsxRenderer`): middleware records the layout for the request, and
// the handler returns `render(context, <Page />)`; layouts nest from the outermost middleware inward.
import { originalRequest, type NestLikeMiddleware, type RequestContext } from '@kivinjs/core';
import { jsx } from './jsx-runtime';
import { createContext, renderToReadableStream, renderToString, useContext } from './render';
import type { Child, Component } from './types';

export type Layout<P = Record<string, unknown>> = Component<P & { children?: Child }>;

export interface RendererOptions {
  /** Render to a stream (so `<Suspense>` content streams in after the page). Default false. */
  stream?: boolean;
  /** Written before the HTML: `true` (default) is `<!DOCTYPE html>`, `false` nothing, or a string of your own. */
  docType?: boolean | string;
  /** CSP nonce for the inline scripts streaming uses. */
  nonce?: string;
}

interface Registered {
  layout: Layout<any>;
  options: RendererOptions;
}

const layouts = new WeakMap<Request, Registered[]>();
const RequestContextValue = createContext<RequestContext | undefined>(undefined);

/**
 * The kivin `RequestContext` of the request being rendered by `render(context, …)`, e.g.
 * `useRequestContext().inject(UserService)`. Call it while a component renders.
 */
export function useRequestContext(): RequestContext {
  const context = useContext(RequestContextValue);
  if (!context) {
    throw new Error('@kivinjs/jsx: useRequestContext() needs render(context, …) with the route\'s RequestContext');
  }
  return context;
}

/**
 * Middleware that wraps pages `render`ed in this route with `layout` (`@UseMiddleware(...)`, module
 * or app middleware). Several renderers nest: the outer one wraps the inner one's output.
 */
export function createJsxRenderer<P = Record<string, unknown>>(layout: Layout<P>, options: RendererOptions = {}) {
  const register = (request: Request) => {
    const key = originalRequest(request);
    const list = layouts.get(key);
    if (list) {
      list.push({ layout, options });
    } else {
      layouts.set(key, [{ layout, options }]);
    }
  };
  return class JsxRendererMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      register(context.request);
      return next();
    }

    handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      register(request);
      return next();
    }
  };
}

export interface RenderOptions<P = Record<string, unknown>> extends RendererOptions {
  /** Props for the layouts besides `children` (a page title, …). */
  props?: P;
  status?: number;
  headers?: ConstructorParameters<typeof Headers>[0];
}

/**
 * An HTML response of `node` inside the route's layouts. Pass the route's `RequestContext` (or the
 * request) so layouts apply and components can `useRequestContext()`.
 */
export async function render<P = Record<string, unknown>>(target: RequestContext | Request, node: Child, options: RenderOptions<P> = {}): Promise<Response> {
  const request = target instanceof Request ? target : target.request;
  const stack = layouts.get(originalRequest(request)) ?? [];
  let tree: Child = node;
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    tree = jsx(stack[index]!.layout, { ...(options.props ?? {}), children: tree });
  }
  const context = target instanceof Request ? undefined : target;
  tree = jsx(RequestContextValue.Provider, { value: context, children: tree });

  // The innermost renderer's settings win, then this call's.
  const settings: RendererOptions = Object.assign({}, ...stack.map((entry) => entry.options), options);
  const docType = settings.docType === false ? '' : typeof settings.docType === 'string' ? settings.docType : '<!DOCTYPE html>';
  const headers = new Headers(options.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8');
  }
  const init = { status: options.status ?? 200, headers };
  if (settings.stream) {
    return new Response(await renderToReadableStream(tree, { prefix: docType, ...(settings.nonce === undefined ? {} : { nonce: settings.nonce }) }), init);
  }
  return new Response(docType + (await renderToString(tree)), init);
}
