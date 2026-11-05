import { createApp, defineApplication, defineModule, type AppManifest, type NestLikeMiddleware, type RequestContext, type ResponseState } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'kivin-binary-'));
const filePath = join(dir, 'report.csv');
await writeFile(filePath, 'a,b\n1,2\n');
afterAll(() => rm(dir, { recursive: true, force: true }));

class Files {
  file() {
    return Bun.file(filePath);
  }

  blob() {
    return new Blob(['hi'], { type: 'text/plain' });
  }

  untypedBlob() {
    return new Blob(['raw']);
  }

  stream() {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk-1;'));
        controller.enqueue(new TextEncoder().encode('chunk-2'));
        controller.close();
      },
    });
  }

  bytes() {
    return new Uint8Array([104, 105]);
  }

  buffer() {
    return new Uint8Array([111, 107]).buffer;
  }

  created({ context }: { context: RequestContext }) {
    context.setResponseHeader('x-kind', 'upload');
    return new Blob(['made'], { type: 'text/plain' });
  }

  plain() {
    return { list: [1, 2], nested: { ok: true } };
  }

  nothing() {
    return undefined;
  }

  async asyncNothing() {}

  nullProto() {
    const value = Object.create(null) as Record<string, number>;
    value.a = 1;
    return value;
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

type Route = AppManifest['routes'][number];
const route = (methodName: string, extra: Partial<Route> = {}): Route => ({
  method: 'GET',
  fullPath: `/${methodName}`,
  controller: Files,
  methodName,
  parameters: [],
  guards: [],
  middleware: [],
  filters: [],
  docs: { tags: [], security: [], responses: [] },
  ...extra,
});

const routes = [
  route('nothing'), route('asyncNothing'), route('nothing', { method: 'POST', docs: { tags: [], security: [], responses: [{ status: 201, description: 'created' }] } }),
  route('file'), route('blob'), route('untypedBlob'), route('stream'), route('bytes'), route('buffer'), route('plain'), route('nullProto'),
  route('created', { method: 'POST', parameters: [{ index: 0, source: 'input', fields: ['context'] }], docs: { tags: [], security: [], responses: [{ status: 201, description: 'created' }] } }),
];

for (const globalMiddleware of [false, true]) {
  describe(`binary handler results${globalMiddleware ? ' (global middleware)' : ''}`, () => {
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [StampMiddleware], controllers: [Files], imports: [] })],
      schemaAdapter: createValibotAdapter(),
      ...(globalMiddleware ? { globals: { guards: [], middleware: [StampMiddleware], filters: [] } } : {}),
    }), { routes });
    const get = (path: string, init?: RequestInit) => app.fetch(new Request(`http://x${path}`, init));

    test('Bun.file() is streamed with a type from its extension, fresh per request', async () => {
      const first = await get('/file');
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toStartWith('text/csv');
      expect(await first.text()).toBe('a,b\n1,2\n');
      await writeFile(filePath, 'a,b\n3,4\n');
      expect(await (await get('/file')).text()).toBe('a,b\n3,4\n');
      await writeFile(filePath, 'a,b\n1,2\n');
    });

    test('Blob keeps its type; untyped bodies are application/octet-stream', async () => {
      const blob = await get('/blob');
      expect(blob.headers.get('content-type')).toStartWith('text/plain');
      expect(await blob.text()).toBe('hi');
      for (const path of ['/untypedBlob', '/bytes', '/buffer', '/stream']) {
        expect((await get(path)).headers.get('content-type')).toBe('application/octet-stream');
      }
    });

    test('streams, typed arrays and ArrayBuffers are sent as bytes', async () => {
      expect(await (await get('/stream')).text()).toBe('chunk-1;chunk-2');
      expect(await (await get('/bytes')).text()).toBe('hi');
      expect(await (await get('/buffer')).text()).toBe('ok');
    });

    test('default status and queued headers still apply', async () => {
      const response = await get('/created', { method: 'POST' });
      expect(response.status).toBe(201);
      expect(response.headers.get('x-kind')).toBe('upload');
      expect(await response.text()).toBe('made');
      if (globalMiddleware) {
        expect(response.headers.get('x-stamp')).toBe('1');
      }
    });

    test('a handler that returns nothing answers an empty body with the default status (not 500)', async () => {
      for (const [path, method, status] of [['/nothing', 'GET', 200], ['/asyncNothing', 'GET', 200], ['/nothing', 'POST', 201]] as const) {
        const response = await get(path, { method });
        expect(response.status).toBe(status);
        expect(await response.text()).toBe('');
        expect(response.headers.get('content-type')).toBeNull();
      }
    });

    test('plain and null-prototype objects are still JSON', async () => {
      expect(await (await get('/plain')).json()).toEqual({ list: [1, 2], nested: { ok: true } });
      expect(await (await get('/nullProto')).json()).toEqual({ a: 1 });
    });
  });
}
