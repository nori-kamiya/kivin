export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
export const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';

const JSON_HEADERS = Object.freeze({ 'content-type': JSON_CONTENT_TYPE });
const TEXT_HEADERS = Object.freeze({ 'content-type': TEXT_CONTENT_TYPE });
const NO_CONTENT_RESPONSE = new Response(null, { status: 204 });
const JSON_RESPONSE_INIT_201 = Object.freeze({ status: 201, headers: JSON_HEADERS });

function serializeJson(data: unknown) {
  const serialized = JSON.stringify(data);
  if (serialized === undefined) {
    throw new TypeError('Value is not JSON serializable');
  }

  return serialized;
}

function isHeaderRecord(headers: HeadersInit): headers is Record<string, string> {
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

export function createJsonResponse(data: unknown, init: ResponseInit = {}) {
  const serialized = serializeJson(data);

  if (!init.headers && init.status === undefined && init.statusText === undefined) {
    return new Response(serialized, { headers: JSON_HEADERS });
  }

  if (!init.headers && init.status !== undefined && init.statusText === undefined) {
    return new Response(serialized, {
      status: init.status,
      headers: JSON_HEADERS,
    });
  }

  return new Response(serialized, mergeHeadersWithContentType(init, JSON_CONTENT_TYPE));
}

export function createJsonResponseWithStatus(data: unknown, status: number) {
  return new Response(serializeJson(data), {
    status,
    headers: JSON_HEADERS,
  });
}

export function createJsonResponseCreated(data: unknown) {
  return new Response(serializeJson(data), JSON_RESPONSE_INIT_201);
}

export function createJsonResponseWithHeader(data: unknown, headerName: string, headerValue: string) {
  return new Response(serializeJson(data), {
    headers: {
      'content-type': JSON_CONTENT_TYPE,
      [headerName]: headerValue,
    },
  });
}

export function createJsonResponseWithStatusAndHeader(data: unknown, status: number, headerName: string, headerValue: string) {
  return new Response(serializeJson(data), {
    status,
    headers: {
      'content-type': JSON_CONTENT_TYPE,
      [headerName]: headerValue,
    },
  });
}

export function createTextResponse(data: string, init: ResponseInit = {}) {
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

export function createNoContentResponse(init: ResponseInit = {}) {
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
  return new Response(null, {
    status: 204,
    headers: {
      [headerName]: headerValue,
    },
  });
}