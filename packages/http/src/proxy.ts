// Reverse-proxy helper (equivalent of Hono's `proxy`): forwards a request upstream and returns the
// upstream response, without hop-by-hop headers and without re-encoding the body.
import { getClientAddress } from '@kivinjs/core';

type HeadersInput = NonNullable<ConstructorParameters<typeof Headers>[0]>;

// RFC 9110 §7.6.1 connection-specific headers, plus `host` (set from the target URL).
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];

function stripHopByHop(headers: Headers) {
  // Headers named in `Connection` are connection-specific too.
  for (const name of (headers.get('connection') ?? '').split(',')) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed) {
      headers.delete(trimmed);
    }
  }
  for (const name of HOP_BY_HOP) {
    headers.delete(name);
  }
}

export interface ProxyOptions {
  /** Extra / replacement request headers, or a function editing the forwarded headers. */
  headers?: HeadersInput | ((headers: Headers) => void);
  /**
   * Adds `X-Forwarded-For` (appending the client address), `X-Forwarded-Host` and
   * `X-Forwarded-Proto`. Default true. Turn it off when the upstream must not see them.
   */
  forwarded?: boolean;
  /** Aborts the upstream request after this many ms (answering 504). */
  timeoutMs?: number;
  /** The fetch implementation (default global `fetch`), e.g. for tests. */
  fetch?: (input: Request) => Promise<Response>;
}

/**
 * Forwards `request` (method, headers, body) to `target` and returns the upstream response. The
 * body is streamed both ways and passed through as received (`Content-Encoding` stays valid).
 * Upstream failures answer 502 (504 on timeout); client disconnects abort the upstream request.
 *
 * ```ts
 * // native route: everything under /api/* to the backend
 * '/api/*': (request) => {
 *   const url = new URL(request.url);
 *   return proxy(`http://backend:8080${url.pathname.slice(4)}${url.search}`, request);
 * }
 * ```
 */
export async function proxy(target: string | URL, request: Request, options: ProxyOptions = {}): Promise<Response> {
  const headers = new Headers(request.headers);
  stripHopByHop(headers);
  if (options.forwarded ?? true) {
    const incoming = new URL(request.url);
    const client = getClientAddress(request);
    if (client) {
      const previous = request.headers.get('x-forwarded-for');
      headers.set('x-forwarded-for', previous ? `${previous}, ${client}` : client);
    }
    headers.set('x-forwarded-host', request.headers.get('host') ?? incoming.host);
    headers.set('x-forwarded-proto', incoming.protocol.slice(0, -1));
  }
  if (typeof options.headers === 'function') {
    options.headers(headers);
  } else if (options.headers) {
    for (const [name, value] of new Headers(options.headers)) {
      headers.set(name, value);
    }
  }

  const controller = new AbortController();
  const onClientAbort = () => controller.abort();
  request.signal.addEventListener('abort', onClientAbort, { once: true });
  let timedOut = false;
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;
  const upstreamRequest = new Request(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    redirect: 'manual',
    signal: controller.signal,
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);

  let upstream: Response;
  try {
    upstream = options.fetch
      ? await options.fetch(upstreamRequest)
      // `decompress: false`: forward the bytes as encoded, so `Content-Encoding` stays correct.
      : await fetch(upstreamRequest, { decompress: false } as RequestInit);
  } catch (error) {
    if (timedOut) {
      return Response.json({ message: 'Gateway Timeout' }, { status: 504 });
    }
    if (request.signal.aborted) {
      throw error;
    }
    console.error('[kivin] Proxy request failed', error);
    return Response.json({ message: 'Bad Gateway' }, { status: 502 });
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onClientAbort);
  }

  const responseHeaders = new Headers(upstream.headers);
  stripHopByHop(responseHeaders);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}
