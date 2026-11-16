// Lookup of the native routes passed to `listen({ routes })`, for requests an `onRequest` hook
// rewrote: Bun routed the received request, so kivin routes the rewritten one with Bun's rules
// (exact path, then `:param` segments, then a trailing `/*`, longest prefix first).
import { safeDecodeURIComponent } from './router';

type NativeHandler = (request: Request, server: unknown) => Response | Promise<Response>;

export interface NativeRouteMatch {
  handler: NativeHandler;
  /** Whether the path matched exactly (beats every application route, as in Bun). */
  exact: boolean;
}

interface PatternRoute {
  segments: string[];
  wildcard: boolean;
  definition: unknown;
}

const METHOD_KEYS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function handlerFor(definition: unknown, method: string, params: Record<string, string> | undefined): NativeHandler | undefined {
  if (definition instanceof Response) {
    return () => definition.clone();
  }
  if (typeof definition === 'function') {
    const handler = definition as NativeHandler;
    return params ? (request, server) => handler(withParams(request, params), server) : handler;
  }
  if (definition && typeof definition === 'object' && Object.keys(definition).every((key) => METHOD_KEYS.has(key))) {
    const methods = definition as Record<string, unknown>;
    return handlerFor(methods[method] ?? (method === 'HEAD' ? methods.GET : undefined), method, params);
  }
  // Anything else (an HTML bundle) is only served by Bun itself.
  return undefined;
}

function withParams(request: Request, params: Record<string, string>) {
  // Bun's route handlers read `request.params`; a rewritten Request has none of its own.
  Object.defineProperty(request, 'params', { value: params, configurable: true });
  return request;
}

export function createNativeRouteMatcher(routes: Record<string, unknown>) {
  const exact = new Map<string, unknown>();
  const patterns: PatternRoute[] = [];
  for (const [path, definition] of Object.entries(routes)) {
    const wildcard = path.endsWith('/*');
    if (!wildcard && !path.includes('/:')) {
      exact.set(path, definition);
      continue;
    }
    patterns.push({ segments: (wildcard ? path.slice(0, -2) : path).split('/').filter(Boolean), wildcard, definition });
  }
  // Param routes before wildcards; among wildcards, the longest prefix first.
  patterns.sort((left, right) => Number(left.wildcard) - Number(right.wildcard) || right.segments.length - left.segments.length);

  return (request: Request, pathname: string): NativeRouteMatch | undefined => {
    const exactDefinition = exact.get(pathname);
    if (exactDefinition !== undefined) {
      const handler = handlerFor(exactDefinition, request.method, undefined);
      return handler ? { handler, exact: true } : undefined;
    }
    const parts = pathname.split('/').filter(Boolean);
    for (const route of patterns) {
      if (route.wildcard ? parts.length < route.segments.length || (parts.length === route.segments.length && !pathname.endsWith('/')) : parts.length !== route.segments.length) {
        continue;
      }
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index]!;
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = safeDecodeURIComponent(parts[index]!);
        } else if (segment !== parts[index]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        const handler = handlerFor(route.definition, request.method, route.wildcard ? undefined : params);
        if (handler) {
          return { handler, exact: false };
        }
      }
    }
    return undefined;
  };
}
