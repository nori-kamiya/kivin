// Pre-routing hooks (`defineApplication({ onRequest })`): method override and trailing-slash redirects.
import type { RequestHook } from '@kivinjs/core';

export interface MethodOverrideOptions {
  /**
   * Where the override comes from. Default: the `_method` field of a urlencoded / multipart form
   * (what HTML forms can send). `{ header: 'X-HTTP-Method-Override' }` or `{ query: '_method' }`
   * read a header or query parameter instead.
   */
  from?: { form: string } | { header: string } | { query: string };
  /** Methods a POST may be turned into (default `PUT`, `PATCH`, `DELETE`). */
  methods?: readonly string[];
}

const DEFAULT_OVERRIDE_METHODS = ['PUT', 'PATCH', 'DELETE'];

function isFormContentType(contentType: string | null) {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return mediaType === 'application/x-www-form-urlencoded' || mediaType === 'multipart/form-data';
}

/**
 * Lets a `POST` be routed as another method (HTML forms only send GET / POST). Only `POST` requests
 * are considered and only the listed methods are accepted (case-insensitive); anything else is left
 * untouched. The body stays readable by the route (a form is read from a clone).
 *
 * ```ts
 * defineApplication({ ..., onRequest: [createMethodOverride()] });
 * // <form method="post" action="/posts/1"><input type="hidden" name="_method" value="DELETE">
 * ```
 */
export function createMethodOverride(options: MethodOverrideOptions = {}): RequestHook {
  const allowed = new Set((options.methods ?? DEFAULT_OVERRIDE_METHODS).map((method) => method.toUpperCase()));
  const source = options.from ?? { form: '_method' };

  const rewrite = (request: Request, value: unknown) => {
    if (typeof value !== 'string') {
      return undefined;
    }
    const method = value.trim().toUpperCase();
    return allowed.has(method) ? new Request(request, { method }) : undefined;
  };

  if ('header' in source) {
    return (request) => (request.method === 'POST' ? rewrite(request, request.headers.get(source.header)) : undefined);
  }

  if ('query' in source) {
    return (request) => {
      if (request.method !== 'POST') {
        return undefined;
      }
      const url = request.url;
      if (!url.includes('?')) {
        return undefined;
      }
      return rewrite(request, new URL(url).searchParams.get(source.query));
    };
  }

  return async (request) => {
    if (request.method !== 'POST' || !isFormContentType(request.headers.get('content-type'))) {
      return undefined;
    }
    let form: FormData;
    try {
      form = await request.clone().formData();
    } catch {
      // A malformed form is the route's to reject (it will fail to parse it the same way).
      return undefined;
    }
    return rewrite(request, form.get(source.form));
  };
}

export interface TrailingSlashOptions {
  /**
   * `'trim'` (default) redirects `/users/` to `/users`; `'append'` redirects `/users` to `/users/`
   * (paths whose last segment contains a dot, like `/app.js`, are left alone). The root `/` is never
   * changed. kivin matches both spellings either way; the redirect gives each resource one URL.
   */
  mode?: 'trim' | 'append';
  /**
   * Redirect status for GET / HEAD (default 301). Other methods always get 308, which keeps the
   * method and body (a 301 would turn them into GET in most clients).
   */
  status?: 301 | 302 | 307 | 308;
}

/** Redirects to the canonical spelling of the path (with or without a trailing slash). */
export function createTrailingSlash(options: TrailingSlashOptions = {}): RequestHook {
  const mode = options.mode ?? 'trim';
  const safeStatus = options.status ?? 301;

  return (request) => {
    const url = request.url;
    const authorityEnd = url.indexOf('/', url.indexOf('//') + 2);
    if (authorityEnd === -1) {
      return undefined;
    }
    let pathEnd = url.length;
    for (let index = authorityEnd; index < url.length; index += 1) {
      const code = url.charCodeAt(index);
      if (code === 63 /* ? */ || code === 35 /* # */) {
        pathEnd = index;
        break;
      }
    }
    const path = url.slice(authorityEnd, pathEnd);
    if (path === '/') {
      return undefined;
    }

    let target: string | undefined;
    if (mode === 'trim') {
      if (path.endsWith('/')) {
        target = path.replace(/\/+$/, '');
      }
    } else if (!path.endsWith('/') && !path.slice(path.lastIndexOf('/') + 1).includes('.')) {
      target = `${path}/`;
    }
    if (target === undefined) {
      return undefined;
    }
    // `//evil.example/` or `/\evil.example/` would become a protocol-relative Location (an open
    // redirect): the target always starts with exactly one slash.
    target = `/${target.replace(/^[/\\]+/, '')}`;

    const status = request.method === 'GET' || request.method === 'HEAD' ? safeStatus : 308;
    // A relative Location (path + query) keeps the scheme / host the client used, behind proxies too.
    return new Response(null, { status, headers: { location: `${target}${url.slice(pathEnd)}` } });
  };
}
