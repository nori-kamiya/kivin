import { createApp, defineApplication, defineModule, type AppManifest, type NestLikeMiddleware, type RequestContext, type ResponseState } from '@kivin/core';
import { createPrettyJsonMiddleware, stream, streamNdjson, streamText } from '@kivin/http';
import { describe, expect, spyOn, test } from 'bun:test';

const decoder = new TextDecoder();

describe('stream / streamText', () => {
  test('streamText: chunks arrive in order, text headers, closed when the handler returns', async () => {
    const response = streamText(async (out) => {
      await out.write('Hello');
      await out.sleep(1);
      await out.writeln(',');
      await out.write(new TextEncoder().encode('world'));
    });
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('Hello,\nworld');
  });

  test('stream: status / headers options and pipe()', async () => {
    const source = new Response('piped body').body!;
    const response = stream(async (out) => {
      await out.write('[');
      await out.pipe(source);
      await out.write(']');
    }, { status: 206, headers: { 'content-type': 'application/octet-stream', 'x-extra': '1' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('x-extra')).toBe('1');
    expect(await response.text()).toBe('[piped body]');
  });

  test('a client that goes away aborts the writer: onAbort runs, sleep wakes, writes become no-ops', async () => {
    let produced = 0;
    let abortedCalls = 0;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const response = stream(async (out) => {
      out.onAbort(() => {
        abortedCalls += 1;
      });
      while (!out.aborted) {
        await out.write(`chunk ${produced}\n`);
        produced += 1;
        await out.sleep(5_000);
      }
      await out.write('after abort');
      finished();
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('chunk 0\n');
    await reader.cancel();
    await done;
    expect(abortedCalls).toBe(1);
    expect(produced).toBe(1);
  });

  test('an abort signal (request.signal) aborts too', async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const response = stream(async (out) => {
      out.onAbort(() => {
        sawAbort = true;
      });
      await out.sleep(5_000);
    }, { signal: controller.signal });
    controller.abort();
    await response.text().catch(() => undefined);
    expect(sawAbort).toBe(true);
  });

  test('handler errors: onError can write a last chunk, the stream still closes; default logs', async () => {
    const response = streamText(async (out) => {
      await out.write('partial');
      throw new Error('boom');
    }, { onError: (error, out) => out.write(` [error: ${(error as Error).message}]`) });
    expect(await response.text()).toBe('partial [error: boom]');

    const log = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const silent = stream(() => {
        throw new Error('quiet');
      });
      expect(await silent.text()).toBe('');
      expect(log.mock.calls.some((call) => String(call[1]).includes('quiet'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

describe('streamNdjson', () => {
  test('from an async iterable and from a writer callback', async () => {
    async function* rows() {
      yield { id: 1 };
      yield { id: 2, name: 'b' };
    }
    const fromIterable = streamNdjson(rows());
    expect(fromIterable.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(await fromIterable.text()).toBe('{"id":1}\n{"id":2,"name":"b"}\n');

    const fromCallback = streamNdjson(async (lines) => {
      await lines.write('a');
      await lines.write([1, 2]);
    });
    expect(await fromCallback.text()).toBe('"a"\n[1,2]\n');
    expect(await streamNdjson([1, null]).text()).toBe('1\nnull\n');
  });
});

describe('createPrettyJsonMiddleware', () => {
  class HeaderMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      context.setResponseHeader('x-mw', '1');
      return next();
    }

    handleRaw(_request: Request, _params: Record<string, string>, state: ResponseState, next: () => Response | PromiseLike<Response>) {
      state.setResponseHeader('x-mw', '1');
      return next();
    }
  }

  class Routes {
    data() {
      return { a: 1, list: [1, 2] };
    }

    text() {
      return new Response('plain {"a":1}', { headers: { 'content-type': 'text/plain' } });
    }

    withContext({ context }: { context: RequestContext }) {
      return context.json({ ok: true }, { status: 201 });
    }
  }

  type Route = AppManifest['routes'][number];
  const route = (fullPath: string, methodName: string, fields?: Array<'context'>): Route => ({
    method: 'GET', fullPath, controller: Routes, methodName, parameters: fields ? [{ index: 0, source: 'input', fields }] : [],
    guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] },
  });
  const app = createApp(defineApplication({
    modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
    globals: { middleware: [createPrettyJsonMiddleware(), HeaderMiddleware] },
  }), { routes: [route('/data', 'data'), route('/text', 'text'), route('/ctx', 'withContext', ['context'])] });

  test('indents JSON only with ?pretty; status and headers are kept', async () => {
    const plain = await app.fetch(new Request('http://localhost/data'));
    expect(await plain.text()).toBe('{"a":1,"list":[1,2]}');
    const pretty = await app.fetch(new Request('http://localhost/data?pretty'));
    expect(await pretty.text()).toBe('{\n  "a": 1,\n  "list": [\n    1,\n    2\n  ]\n}');
    expect(pretty.headers.get('content-type')).toBe('application/json;charset=utf-8');
    expect(pretty.headers.get('x-mw')).toBe('1');

    const created = await app.fetch(new Request('http://localhost/ctx?pretty=1'));
    expect(created.status).toBe(201);
    expect(await created.text()).toBe('{\n  "ok": true\n}');
  });

  test('leaves non-JSON responses alone', async () => {
    expect(await (await app.fetch(new Request('http://localhost/text?pretty'))).text()).toBe('plain {"a":1}');
  });
});
