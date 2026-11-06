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
    parts.push(`Domain=${checkAttribute('domain', options.domain)}`);
  }
  parts.push(`Path=${checkAttribute('path', options.path ?? '/')}`);
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure || options.sameSite === 'None' || options.partitioned) {
    parts.push('Secure');
  }
  if (options.sameSite) {
    if (!SAME_SITE.has(options.sameSite)) {
      throw new TypeError(`Invalid cookie sameSite: ${String(options.sameSite)}`);
    }
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.partitioned) {
    parts.push('Partitioned');
  }
  if (options.priority) {
    if (!PRIORITY.has(options.priority)) {
      throw new TypeError(`Invalid cookie priority: ${String(options.priority)}`);
    }
    parts.push(`Priority=${options.priority}`);
  }
  return parts.join('; ');
}

/** `Set-Cookie` value that deletes a cookie (same `path` / `domain` as when it was set). */
export function serializeDeletedCookie(name: string, options: Pick<CookieOptions, 'domain' | 'path' | 'secure' | 'sameSite' | 'partitioned'> = {}) {
  return serializeCookie(name, '', { ...options, maxAge: 0, expires: new Date(0) });
}

const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
const PRIORITY = new Set(['Low', 'Medium', 'High']);
// Visible ASCII except `;` (RFC 6265 path-value / domain): a `;` or a control character would let the
// value add attributes (`path: '/; Domain=evil'`) or split the header.
const ATTRIBUTE_VALUE = /^[\u0021-\u003A\u003C-\u007E]+$/;

function checkAttribute(name: 'path' | 'domain', value: string) {
  if (!ATTRIBUTE_VALUE.test(value)) {
    throw new TypeError(`Invalid cookie ${name}: ${JSON.stringify(value)}`);
  }
  return value;
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

// ---------------------------------------------------------------------------------------------
// Signed cookies (HMAC-SHA256, Web Crypto).
//
// A signed value is `<value>.<signature>` where the signature is the base64url (unpadded) HMAC of
// `<name>=<value>`: binding the cookie name means a value signed for one cookie cannot be replayed
// under another name with the same secret. Verification uses `crypto.subtle.verify` (constant time).

/** A signing secret: a string (UTF-8), raw key bytes, or an HMAC-SHA256 `CryptoKey`. */
export type CookieSecret = string | ArrayBuffer | ArrayBufferView<ArrayBuffer> | CryptoKey;
/**
 * One secret, or several for rotation: values are signed with the first and accepted when any of
 * them verifies, so a new secret can be put first while cookies signed with the old one stay valid.
 */
export type CookieSecrets = CookieSecret | readonly CookieSecret[];

const HMAC = { name: 'HMAC', hash: 'SHA-256' } as const;
const textEncoder = new TextEncoder();
const stringKeys = new Map<string, Promise<CryptoKey>>();
const objectKeys = new WeakMap<object, Promise<CryptoKey>>();
const MAX_CACHED_STRING_KEYS = 64;

function importSecret(secret: CookieSecret): Promise<CryptoKey> {
  if (typeof secret === 'string') {
    let key = stringKeys.get(secret);
    if (!key) {
      if (secret.length === 0) {
        throw new TypeError('Cookie secret must not be empty');
      }
      if (stringKeys.size >= MAX_CACHED_STRING_KEYS) {
        stringKeys.delete(stringKeys.keys().next().value!);
      }
      key = crypto.subtle.importKey('raw', textEncoder.encode(secret), HMAC, false, ['sign', 'verify']);
      stringKeys.set(secret, key);
    }
    return key;
  }
  if (secret instanceof CryptoKey) {
    return Promise.resolve(secret);
  }
  let key = objectKeys.get(secret);
  if (!key) {
    if (secret.byteLength === 0) {
      throw new TypeError('Cookie secret must not be empty');
    }
    key = crypto.subtle.importKey('raw', secret, HMAC, false, ['sign', 'verify']);
    objectKeys.set(secret, key);
  }
  return key;
}

function secretList(secret: CookieSecrets): readonly CookieSecret[] {
  const list = Array.isArray(secret) ? secret as readonly CookieSecret[] : [secret as CookieSecret];
  if (list.length === 0) {
    throw new TypeError('At least one cookie secret is required');
  }
  return list;
}

function toBase64Url(bytes: ArrayBuffer) {
  return Buffer.from(bytes).toString('base64url');
}

const SIGNATURE_LENGTH = 43; // base64url of 32 bytes, unpadded
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Signs `value` for the cookie `name`: returns `<value>.<signature>`. */
export async function signCookieValue(name: string, value: string, secret: CookieSecrets): Promise<string> {
  const key = await importSecret(secretList(secret)[0]!);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(`${name}=${value}`));
  return `${value}.${toBase64Url(signature)}`;
}

/**
 * Verifies a value produced by `signCookieValue` for the same cookie `name`. Returns the original
 * value, or `false` when the signature is missing, malformed or does not match any secret.
 */
export async function verifyCookieValue(name: string, signedValue: string, secret: CookieSecrets): Promise<string | false> {
  const separator = signedValue.lastIndexOf('.');
  if (separator === -1 || signedValue.length - separator - 1 !== SIGNATURE_LENGTH) {
    return false;
  }
  const encodedSignature = signedValue.slice(separator + 1);
  if (!BASE64URL.test(encodedSignature)) {
    return false;
  }
  const value = signedValue.slice(0, separator);
  const signature = Buffer.from(encodedSignature, 'base64url');
  const data = textEncoder.encode(`${name}=${value}`);
  for (const candidate of secretList(secret)) {
    if (await crypto.subtle.verify('HMAC', await importSecret(candidate), signature, data)) {
      return value;
    }
  }
  return false;
}

/**
 * Reads and verifies a signed cookie: the value, `undefined` when the cookie is absent, or `false`
 * when it is present but its signature does not verify (tampered, or signed with another secret).
 */
export async function getSignedCookie(request: Request, name: string, secret: CookieSecrets): Promise<string | undefined | false> {
  const signed = getCookie(request, name);
  return signed === undefined ? undefined : verifyCookieValue(name, signed, secret);
}

/** `Set-Cookie` header value for a signed cookie (see `signCookieValue`). */
export async function serializeSignedCookie(name: string, value: string, secret: CookieSecrets, options?: CookieOptions): Promise<string> {
  return serializeCookie(name, await signCookieValue(name, value, secret), options);
}
