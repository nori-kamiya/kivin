// Schema validation and lazy body / query / path payload loading.
import type { AppDefinition } from '../metadata';
import { readQueryObject } from '../request-url';
import type { CompiledBodyPayloadFromJsonLoaderResolver, CompiledBodyPayloadResolver, CompiledParamPayloadResolver, CompiledQueryPayloadResolver, DeferredPayloadLoader, DeferredPayloadLoaderFactory, ManifestRoute } from './types';
import { isPromiseLike, mapLoadedValue, rethrowJsonBodyError } from './utils';

export function validateOrThrow<TSchema>(
  schemaAdapter: AppDefinition<TSchema>['schemaAdapter'],
  schema: TSchema | undefined,
  input: unknown,
  label: string,
) {
  if (!schema) {
    return input;
  }

  const result = schemaAdapter.parse(schema, input);
  if (!result.success) {
    throw createValidationErrorResponse(label, result.issues);
  }

  return result.output;
}

export interface ValidationIssue {
  /** Location of the failing value, e.g. `['items', 0, 'name']` (empty for the whole value). */
  path: Array<string | number>;
  message: string;
}

/**
 * Validation issues as sent to clients: only `path` and `message`, the same for every schema
 * library. Raw library issues (valibot's carry `input` and the whole parent object for every path
 * step) would echo the request back — passwords included — and differ per adapter.
 */
export function toValidationIssues(issues: unknown): ValidationIssue[] {
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.map((issue) => {
    const record = (typeof issue === 'object' && issue !== null ? issue : {}) as { message?: unknown; path?: unknown };
    const path = Array.isArray(record.path)
      ? record.path.map((segment: unknown) => {
          const key = typeof segment === 'object' && segment !== null && 'key' in segment ? (segment as { key: unknown }).key : segment;
          return typeof key === 'number' ? key : String(key);
        })
      : [];
    return { path, message: typeof record.message === 'string' ? record.message : 'Invalid value' };
  });
}

/** A failed validation behind a 400 response, as the schema library reported it. Server-side only. */
export interface ValidationFailure {
  /** What failed: `body`, `query`, `params`, `headers` or `response`. */
  label: string;
  /** The schema library's own issues (valibot's carry `type`, `expected`, `requirement`…), unfiltered. */
  issues: readonly unknown[];
}

// Keyed by the response so only failing requests pay for it; the client still gets `toValidationIssues`.
const validationFailures = new WeakMap<Response, ValidationFailure>();

/**
 * The validation failure behind `response` (kivin's 400 for invalid input), for translating or
 * reshaping it in `afterResponse` or an exception filter. `undefined` for any other response.
 */
export function getValidationFailure(response: Response): ValidationFailure | undefined {
  return validationFailures.get(response);
}

export function createValidationErrorResponse(label: string, issues: unknown) {
  const response = Response.json({ message: `${label} validation failed`, issues: toValidationIssues(issues) }, { status: 400 });
  validationFailures.set(response, { label, issues: Array.isArray(issues) ? issues : [] });
  return response;
}

export function createSchemaValidator<TSchema>(
  definition: AppDefinition<TSchema>,
  schema: TSchema,
  label: string,
) {
  return (input: unknown) => {
    const result = definition.schemaAdapter.parse(schema, input);
    if (!result.success) {
      throw createValidationErrorResponse(label, result.issues);
    }

    return result.output;
  };
}

export function createParamPayloadResolver<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresParamObject: boolean,
): CompiledParamPayloadResolver {
  if (route.docs.paramSchema) {
    const validateParams = createSchemaValidator(definition, route.docs.paramSchema, 'params');
    return (params) => validateParams(params);
  }

  if (requiresParamObject) {
    return (params) => params;
  }

  return () => undefined;
}

export function createQueryPayloadResolver<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresQueryObject: boolean,
): CompiledQueryPayloadResolver {
  if (route.docs.querySchema) {
    const validateQuery = createSchemaValidator(definition, route.docs.querySchema, 'query');
    return (requestUrl) => validateQuery(readQueryObject(requestUrl) ?? {});
  }

  if (requiresQueryObject) {
    return (requestUrl) => readQueryObject(requestUrl);
  }

  return () => undefined;
}

export function createBodyPayloadResolver<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresBody: boolean,
): CompiledBodyPayloadResolver {
  if (!requiresBody || route.method === 'GET' || route.method === 'HEAD') {
    return () => undefined;
  }

  if (route.docs.bodySchema) {
    const bodySchema = route.docs.bodySchema;
    const validateBody = createSchemaValidator(definition, bodySchema, 'body');
    return (request) => request.json().then(validateBody, rethrowJsonBodyError);
  }

  return (request) => request.json().then(undefined, rethrowJsonBodyError);
}

export function createDeferredPayloadLoader<T>(load: () => Promise<T> | T, onResolved?: (value: T) => void): DeferredPayloadLoader<T> {
  let pending: Promise<T> | undefined;

  return () => {
    if (!pending) {
      const loaded = load();
      pending = isPromiseLike<T>(loaded)
        ? loaded.then((value) => {
            onResolved?.(value);
            return value;
          })
        : Promise.resolve((onResolved?.(loaded), loaded));
    }

    return pending;
  };
}

export function createDeferredMappedJsonPayloadLoader<T>(
  getJsonBody: () => Promise<unknown>,
  mapValue: (value: unknown) => T,
  onResolved?: (value: T) => void,
): DeferredPayloadLoader<T> {
  let pending: Promise<T> | undefined;

  return () => {
    if (!pending) {
      pending = getJsonBody().then((value) => {
        const mapped = mapValue(value);
        onResolved?.(mapped);
        return mapped;
      });
    }

    return pending;
  };
}

export function createBodyPayloadFromJsonLoaderResolver<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresBody: boolean,
): CompiledBodyPayloadFromJsonLoaderResolver {
  if (!requiresBody || route.method === 'GET' || route.method === 'HEAD') {
    return () => undefined;
  }

  if (route.docs.bodySchema) {
    const bodySchema = route.docs.bodySchema;
    const validateBody = createSchemaValidator(definition, bodySchema, 'body');
    return (getJsonBody) => mapLoadedValue(getJsonBody(), validateBody);
  }

  return (getJsonBody) => getJsonBody();
}

export function createBodyPayloadLoaderFactory<TSchema>(
  definition: AppDefinition<TSchema>,
  route: ManifestRoute<TSchema>,
  requiresBody: boolean,
): DeferredPayloadLoaderFactory<unknown> {
  if (!requiresBody || route.method === 'GET' || route.method === 'HEAD') {
    return (_getJsonBody, onResolved) => createDeferredPayloadLoader(() => undefined, onResolved);
  }

  if (route.docs.bodySchema) {
    const validateBody = createSchemaValidator(definition, route.docs.bodySchema, 'body');
    return (getJsonBody, onResolved) => createDeferredMappedJsonPayloadLoader(getJsonBody, validateBody, onResolved);
  }

  return (getJsonBody, onResolved) => createDeferredPayloadLoader(getJsonBody, onResolved);
}
