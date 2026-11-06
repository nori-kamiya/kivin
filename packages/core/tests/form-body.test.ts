import { createApp, defineApplication, defineModule, type AppManifest, type NestLikeMiddleware, type RequestContext, type ResponseState } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

type Route = AppManifest['routes'][number];
const route = (input: Pick<Route, 'method' | 'fullPath' | 'controller' | 'methodName'> & Partial<Route>): Route => ({
  parameters: [{ index: 0, source: 'input', fields: ['body'] }],
  guards: [],
  middleware: [],
  filters: [],
  docs: { tags: [], security: [], responses: [] },
  ...input,
});

const UploadSchema = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  avatar: v.file(),
  tags: v.optional(v.array(v.string())),
});

class UploadController {
  async upload({ body }: { body: v.InferOutput<typeof UploadSchema> }) {
    return { title: body.title, file: body.avatar.name, size: body.avatar.size, text: await body.avatar.text(), tags: body.tags ?? [] };
  }

  raw({ body }: { body: Record<string, unknown> }) {
    return { body };
  }

  async both({ body, context }: { body: Record<string, unknown>; context: RequestContext }) {
    const form = await context.form();
    return { body, form, same: (await context.formData()).get('a') };
  }

  json({ body }: { body: unknown }) {
    return { body };
  }
}

class StampMiddleware implements NestLikeMiddleware {
  handleRaw(_request: Request, _params: Record<string, string>, state: ResponseState, next: () => Response | PromiseLike<Response>) {
    state.setResponseHeader('x-stamp', '1');
    return next();
  }

  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    context.setResponseHeader('x-stamp', '1');
    return next();
  }
}

const routes: Route[] = [
  route({ method: 'POST', fullPath: '/upload', controller: UploadController, methodName: 'upload', docs: { tags: [], security: [], responses: [], bodySchema: UploadSchema, consumes: 'multipart/form-data' } }),
  route({ method: 'POST', fullPath: '/raw', controller: UploadController, methodName: 'raw', docs: { tags: [], security: [], responses: [], consumes: 'application/x-www-form-urlencoded' } }),
  route({ method: 'POST', fullPath: '/both', controller: UploadController, methodName: 'both', parameters: [{ index: 0, source: 'input', fields: ['body', 'context'] }], docs: { tags: [], security: [], responses: [], consumes: 'multipart/form-data' } }),
  route({ method: 'POST', fullPath: '/json', controller: UploadController, methodName: 'json' }),
];

function makeApp(globalMiddleware = false) {
  const module = defineModule({ providers: [StampMiddleware], controllers: [UploadController], imports: [] });
  return createApp(defineApplication({
    modules: [module],
    schemaAdapter: createValibotAdapter(),
    ...(globalMiddleware ? { globals: { guards: [], middleware: [StampMiddleware], filters: [] } } : {}),
  }), { routes });
}

function uploadForm() {
  const form = new FormData();
  form.append('title', 'Profile');
  form.append('avatar', new File(['hello'], 'me.txt', { type: 'text/plain' }));
  form.append('tags', 'a');
  form.append('tags', 'b');
  return form;
}

for (const globalMiddleware of [false, true]) {
  describe(`@Consumes form bodies${globalMiddleware ? ' (global middleware)' : ''}`, () => {
    const app = makeApp(globalMiddleware);

    test('multipart body is validated and passed with files and repeated fields', async () => {
      const response = await app.fetch(new Request('http://x/upload', { method: 'POST', body: uploadForm() }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ title: 'Profile', file: 'me.txt', size: 5, text: 'hello', tags: ['a', 'b'] });
      if (globalMiddleware) {
        expect(response.headers.get('x-stamp')).toBe('1');
      }
    });

    test('schema failures are 400 body validation errors', async () => {
      const form = new FormData();
      form.append('title', 'no file');
      const response = await app.fetch(new Request('http://x/upload', { method: 'POST', body: form }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { message: string }).message).toBe('body validation failed');
    });

    test('urlencoded bodies are parsed without a schema', async () => {
      const response = await app.fetch(new Request('http://x/raw', { method: 'POST', body: new URLSearchParams('a=1&b=x+y&a=2') }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: { a: ['1', '2'], b: 'x y' } });
    });

    test('a JSON request to a form route is 415', async () => {
      const response = await app.fetch(new Request('http://x/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title":"x"}' }));
      expect(response.status).toBe(415);
    });

    test('context.form() and context.formData() still work next to body', async () => {
      const form = new FormData();
      form.append('a', '1');
      const response = await app.fetch(new Request('http://x/both', { method: 'POST', body: form }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: { a: '1' }, form: { a: '1' }, same: '1' });
    });

    test('JSON routes are unchanged', async () => {
      const response = await app.fetch(new Request('http://x/json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }));
      expect(await response.json()).toEqual({ body: { a: 1 } });
    });
  });
}

test('form routes work over Bun native routes', async () => {
  const server = makeApp().listen({ port: 0, hostname: '127.0.0.1' });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/upload`, { method: 'POST', body: uploadForm() });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { text: string }).text).toBe('hello');
  } finally {
    await server.stop(true);
  }
});
