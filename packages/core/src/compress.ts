// Response compression (gzip / brotli) and ETag middleware.
//
//   globals: { middleware: [createCompressMiddleware(), createEtagMiddleware()] }
//
// Order matters: list compression first (outermost) so the ETag is computed on, and compared
// against, the uncompressed representation.
import { brotliCompressSync, constants as zlib } from 'node:zlib';
import type { RequestContext } from './context';
import type { NestLikeMiddleware } from './runtime-types';

export type CompressionEncoding = 'br' | 'gzip';

export interface CompressOptions {
  /** Encodings to offer, in order of preference. Default `['br', 'gzip']`. */
  encodings?: CompressionEncoding[];
  /** Bodies smaller than this many bytes are sent uncompressed. Default 1024. */
  threshold?: number;
  /** Brotli quality 0-11. Default 4: ~2x smaller than gzip at similar cost (11 is ~100x slower). */
  brotliQuality?: number;
  /** gzip level 1-9. Default 6. */
  gzipLevel?: number;
  /** Whether a content type is compressible. Default: text, JSON, JS, XML, SVG, wasm. */
  filter?: (contentType: string) => boolean;
}

const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|[^;]+\+json|javascript|ecmascript|xml|[^;]+\+xml|wasm|x-ndjson|graphql-response\+json)|image\/svg\+xml)/i;
/** Streamed formats: compressed as a stream, never buffered. */
const STREAMING = /^(application\/x-ndjson|application\/jsonl|text\/plain;\s*charset=[^;]*;\s*stream)/i;

export function createCompressMiddleware(options: CompressOptions = {}) {
  const encodings = options.encodings ?? ['br', 'gzip'];
  const threshold = options.threshold ?? 1024;
  const brotliQuality = options.brotliQuality ?? 4;
  const gzipLevel = (options.gzipLevel ?? 6) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  const filter = options.filter ?? ((contentType: string) => COMPRESSIBLE.test(contentType));

  const compress = async (request: Request, response: Response): Promise<Response> => {
    const contentType = response.headers.get('content-type') ?? '';
    if (
      request.method === 'HEAD'
      || response.body === null
      || response.status === 204
      || response.status === 206
      || response.status === 304
      || response.headers.has('content-encoding')
      || /\bno-transform\b/i.test(response.headers.get('cache-control') ?? '')
      || !filter(contentType)
    ) {
      return response;
    }
    const accepted = request.headers.get('accept-encoding') ?? '';
    const encoding = encodings.find((candidate) => acceptsEncoding(accepted, candidate));
    // Vary on every compressible response, so caches never serve a compressed body to a client
    // that did not ask for one (or the reverse).
    if (!encoding) {
      return withVary(response);
    }
    const knownLength = response.headers.get('content-length');
    if (knownLength !== null && Number(knownLength) < threshold) {
      return withVary(response);
    }

    if (STREAMING.test(contentType)) {
      const stream = response.body!.pipeThrough(new CompressionStream(encoding === 'br' ? ('brotli' as CompressionFormat) : 'gzip'));
      return encodedResponse(stream, response, encoding);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < threshold) {
      return withVary(new Response(bytes, response));
    }
    const compressed = encoding === 'br'
      ? brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: brotliQuality, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength } })
      : Bun.gzipSync(bytes, { level: gzipLevel });
    return encodedResponse(compressed, response, encoding);
  };

  return class CompressMiddleware implements NestLikeMiddleware {
    async handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      return compress(context.request, await next());
    }

    async handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      return compress(request, await next());
    }
  };
}

/** Whether `Accept-Encoding` allows `encoding` (explicitly or via `*`) with a non-zero q. */
function acceptsEncoding(header: string, encoding: string) {
  return header.split(',').some((part) => {
    const [name, ...params] = part.trim().split(';');
    const token = name?.trim().toLowerCase();
    if (token !== encoding && token !== '*') {
      return false;
    }
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

function withVary(response: Response) {
  const vary = response.headers.get('vary');
  if (vary && /(^|,)\s*(accept-encoding|\*)\s*(,|$)/i.test(vary)) {
    return response;
  }
  try {
    response.headers.append('vary', 'Accept-Encoding');
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.append('vary', 'Accept-Encoding');
    return copy;
  }
}

function encodedResponse(body: BodyInit, original: Response, encoding: CompressionEncoding) {
  const headers = new Headers(original.headers);
  headers.set('content-encoding', encoding);
  headers.delete('content-length');
  // The encoded bytes differ from the identity representation: a strong ETag becomes weak.
  const etag = headers.get('etag');
  if (etag && !etag.startsWith('W/')) {
    headers.set('etag', `W/${etag}`);
  }
  const response = new Response(body, { status: original.status, statusText: original.statusText, headers });
  return withVary(response);
}

export interface EtagOptions {
  /** Bodies larger than this are not hashed (they are sent without an ETag). Default 1 MiB. */
  maxSize?: number;
}

/**
 * Adds a weak ETag (hash of the body) to successful GET / HEAD responses that have none, and
 * answers `304 Not Modified` when `If-None-Match` matches. Streams (SSE, NDJSON) and responses
 * that already carry an ETag (e.g. `serveStatic`, which also handles 304 itself) pass through.
 */
export function createEtagMiddleware(options: EtagOptions = {}) {
  const maxSize = options.maxSize ?? 1024 * 1024;

  const tag = async (request: Request, response: Response): Promise<Response> => {
    if ((request.method !== 'GET' && request.method !== 'HEAD') || response.status !== 200 || response.body === null || response.headers.has('etag')) {
      return response;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (/^text\/event-stream|^application\/(x-ndjson|jsonl)/i.test(contentType)) {
      return response;
    }
    const knownLength = response.headers.get('content-length');
    if (knownLength !== null && Number(knownLength) > maxSize) {
      return response;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    if (bytes.byteLength <= maxSize) {
      headers.set('etag', `W/"${bytes.byteLength.toString(36)}-${Bun.hash(bytes).toString(36)}"`);
    }
    const etag = headers.get('etag');
    if (etag && matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
      headers.delete('content-length');
      headers.delete('content-type');
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === 'HEAD' ? null : bytes, { status: response.status, statusText: response.statusText, headers });
  };

  return class EtagMiddleware implements NestLikeMiddleware {
    async handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      return tag(context.request, await next());
    }

    async handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      return tag(request, await next());
    }
  };
}

function matchesIfNoneMatch(header: string | null, etag: string) {
  if (header === null) {
    return false;
  }
  const opaque = etag.replace(/^W\//, '');
  return header.trim() === '*' || header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === opaque);
}
