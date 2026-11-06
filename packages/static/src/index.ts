// Static file serving for Bun's native routes:
//
//   app.listen({ port: 3000, routes: { '/assets/*': serveStatic({ root: './public', prefix: '/assets' }) } });
//
// Files are streamed with Bun.file (Content-Type from the extension) and get validators (weak ETag
// from size + mtime, Last-Modified), so conditional requests answer 304. Single byte ranges answer
// 206 (416 when unsatisfiable). Paths that escape `root` (`..`, encoded or not), contain NUL or
// backslashes, or name dotfiles are refused before touching the file system.
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { acceptsEncoding } from '@kivin/http';

export interface ServeStaticOptions {
  /** Directory to serve from (resolved against the current working directory). */
  root: string;
  /** URL prefix the route is mounted on (e.g. `/assets` for `'/assets/*'`). Default: none. */
  prefix?: string;
  /** File served for a directory request. Default `index.html`; `false` disables. */
  index?: string | false;
  /**
   * File (relative to `root`) served for paths that do not exist, e.g. `index.html` for a single-page
   * app. It is served with status 200 and only for GET / HEAD requests that accept HTML.
   */
  fallback?: string;
  /** `Cache-Control` value, e.g. `public, max-age=31536000, immutable` for hashed assets. */
  cacheControl?: string;
  /** `'deny'` (default) answers 404 for any path segment starting with `.`; `'allow'` serves them. */
  dotfiles?: 'deny' | 'allow';
  /** Serve `<file>.br` / `<file>.gz` next to a file when the client accepts that encoding. Default false. */
  precompressed?: boolean;
  /** Extra headers on every file response. */
  headers?: Record<string, string>;
}

type StaticHandler = (request: Request) => Promise<Response>;

interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

const notFound = () => Response.json({ message: 'Not Found' }, { status: 404 });

export function serveStatic(options: ServeStaticOptions): StaticHandler {
  const root = resolve(options.root);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  const prefix = options.prefix ? `/${options.prefix.replace(/^\/+|\/+$/g, '')}` : '';
  const index = options.index === undefined ? 'index.html' : options.index;
  const allowDotfiles = options.dotfiles === 'allow';

  const toFilePath = (relative: string): string | undefined => {
    if (relative.includes('\0') || relative.includes('\\')) {
      return undefined;
    }
    const segments = relative.split('/').filter((segment) => segment !== '');
    for (const segment of segments) {
      if (segment === '..' || segment === '.' || (!allowDotfiles && segment.startsWith('.'))) {
        return undefined;
      }
    }
    const filePath = resolve(root, ...segments);
    return filePath === root || filePath.startsWith(rootWithSep) ? filePath : undefined;
  };

  const fileInfo = async (path: string): Promise<FileInfo | undefined> => {
    try {
      const stats = await stat(path);
      if (stats.isFile()) {
        return { path, size: stats.size, mtimeMs: stats.mtimeMs };
      }
      if (stats.isDirectory() && index) {
        return fileInfo(resolve(path, index));
      }
    } catch {
      // Missing or unreadable: not found.
    }
    return undefined;
  };

  const fallbackPath = options.fallback ? toFilePath(options.fallback) : undefined;
  if (options.fallback && !fallbackPath) {
    throw new Error(`serveStatic: fallback ${JSON.stringify(options.fallback)} is outside root`);
  }

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json({ message: 'Method Not Allowed' }, { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    const pathname = new URL(request.url).pathname;
    if (prefix && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      return notFound();
    }
    let relative: string;
    try {
      relative = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return notFound();
    }

    const requested = toFilePath(relative);
    let file = requested ? await fileInfo(requested) : undefined;
    if (!file && fallbackPath && (request.headers.get('accept') ?? '').includes('text/html')) {
      file = await fileInfo(fallbackPath);
    }
    if (!file) {
      return notFound();
    }

    return respondWithFile(request, file, options);
  };
}

async function respondWithFile(request: Request, file: FileInfo, options: ServeStaticOptions): Promise<Response> {
  const etag = `W/"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
  const lastModified = new Date(Math.floor(file.mtimeMs / 1000) * 1000).toUTCString();
  const headers = new Headers(options.headers);
  headers.set('etag', etag);
  headers.set('last-modified', lastModified);
  headers.set('accept-ranges', 'bytes');
  if (options.cacheControl) {
    headers.set('cache-control', options.cacheControl);
  }

  if (isNotModified(request, etag, file.mtimeMs)) {
    return new Response(null, { status: 304, headers });
  }

  const body = Bun.file(file.path);
  headers.set('content-type', body.type || 'application/octet-stream');

  const encoded = options.precompressed ? await findPrecompressed(request, file) : undefined;
  if (encoded) {
    headers.set('content-encoding', encoded.encoding);
    headers.append('vary', 'Accept-Encoding');
    headers.set('content-length', String(encoded.size));
    headers.delete('accept-ranges');
    return new Response(request.method === 'HEAD' ? null : Bun.file(encoded.path), { status: 200, headers });
  }

  const range = request.headers.get('range');
  if (range && isRangeFresh(request, etag, lastModified)) {
    const parsed = parseRange(range, file.size);
    if (parsed === 'unsatisfiable') {
      headers.set('content-range', `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (parsed) {
      headers.set('content-range', `bytes ${parsed.start}-${parsed.end}/${file.size}`);
      headers.set('content-length', String(parsed.end - parsed.start + 1));
      return new Response(request.method === 'HEAD' ? null : body.slice(parsed.start, parsed.end + 1), { status: 206, headers });
    }
  }

  headers.set('content-length', String(file.size));
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

function isNotModified(request: Request, etag: string, mtimeMs: number) {
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null) {
    // Weak comparison (RFC 9110 13.1.2); If-Modified-Since is ignored when If-None-Match is present.
    const opaque = etag.replace(/^W\//, '');
    return ifNoneMatch.trim() === '*' || ifNoneMatch.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === opaque);
  }
  const ifModifiedSince = request.headers.get('if-modified-since');
  if (ifModifiedSince !== null) {
    const since = Date.parse(ifModifiedSince);
    return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

/** A Range is honoured only if If-Range (when present) still matches the current file. */
function isRangeFresh(request: Request, etag: string, lastModified: string) {
  const ifRange = request.headers.get('if-range');
  if (ifRange === null) {
    return true;
  }
  // Weak validators cannot satisfy If-Range (RFC 9110 13.1.5); a date must match exactly.
  return !ifRange.startsWith('W/') && !ifRange.startsWith('"') ? ifRange === lastModified : ifRange === etag && !etag.startsWith('W/');
}

/** Single byte range only; multiple ranges are served as the full file (allowed by RFC 9110). */
function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) {
    return undefined;
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) {
      return 'unsatisfiable';
    }
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) {
    return 'unsatisfiable';
  }
  return { start, end };
}

async function findPrecompressed(request: Request, file: FileInfo) {
  const accepted = request.headers.get('accept-encoding') ?? '';
  for (const [encoding, extension] of [['br', '.br'], ['gzip', '.gz']] as const) {
    if (!acceptsEncoding(accepted, encoding)) {
      continue;
    }
    try {
      const stats = await stat(file.path + extension);
      if (stats.isFile()) {
        return { encoding, path: file.path + extension, size: stats.size };
      }
    } catch {
      // No precompressed variant.
    }
  }
  return undefined;
}
