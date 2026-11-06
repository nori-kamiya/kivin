import { createApp, defineApplication, defineModule, type AppManifest } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';

class Routes {
  echo({ body }: { body: unknown }) {
    return { received: body };
  }

  size({ body }: { body: Record<string, unknown> }) {
    return { fields: Object.keys(body) };
  }

  health() {
    return { ok: true };
  }
}

type Route = AppManifest['routes'][number];
const route = (method: Route['method'], fullPath: string, methodName: string, docs: Partial<Route['docs']> = {}): Route => ({
  method, fullPath, controller: Routes, methodName, parameters: methodName === 'health' ? [] : [{ index: 0, source: 'input', fields: ['body'] }],
  guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [], ...docs },
});

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
  bodyLimit: 64,
}), {
  routes: [
    route('POST', '/small', 'echo'),
    route('POST', '/large', 'echo', { bodyLimit: 4096 }),
    route('POST', '/form', 'size', { bodyLimit: 512, consumes: 'multipart/form-data' }),
    route('GET', '/health', 'health'),
  ],
});

const json = (size: number) => JSON.stringify({ data: 'x'.repeat(size) });
/** A body without Content-Length (chunked transfer). */
const chunked = (text: string) => new ReadableStream<Uint8Array>({
  start(controller) {
    const bytes = new TextEncoder().encode(text);
    for (let index = 0; index < bytes.length; index += 16) {
      controller.enqueue(bytes.slice(index, index + 16));
    }
    controller.close();
  },
});
const post = (path: string, body: BodyInit) => app.fetch(new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' } as RequestInit));

describe('body limits', () => {
  test('a declared length over the app default is 413 before reading', async () => {
    const response = await post('/small', json(100));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ message: 'Payload Too Large', limit: 64 });
    expect((await post('/small', json(10))).status).toBe(200);
  });

  test('chunked bodies are counted while reading and passed on when within the limit', async () => {
    expect((await post('/small', chunked(json(100)))).status).toBe(413);
    const ok = await post('/small', chunked(json(10)));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: { data: 'x'.repeat(10) } });
  });

  test('@BodyLimit overrides the app default', async () => {
    expect((await post('/large', json(1000))).status).toBe(200);
    expect((await post('/large', json(5000))).status).toBe(413);
  });

  test('multipart bodies are limited too', async () => {
    const small = new FormData();
    small.append('a', '1');
    expect((await app.fetch(new Request('http://x/form', { method: 'POST', body: small }))).status).toBe(200);
    const big = new FormData();
    big.append('file', new File([new Uint8Array(2048)], 'big.bin'));
    expect((await app.fetch(new Request('http://x/form', { method: 'POST', body: big }))).status).toBe(413);
  });

  test('GET routes are not wrapped (static responses stay precomputed)', async () => {
    expect((await app.fetch(new Request('http://x/health'))).status).toBe(200);
  });

  test('over HTTP, including chunked uploads', async () => {
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${url}/small`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(100) })).status).toBe(413);
      expect((await fetch(`${url}/small`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chunked(json(100)), duplex: 'half' } as RequestInit)).status).toBe(413);
      expect((await fetch(`${url}/small`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chunked(json(10)), duplex: 'half' } as RequestInit)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  test('invalid limits are rejected at startup', () => {
    expect(() => createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
      schemaAdapter: createValibotAdapter(),
    }), { routes: [route('POST', '/x', 'echo', { bodyLimit: -1 })] })).toThrow('Invalid body limit');
  });
});
