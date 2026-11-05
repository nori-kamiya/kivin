// Cookie parsing and serialization (RFC 6265), dependency-free.

export interface CookieOptions {
  domain?: string;
  path?: string;
  /** Lifetime in seconds. `0` expires the cookie immediately. */
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitioned?: boolean;
  priority?: 'Low' | 'Medium' | 'High';
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Parses a `Cookie` header into a name -> value record. Values are URI-decoded when possible. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  if (!header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (!name || name in cookies) {
      continue;
    }
    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    cookies[name] = safeDecode(value);
  }
  return cookies;
}

/** Reads one cookie from a request. */
export function getCookie(request: Request, name: string): string | undefined {
  return parseCookies(request.headers.get('cookie'))[name];
}

/** Serializes a `Set-Cookie` header value. Secure defaults: `Path=/`, and `SameSite=None` forces `Secure`. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!COOKIE_NAME.test(name)) {
    throw new TypeError(`Invalid cookie name: ${name}`);
  }

  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    if (!Number.isFinite(options.maxAge)) {
      throw new TypeError('Cookie maxAge must be a finite number');
    }
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure || options.sameSite === 'None' || options.partitioned) {
    parts.push('Secure');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.partitioned) {
    parts.push('Partitioned');
  }
  if (options.priority) {
    parts.push(`Priority=${options.priority}`);
  }
  return parts.join('; ');
}

/** `Set-Cookie` value that deletes a cookie (same `path` / `domain` as when it was set). */
export function serializeDeletedCookie(name: string, options: Pick<CookieOptions, 'domain' | 'path' | 'secure' | 'sameSite' | 'partitioned'> = {}) {
  return serializeCookie(name, '', { ...options, maxAge: 0, expires: new Date(0) });
}

function safeDecode(value: string) {
  if (!value.includes('%')) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
