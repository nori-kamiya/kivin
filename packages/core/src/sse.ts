// Server-Sent Events (text/event-stream) responses.
import type { HeadersInput } from './http';

export interface ServerSentEvent {
  /** JSON-serialized unless it is already a string. */
  data: unknown;
  event?: string;
  id?: string;
  /** Reconnection delay hint for the client, in milliseconds. */
  retry?: number;
}

export interface EventStream {
  /** Sends one event. Throws if the stream has already closed. */
  send(event: ServerSentEvent | string): void;
  /** Sends a comment line (ignored by clients; useful as a heartbeat). */
  comment(text: string): void;
  close(): void;
  /** Aborted when the client disconnects or the stream is closed. */
  readonly signal: AbortSignal;
  readonly closed: boolean;
}

export type EventStreamHandler = (stream: EventStream) => void | Promise<void>;

export interface EventStreamOptions {
  /** Interval of keep-alive comments in ms, so proxies do not drop idle streams. `0` disables. Default 15000. */
  keepAliveMs?: number;
  headers?: HeadersInput;
}

const encoder = new TextEncoder();

/**
 * Creates a `text/event-stream` response. The handler runs after the response starts; the stream
 * closes when the handler's promise settles (unless it calls `close()` earlier) or when the client
 * disconnects, which also aborts `stream.signal`.
 */
export function createEventStream(request: Request, handler: EventStreamHandler, options: EventStreamOptions = {}): Response {
  const keepAliveMs = options.keepAliveMs ?? 15000;
  const abort = new AbortController();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(keepAlive);
    abort.abort();
    try {
      controllerRef?.close();
    } catch {
      // already closed by the runtime
    }
  };

  const write = (chunk: string) => {
    if (closed || !controllerRef) {
      throw new Error('Event stream is closed');
    }
    controllerRef.enqueue(encoder.encode(chunk));
  };

  const stream: EventStream = {
    send(event) {
      write(formatEvent(typeof event === 'string' ? { data: event } : event));
    },
    comment(text) {
      write(`: ${text.replace(/\r?\n/g, ' ')}\n\n`);
    },
    close,
    signal: abort.signal,
    get closed() {
      return closed;
    },
  };

  request.signal.addEventListener('abort', close, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (keepAliveMs > 0) {
        keepAlive = setInterval(() => {
          if (!closed) {
            controller.enqueue(encoder.encode(': keep-alive\n\n'));
          }
        }, keepAliveMs);
      }
      queueMicrotask(() => {
        Promise.resolve()
          .then(() => handler(stream))
          .catch((error: unknown) => {
            if (!closed) {
              controller.enqueue(encoder.encode(formatEvent({ event: 'error', data: { message: error instanceof Error ? error.message : 'Stream error' } })));
            }
          })
          .finally(close);
      });
    },
    cancel() {
      close();
    },
  });

  const headers = new Headers(options.headers);
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  headers.set('cache-control', 'no-cache, no-transform');
  headers.set('connection', 'keep-alive');
  headers.set('x-accel-buffering', 'no');
  return new Response(body, { headers });
}

export function formatEvent(event: ServerSentEvent): string {
  let output = '';
  if (event.event) {
    output += `event: ${singleLine(event.event)}\n`;
  }
  if (event.id !== undefined) {
    output += `id: ${singleLine(event.id)}\n`;
  }
  if (event.retry !== undefined) {
    output += `retry: ${Math.max(0, Math.floor(event.retry))}\n`;
  }
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  for (const line of data.split(/\r?\n/)) {
    output += `data: ${line}\n`;
  }
  return `${output}\n`;
}

function singleLine(value: string) {
  return value.replace(/[\r\n]/g, ' ');
}
