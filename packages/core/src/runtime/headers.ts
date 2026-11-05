// Request headers on the handler input (`find({ headers }: RouteInput<{ headers: typeof S }>)`),
// validated by `@UseHeaderSchema`.
//
// Only routes that read `headers` or declare a header schema are wrapped: the wrapper builds the
// header object (lower-case names), validates it before anything else runs (a failure is a 400 like
// other validation errors) and hands the result to the argument getters on the per-request params
// object under a non-enumerable symbol, so no executor signature changes and other routes pay nothing.
import type { AppDefinition } from '../metadata';
import { createValidationErrorResponse } from './payload';
import type { CompiledRoute, ManifestRoute } from './types';

const ROUTE_HEADERS = Symbol('kivin.routeHeaders');

/** Header names are lower-case (as `Headers` normalises them); repeated headers are comma-joined. */
export function readRequestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

/** The (validated) headers the wrapper stored for this request; `{}` for routes without it. */
export function getRouteHeaders(params: Record<string, string>): unknown {
  return (params as Record<PropertyKey, unknown>)[ROUTE_HEADERS] ?? {};
}

export function routeUsesHeaders<TSchema>(route: ManifestRoute<TSchema>) {
  // An input parameter without `fields` (not destructured) receives every field, headers included.
  return Boolean(route.docs.headerSchema)
    || route.parameters.some((parameter) => parameter.source === 'input' && (parameter.fields === undefined || parameter.fields.includes('headers')));
}

export function withRouteHeaders<TSchema>(compiled: CompiledRoute<TSchema>, definition: AppDefinition<TSchema>, route: ManifestRoute<TSchema>): CompiledRoute<TSchema> {
  const execute = compiled.execute;
  const schema = route.docs.headerSchema;
  // A precomputed static response would be served without running this wrapper (by `fetch` and by
  // Bun's native routes), so a header-validated route never exposes one.
  const { nativeStaticResponse: _static, ...rest } = compiled;
  return {
    ...rest,
    execute: (request, params) => {
      let value: unknown = readRequestHeaders(request);
      if (schema !== undefined) {
        const result = definition.schemaAdapter.parse(schema, value);
        if (!result.success) {
          return Promise.resolve(createValidationErrorResponse('headers', result.issues));
        }
        value = result.output;
      }
      // Exact routes share one frozen empty params object; give this request its own.
      const target = Object.isFrozen(params) ? { ...params } : params;
      Object.defineProperty(target, ROUTE_HEADERS, { value, configurable: true });
      return execute(request, target);
    },
  };
}
