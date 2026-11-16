import { HttpError } from '@kivinjs/core';
import { createTrpcRoutes, toTRPCError } from '@kivinjs/trpc';
import { initTRPC } from '@trpc/server';
import { describe, expect, test } from 'bun:test';

const t = initTRPC.create();
const router = t.router({ ping: t.procedure.query(() => 'pong') });

describe('createTrpcRoutes', () => {
  test('given no endpoint, when routes are built, then they mount under /trpc/*', () => {
    expect(Object.keys(createTrpcRoutes(router))).toEqual(['/trpc/*']);
  });

  test('given an endpoint with a trailing slash, when routes are built, then it is normalised', () => {
    expect(Object.keys(createTrpcRoutes(router, { endpoint: '/api/trpc/' }))).toEqual(['/api/trpc/*']);
  });

  test('given an endpoint without a leading slash, when routes are built, then it throws', () => {
    expect(() => createTrpcRoutes(router, { endpoint: 'trpc' })).toThrow(TypeError);
  });

  test('given createContext asks for the request context without app, when called, then it explains what to pass', async () => {
    const routes = createTrpcRoutes(router, { createContext: ({ requestContext }) => (requestContext(), {}) });
    const response = await routes['/trpc/*']!.GET(new Request('http://x/trpc/ping'));

    expect(response.status).toBe(500);
  });
});

describe('toTRPCError', () => {
  test.each([
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [422, 'UNPROCESSABLE_CONTENT'],
    [429, 'TOO_MANY_REQUESTS'],
    [503, 'SERVICE_UNAVAILABLE'],
  ] as const)('given an HttpError with status %i, when converted, then the code is %s', (status, code) => {
    const error = toTRPCError(new HttpError(status, 'message'));

    expect(error.code).toBe(code);
    expect(error.message).toBe('message');
  });

  test('given a status tRPC has no code for, when converted, then it falls back by class', () => {
    expect(toTRPCError(new HttpError(418, 'teapot')).code).toBe('BAD_REQUEST');
    expect(toTRPCError(new HttpError(507, 'full')).code).toBe('INTERNAL_SERVER_ERROR');
  });
});
