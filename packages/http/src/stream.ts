// Streaming response helpers (equivalent of Hono's `stream` / `streamText`, plus NDJSON).
type HeadersInput = NonNullable<ConstructorParameters<typeof Headers>[0]>;

const encoder = new TextEncoder();

export interface StreamWriter {
  /** Writes a chunk; resolves when the client has taken it (backpressure). No-op once aborted / closed. */
  write(chunk: string | Uint8Array): Promise<void>;
  /** Writes `text` followed by a newline. */
  writeln(text: string): Promise<void>;
  /** Resolves after `ms` milliseconds (or as soon as the stream is aborted). */
  sleep(ms: number): Promise<void>;
  /** Copies a readable stream into the response, then resolves. */
  pipe(body: ReadableStream<Uint8Array | string>): Promise<void>;
  /** Ends the response. Called automatically when the handler returns. */
  close(): Promise<void>;
  /** Runs `listener` when the client goes away (or `options.signal` aborts). */
  onAbort(listener: () => void): void;
  readonly aborted: boolean;
  readonly closed: boolean;
}

export interface StreamOptions {
  status?: number;
  headers?: HeadersInput;
  /**
   * Abort signal to watch besides the response stream itself; pass `request.signal` so a client that
   * disconnects while the handler is not writing is noticed too.
   */
  signal?: AbortSignal;
  /**
   * Called when the handler throws. The response has already started, so the status cannot change:
   * write a final chunk if useful. Default: log the error. The stream is closed afterwards either way.
   */
  onError?: (error: unknown, writer: StreamWriter) => void | Promise<void>;
}

function createStream(handler: (writer: StreamWriter) => void | Promise<void>, options: StreamOptions, defaultHeaders: Record<string, string>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const output = writable.getWriter();
  const listeners: Array<() => void> = [];
  const sleepers = new Set<() => void>();
  let aborted = false;
  let closed = false;

  const abort = () => {
    if (aborted) {
      return;
    }
    aborted = true;
    for (const wake of sleepers) {
      wake();
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.error('[kivin] Stream onAbort listener failed', error);
      }
    }
  };
  // The consumer cancelling the readable side (client disconnect) errors the writable side.
  output.closed.catch(abort);
  if (options.signal) {
    if (options.signal.aborted) {
      abort();
    } else {
      options.signal.addEventListener('abort', abort, { once: true });
    }
  }

  const writer: StreamWriter = {
    get aborted() {
      return aborted;
    },
    get closed() {
      return closed;
    },
    async write(chunk) {
      if (aborted || closed) {
        return;
      }
      try {
        await output.write(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      } catch {
        abort();
      }
    },
    writeln(text) {
      return writer.write(`${text}\n`);
    },
    sleep(ms) {
      if (aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          sleepers.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, ms);
        sleepers.add(wake);
      });
    },
    async pipe(body) {
      const reader = body.getReader();
      try {
        while (!aborted && !closed) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          await writer.write(value);
        }
      } finally {
        if (aborted || closed) {
          await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      options.signal?.removeEventListener('abort', abort);
      // Also after an abort: a signal-driven abort leaves the readable side open otherwise. When the
      // client already cancelled it, closing just fails quietly.
      await output.close().catch(() => undefined);
    },
    onAbort(listener) {
      listeners.push(listener);
    },
  };

  void (async () => {
    try {
      await handler(writer);
    } catch (error) {
      try {
        if (options.onError) {
          await options.onError(error, writer);
        } else {
          console.error('[kivin] Stream handler failed', error);
        }
      } catch (reportError) {
        console.error('[kivin] Stream onError failed', reportError);
      }
    } finally {
      await writer.close();
    }
  })();

  const headers = new Headers(defaultHeaders);
  for (const [name, value] of new Headers(options.headers)) {
    headers.set(name, value);
  }
  return new Response(readable, { status: options.status ?? 200, headers });
}

/**
 * Streams a response written by `handler` (binary or text chunks). Return it from a route; queued
 * headers and cookies are applied as usual.
 *
 * ```ts
 * download({ context }: RouteInput) {
 *   return stream(async (out) => {
 *     for await (const chunk of produce()) await out.write(chunk);
 *   }, { signal: context.request.signal, headers: { 'content-type': 'application/octet-stream' } });
 * }
 * ```
 */
export function stream(handler: (writer: StreamWriter) => void | Promise<void>, options: StreamOptions = {}): Response {
  return createStream(handler, options, {});
}

/** Like `stream`, as `text/plain; charset=utf-8` with `X-Content-Type-Options: nosniff` (so browsers render as it arrives). */
export function streamText(handler: (writer: StreamWriter) => void | Promise<void>, options: StreamOptions = {}): Response {
  return createStream(handler, options, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
}

export interface NdjsonWriter {
  /** Writes one value as a JSON line. */
  write(value: unknown): Promise<void>;
  sleep(ms: number): Promise<void>;
  onAbort(listener: () => void): void;
  readonly aborted: boolean;
}

/**
 * Newline-delimited JSON (`application/x-ndjson`): one `JSON.stringify` line per value, from an
 * (async) iterable or a writer callback. Iteration stops when the client disconnects.
 */
export function streamNdjson(source: Iterable<unknown> | AsyncIterable<unknown> | ((writer: NdjsonWriter) => void | Promise<void>), options: StreamOptions = {}): Response {
  return createStream(async (writer) => {
    const lines: NdjsonWriter = {
      get aborted() {
        return writer.aborted;
      },
      write: (value) => writer.write(`${JSON.stringify(value)}\n`),
      sleep: (ms) => writer.sleep(ms),
      onAbort: (listener) => writer.onAbort(listener),
    };
    if (typeof source === 'function') {
      await source(lines);
      return;
    }
    for await (const value of source as AsyncIterable<unknown>) {
      if (writer.aborted) {
        break;
      }
      await lines.write(value);
    }
  }, options, { 'content-type': 'application/x-ndjson; charset=utf-8' });
}
