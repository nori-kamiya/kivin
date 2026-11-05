// Turns handler results into `Response`s, including precomputed native static responses.
import type { ResponseState } from '../context';
import { HttpError } from '../http';
import type { AppDefinition } from '../metadata';
import { createJsonResponse, createJsonResponseCreated, createJsonResponseWithStatus, createNoContentResponse, isBinaryBody } from '../response';
import { createSchemaValidator } from './payload';
import { type ManifestRoute, RESPONSE_INIT_201, RESPONSE_INIT_204, type ResponseStateAdapter } from './types';
import { isPromiseLike } from './utils';

export function createResponseBodyMapper<TSchema>(definition: AppDefinition<TSchema>, route: ManifestRoute<TSchema>) {
  const successResponseSchema = route.docs.responses.find((response) => response.status >= 200 && response.status < 300 && response.schema)?.schema;
  if (!successResponseSchema) {
    return undefined;
  }

  return createSchemaValidator(definition, successResponseSchema, 'response');
}

export function getDefaultSuccessStatus<TSchema>(route: ManifestRoute<TSchema>) {
  const statuses = [...new Set(route.docs.responses
    .filter((response) => response.status >= 200 && response.status < 300)
    .map((response) => response.status))];

  return statuses.length === 1 ? statuses[0] : undefined;
}

export function mapUnknownToResponse(result: unknown, context: ResponseStateAdapter, defaultSuccessStatus?: number) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && (context.hasQueuedNoContentResponse() || defaultSuccessStatus === 204)) {
    return context.noContent();
  }

  return defaultSuccessStatus === undefined
    ? context.respond(result)
    : context.respond(result, { status: defaultSuccessStatus });
}

export function finalizeContextResult(
  result: unknown,
  context: ResponseStateAdapter,
  mapCompiledResponseBody: ((value: unknown) => unknown) | undefined,
  defaultSuccessStatus?: number,
) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && (context.hasQueuedNoContentResponse() || defaultSuccessStatus === 204)) {
    return context.noContent();
  }

  const validated = mapCompiledResponseBody ? mapCompiledResponseBody(result) : result;
  if (defaultSuccessStatus === 201) {
    return context.respondDefaultCreated(validated);
  }

  return defaultSuccessStatus === undefined
    ? context.respond(validated)
    : context.respond(validated, { status: defaultSuccessStatus });
}

export function finalizeResultWithoutContext(
  result: unknown,
  mapCompiledResponseBody: ((value: unknown) => unknown) | undefined,
  defaultSuccessStatus?: number,
) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && defaultSuccessStatus === 204) {
    return createNoContentResponse();
  }

  const validated = mapCompiledResponseBody ? mapCompiledResponseBody(result) : result;
  return defaultSuccessStatus === undefined
    ? createJsonResponse(validated)
    : createJsonResponseWithStatus(validated, defaultSuccessStatus);
}

export function getDefaultSuccessResponseInit(status: number | undefined): ResponseInit | undefined {
  if (status === undefined) {
    return undefined;
  }

  if (status === 201) {
    return RESPONSE_INIT_201;
  }

  if (status === 204) {
    return RESPONSE_INIT_204;
  }

  return { status };
}

export function finalizeDefaultCreatedContextResult(result: unknown, context: ResponseStateAdapter) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && context.hasQueuedNoContentResponse()) {
    return context.noContent();
  }

  return context.respondDefaultCreated(result);
}

export function finalizeDefaultCreatedRawResult(result: unknown, responseState: ResponseState) {
  if (result instanceof Response) {
    return result;
  }

  return responseState.respondDefaultCreated(result);
}

export function finalizeDefaultOkContextResult(result: unknown, context: ResponseStateAdapter) {
  if (result instanceof Response) {
    return result;
  }

  if (result === undefined && context.hasQueuedNoContentResponse()) {
    return context.noContent();
  }

  return context.respond(result);
}

export function finalizeDefaultOkRawResult(result: unknown, responseState: ResponseState) {
  if (result instanceof Response) {
    return result;
  }

  return responseState.respondDefaultOk(result);
}

export function finalizeDefaultCreatedPlainResult(result: unknown) {
  if (result instanceof Response) {
    return result;
  }

  return createJsonResponseCreated(result);
}

export function finalizeRawResult(
  result: Response | PromiseLike<Response> | unknown,
  responseState: ResponseStateAdapter,
  finalize: (value: unknown, context: ResponseStateAdapter) => Response,
) {
  if (isPromiseLike<unknown>(result)) {
    return result.then((resolved) => finalize(resolved, responseState));
  }

  return finalize(result, responseState);
}

export function createUnhandledErrorResponse() {
  return Response.json({ message: 'Internal Server Error' }, { status: 500 });
}

export function toHeadResponse(response: Response) {
  const headers = new Headers(response.headers);
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function canPrecomputeNativeStaticResponse<TSchema>(route: ManifestRoute<TSchema>) {
  if (route.method !== 'GET') {
    return false;
  }

  if (route.parameters.length > 0 || route.guards.length > 0 || route.middleware.length > 0 || route.filters.length > 0) {
    return false;
  }

  if (route.docs.bodySchema || route.docs.querySchema || route.docs.paramSchema) {
    return false;
  }

  return !route.docs.responses.some((response) => response.schema);
}

export function createNativeStaticResponse<TSchema>(input: {
  definition: AppDefinition<TSchema>;
  handler: (...args: unknown[]) => unknown;
  route: ManifestRoute<TSchema>;
  target: unknown;
}): Response | undefined {
  if (!canPrecomputeNativeStaticResponse(input.route)) {
    return undefined;
  }

  const mapResponseBody = createResponseBodyMapper(input.definition, input.route);

  try {
    const result = input.handler.apply(input.target, []);
    if (typeof (result as Promise<unknown> | undefined)?.then === 'function') {
      return undefined;
    }

    if (result instanceof Response) {
      return result.clone();
    }

    // Files and streams are read per request (the file may change; a stream can be read once).
    if (isBinaryBody(result)) {
      return undefined;
    }

    const validated = mapResponseBody ? mapResponseBody(result) : result;
    return createJsonResponse(validated);
  } catch {
    return undefined;
  }
}

export function handlePlainExecutionError(error: unknown) {
  if (error instanceof HttpError) {
    return error.toResponse();
  }

  if (error instanceof Response) {
    return error;
  }

  return createUnhandledErrorResponse();
}
