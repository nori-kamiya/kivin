import { afterResponse, createApp, defineApplication, defineModule, getValidationFailure, originalRequest, type AppManifest, type RequestHook } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

const Body = v.object({ name: v.pipe(v.string(), v.minLength(3)) });
const Query = v.object({ page: v.pipe(v.string(), v.regex(/^\d+$/)) });
const Headers = v.object({ 'x-version': v.picklist(['1', '2']) });

class Routes {
  create({ body }: { body: unknown }) {
    return body;
  }

  list({ query }: { query: unknown }) {
    return query;
  }

  versioned() {
    return { ok: true };
  }
}

type Route = AppManifest['routes'][number];
const route = (input: Pick<Route, 'method' | 'fullPath' | 'methodName'> & Partial<Route>): Route => ({
  controller: Routes, parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] }, ...input,
});
const routes: Route[] = [
  route({ method: 'POST', fullPath: '/items', methodName: 'create', parameters: [{ index: 0, source: 'input', fields: ['body'] }], docs: { tags: [], security: [], responses: [], bodySchema: Body } }),
  route({ method: 'GET', fullPath: '/items', methodName: 'list', parameters: [{ index: 0, source: 'input', fields: ['query'] }], docs: { tags: [], security: [], responses: [], querySchema: Query } }),
  route({ method: 'GET', fullPath: '/versioned', methodName: 'versioned', docs: { tags: [], security: [], responses: [], headerSchema: Headers } }),
];

const seen: Array<{ status: number; failure: ReturnType<typeof getValidationFailure> }> = [];
const observe: RequestHook = (request) => {
  afterResponse(request, (response) => {
    seen.push({ status: response.status, failure: getValidationFailure(response) });
  });
};
const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  onRequest: [observe],
}), { routes });

const lastSeen = () => seen.at(-1);

describe('getValidationFailure', () => {
  test('given an invalid body, when the final response is observed, then it carries the label and the raw schema issues', async () => {
    const response = await app.fetch(new Request('http://x/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"a"}' }));

    expect(response.status).toBe(400);
    expect(lastSeen()?.failure?.label).toBe('body');
    expect(lastSeen()?.failure?.issues).toEqual([expect.objectContaining({ type: 'min_length', requirement: 3 })]);
  });

  test('given an invalid query, when the final response is observed, then it carries the query issues', async () => {
    await app.fetch(new Request('http://x/items?page=x'));

    expect(lastSeen()?.failure?.label).toBe('query');
    expect(lastSeen()?.failure?.issues).toEqual([expect.objectContaining({ type: 'regex' })]);
  });

  test('given invalid headers, when the final response is observed, then it carries the header issues', async () => {
    await app.fetch(new Request('http://x/versioned', { headers: { 'x-version': '9' } }));

    expect(lastSeen()?.status).toBe(400);
    expect(lastSeen()?.failure?.label).toBe('headers');
    expect(lastSeen()?.failure?.issues).toEqual([expect.objectContaining({ type: 'picklist' })]);
  });

  test('given a valid request or another response, when asked, then there is no failure', async () => {
    await app.fetch(new Request('http://x/items?page=1'));

    expect(lastSeen()?.status).toBe(200);
    expect(lastSeen()?.failure).toBeUndefined();
    expect(getValidationFailure(Response.json({ message: 'body validation failed' }, { status: 400 }))).toBeUndefined();
  });

  test('given a validation failure, when the client reads it, then the raw issues are not in the body', async () => {
    const response = await app.fetch(new Request('http://x/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"ab"}' }));

    expect(await response.json()).toEqual({ message: 'body validation failed', issues: [{ path: ['name'], message: expect.any(String) }] });
  });
});

describe('originalRequest', () => {
  test('given an onRequest hook rewrites the request, when the handler side asks, then it maps back to the received request', async () => {
    let received: Request | undefined;
    let mapped: Request | undefined;
    const rewrite: RequestHook = (request) => {
      received = request;
      return new Request(new URL('/probe', request.url), request);
    };
    class Probe {
      probe({ context }: { context: { request: Request } }) {
        mapped = originalRequest(context.request);
        return { rewritten: context.request !== received };
      }
    }
    const probeApp = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Probe], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      onRequest: [rewrite],
    }), { routes: [{ method: 'GET', fullPath: '/probe', controller: Probe, methodName: 'probe', parameters: [{ index: 0, source: 'input', fields: ['context'] }], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } }] });

    const response = await probeApp.fetch(new Request('http://x/ja/probe'));

    expect(await response.json()).toEqual({ rewritten: true });
    expect(mapped).toBe(received!);
  });

  test('given a request kivin did not derive, when asked, then it is itself', () => {
    const request = new Request('http://x/');
    expect(originalRequest(request)).toBe(request);
  });
});
