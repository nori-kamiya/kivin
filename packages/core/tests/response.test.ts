import { expect, test } from 'bun:test';
import {
  JSON_CONTENT_TYPE,
  ResponseState,
  createJsonResponse,
  createJsonResponseCreated,
  createJsonResponseWithHeader,
  createJsonResponseWithStatus,
  createJsonResponseWithStatusAndHeader,
  createNoContentResponse,
} from '../src';

test('createJsonResponse preserves default JSON content type', async () => {
  const response = createJsonResponse({ ok: true });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(await response.json()).toEqual({ ok: true });
});

test('createJsonResponse preserves explicit success status', async () => {
  const response = createJsonResponse({ created: true }, { status: 201 });

  expect(response.status).toBe(201);
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(await response.json()).toEqual({ created: true });
});

test('createJsonResponseWithStatus preserves explicit success status', async () => {
  const response = createJsonResponseWithStatus({ created: true }, 201);

  expect(response.status).toBe(201);
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(await response.json()).toEqual({ created: true });
});

test('createJsonResponseCreated preserves created status', async () => {
  const response = createJsonResponseCreated({ created: true });

  expect(response.status).toBe(201);
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(await response.json()).toEqual({ created: true });
});

test('createJsonResponseWithHeader preserves a single queued header', async () => {
  const response = createJsonResponseWithHeader({ ok: true }, 'x-request-id', 'req-1');

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(response.headers.get('x-request-id')).toBe('req-1');
  expect(await response.json()).toEqual({ ok: true });
});

test('createJsonResponseWithStatusAndHeader preserves status and header together', async () => {
  const response = createJsonResponseWithStatusAndHeader({ created: true }, 201, 'x-request-id', 'req-2');

  expect(response.status).toBe(201);
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(response.headers.get('x-request-id')).toBe('req-2');
  expect(await response.json()).toEqual({ created: true });
});

test('createJsonResponse throws for undefined like Response.json', () => {
  expect(() => createJsonResponse(undefined)).toThrow('Value is not JSON serializable');
});

test('ResponseState respond uses direct JSON fast path when no response state is queued', async () => {
  const response = new ResponseState().respond({ ok: true }, { status: 201 });

  expect(response.status).toBe(201);
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(await response.json()).toEqual({ ok: true });
});

test('ResponseState respond preserves multiple queued headers when status is explicit', async () => {
  const state = new ResponseState();
  state.setResponseHeader('x-request-id', 'req-4');
  state.setResponseHeader('x-raw-trace', 'trace-4');

  const response = state.respond({ ok: true }, { status: 200 });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(response.headers.get('x-request-id')).toBe('req-4');
  expect(response.headers.get('x-raw-trace')).toBe('trace-4');
  expect(await response.json()).toEqual({ ok: true });
});

test('ResponseState noContent uses direct no-content fast path when no response state is queued', async () => {
  const response = new ResponseState().noContent();
  const expected = createNoContentResponse();

  expect(response.status).toBe(expected.status);
  expect(response.headers.get('content-type')).toBeNull();
  expect(await response.text()).toBe('');
});

test('ResponseState applyResponseHeaders applies a single queued header directly', () => {
  const state = new ResponseState();
  state.setResponseHeader('x-request-id', 'req-1');

  const response = state.applyResponseHeaders(new Response(null, { status: 204 }));

  expect(response.headers.get('x-request-id')).toBe('req-1');
  expect(state.hasQueuedResponseState()).toBe(false);
});

test('ResponseState respondDefaultCreated applies single queued header directly', async () => {
  const state = new ResponseState();
  state.setResponseHeader('x-request-id', 'req-2');

  const response = state.respondDefaultCreated({ ok: true });

  expect(response.status).toBe(201);
  expect(response.headers.get('x-request-id')).toBe('req-2');
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(await response.json()).toEqual({ ok: true });
});

test('ResponseState respondDefaultOk applies single queued header directly', async () => {
  const state = new ResponseState();
  state.setResponseHeader('x-request-id', 'req-3');

  const response = state.respondDefaultOk({ ok: true });

  expect(response.status).toBe(200);
  expect(response.headers.get('x-request-id')).toBe('req-3');
  expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE);
  expect(await response.json()).toEqual({ ok: true });
});