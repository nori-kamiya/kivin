import type { HeadersInput } from './http';

/** Same as `new Response(body)` accepts; `BodyInit` is a DOM-lib name. */
type ResponseBody = NonNullable<ConstructorParameters<typeof Response>[0]>;

/** The JSON content type kivin sends; it is exactly what Bun's native `Response.json()` writes. */
export const JSON_CONTENT_TYPE = 'application/json;charset=utf-8';
export const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';

const TEXT_HEADERS = Object.freeze({ 'content-type': TEXT_CONTENT_TYPE });
const NO_CONTENT_RESPONSE = new Response(null, { status: 204 });
const STATUS_201 = Object.freeze({ status: 201 });
/** Shared default for optional `init` parameters (never mutated): no `{}` allocation per call. */
export const EMPTY_RESPONSE_INIT: ResponseInit = Object.freeze({});

// JSON responses go through Bun's native `Response.json()`, which serialises and sets the content type
// in one step and is markedly faster than `new Response(JSON.stringify(data), { headers })`. It
// follows `JSON.stringify` semantics and throws the same TypeError for non-serialisable values.

/**
 * Handler results that are already a body (`Bun.file()`, `Blob`, `ReadableStream`, `ArrayBuffer`,
 * typed arrays) are sent as-is instead of being JSON-serialised (which would yield `{}`). Plain
 * objects and arrays are rejected on the prototype check first, so JSON results pay one comparison.
 */
export function isBinaryBody(value: unknown): value is Blob | ReadableStream | ArrayBuffer | ArrayBufferView {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === Array.prototype || prototype === null) {
    return false;
  }
  return value instanceof Blob || value instanceof ReadableStream || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * Response for a result that is not JSON: `undefined` (a handler that returns nothing) is an empty
 * body with the given status; a binary body keeps a Blob's own type (files: from the extension),
 * otherwise application/octet-stream.
 */
export function createBodyResponse(data: undefined | Blob | ReadableStream | ArrayBuffer | ArrayBufferView, init?: ResponseInit) {
  if (data === undefined) {
    return new Response(null, init);
  }
  const response = new Response(data as ResponseBody, init);
  if (!response.headers.has('content-type')) {
    response.headers.set('content-type', 'application/octet-stream');
  }
  return response;
}

function isHeaderRecord(headers: HeadersInput): headers is Record<string, string> {
  return !Array.isArray(headers) && !(headers instanceof Headers);
}

function mergeHeadersWithContentType(init: ResponseInit, contentType: string) {
  if (!init.headers) {
    return { ...init, headers: { 'content-type': contentType } };
  }

  if (isHeaderRecord(init.headers)) {
    return {
      ...init,
      headers: {
        ...init.headers,
        'content-type': contentType,
      },
    };
  }

  const headers = new Headers(init.headers);
  headers.set('content-type', contentType);
  return { ...init, headers };
}

export function createJsonResponse(data: unknown, init: ResponseInit = EMPTY_RESPONSE_INIT) {
  if (data === undefined || isBinaryBody(data)) {
    return createBodyResponse(data, init);
  }

  if (!init.headers && init.status === undefined && init.statusText === undefined) {
    return Response.json(data);
  }

  if (!init.headers && init.status !== undefined && init.statusText === undefined) {
    return Response.json(data, { status: init.status });
  }

  // As before, an explicit content-type in `init.headers` is replaced by the JSON one.
  return Response.json(data, mergeHeadersWithContentType(init, JSON_CONTENT_TYPE));
}

export function createJsonResponseWithStatus(data: unknown, status: number) {
  if (data === undefined || isBinaryBody(data)) {
    return createBodyResponse(data, { status });
  }

  return Response.json(data, { status });
}

export function createJsonResponseCreated(data: unknown) {
  if (data === undefined || isBinaryBody(data)) {
    return createBodyResponse(data, STATUS_201);
  }

  return Response.json(data, STATUS_201);
}

export function createJsonResponseWithHeader(data: unknown, headerName: string, headerValue: string) {
  if (data === undefined || isBinaryBody(data)) {
    return createBodyResponse(data, { headers: { [headerName]: headerValue } });
  }

  // Setting the header afterwards is ~25-35% cheaper in Bun than passing a headers init object
  // (no init dictionary conversion). A content-type override still wins, as it did via init.
  const response = Response.json(data);
  response.headers.set(headerName, headerValue);
  return response;
}

export function createJsonResponseWithStatusAndHeader(data: unknown, status: number, headerName: string, headerValue: string) {
  if (data === undefined || isBinaryBody(data)) {
    return createBodyResponse(data, { status, headers: { [headerName]: headerValue } });
  }

  return Response.json(data, { status, headers: { [headerName]: headerValue } });
}

export function createTextResponse(data: string, init: ResponseInit = EMPTY_RESPONSE_INIT) {
  if (!init.headers && init.status === undefined && init.statusText === undefined) {
    return new Response(data, { headers: TEXT_HEADERS });
  }

  if (!init.headers && init.status !== undefined && init.statusText === undefined) {
    return new Response(data, {
      status: init.status,
      headers: TEXT_HEADERS,
    });
  }

  return new Response(data, mergeHeadersWithContentType(init, TEXT_CONTENT_TYPE));
}

export function createNoContentResponse(init: ResponseInit = EMPTY_RESPONSE_INIT) {
  if (!init.headers && init.status === undefined && init.statusText === undefined) {
    return NO_CONTENT_RESPONSE.clone();
  }

  if (init.headers && isHeaderRecord(init.headers)) {
    const { ['content-type']: _ignored, ...headers } = init.headers;
    return new Response(null, {
      ...init,
      status: init.status ?? 204,
      headers,
    });
  }

  const headers = new Headers(init.headers);
  headers.delete('content-type');
  return new Response(null, {
    ...init,
    status: init.status ?? 204,
    headers,
  });
}

export function createNoContentResponseWithHeader(headerName: string, headerValue: string) {
  // Cloning the shared 204 and setting the header is ~25% cheaper in Bun than a headers init object.
  const response = NO_CONTENT_RESPONSE.clone();
  response.headers.set(headerName, headerValue);
  return response;
}