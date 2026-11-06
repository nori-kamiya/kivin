// HTTP Basic / Bearer authentication guards and cross-origin request (CSRF) protection.
import { timingSafeEqual } from 'node:crypto';
import { forbidden, unauthorized, type CanActivate, type NestLikeMiddleware, type RequestContext } from '@kivinjs/core';

export interface BasicCredentials {
  username: string;
  password: string;
}

/** Credentials from `Authorization: Basic …`, or `undefined` when absent or malformed. */
export function readBasicCredentials(request: Request): BasicCredentials | undefined {
  const header = request.headers.get('authorization');
  const match = header ? /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header) : null;
  if (!match) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(match[1]!), (character) => character.charCodeAt(0)));
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(':');
  return separator === -1 ? undefined : { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** Token from `Authorization: Bearer …`, or `undefined`. */
export function readBearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header) : null;
  return match?.[1];
}

/** Constant-time string comparison (lengths are compared via fixed-size digests). */
export function safeCompare(a: string, b: string) {
  const left = new Bun.CryptoHasher('sha256').update(a).digest();
  const right = new Bun.CryptoHasher('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export interface BasicAuthOptions {
  /** Allowed `username: password` pairs, compared in constant time. */
  users?: Record<string, string>;
  /** Custom check (e.g. against a password hash); used instead of `users`. */
  verify?: (credentials: BasicCredentials, request: Request) => boolean | Promise<boolean>;
  /** Realm shown by browsers. Default `Restricted`. */
  realm?: string;
}

/**
 * Guard for HTTP Basic authentication. Missing or wrong credentials answer `401` with a
 * `WWW-Authenticate: Basic` challenge. Read the user in a handler with `readBasicCredentials`.
 */
export function createBasicAuthGuard(options: BasicAuthOptions) {
  if (!options.users && !options.verify) {
    throw new TypeError('createBasicAuthGuard: pass users or verify');
  }
  const challenge = `Basic realm="${(options.realm ?? 'Restricted').replace(/["\\]/g, '')}", charset="UTF-8"`;
  const users = Object.entries(options.users ?? {});
  const check = async (request: Request) => {
    const credentials = readBasicCredentials(request);
    let ok = false;
    if (credentials) {
      if (options.verify) {
        ok = await options.verify(credentials, request);
      } else {
        // Compare against every entry so timing does not reveal which usernames exist.
        for (const [username, password] of users) {
          const match = safeCompare(credentials.username, username) && safeCompare(credentials.password, password);
          ok ||= match;
        }
      }
    }
    if (!ok) {
      throw unauthorized('Unauthorized', { headers: { 'www-authenticate': challenge } });
    }
    return true;
  };

  return class BasicAuthGuard implements CanActivate {
    canActivateRaw(request: Request) {
      return check(request);
    }

    canActivate(context: RequestContext) {
      return check(context.request);
    }
  };
}

export interface BearerAuthOptions {
  /** Accepted static tokens (API keys), compared in constant time. */
  tokens?: string[];
  /** Custom check; used instead of `tokens`. */
  verify?: (token: string, request: Request) => boolean | Promise<boolean>;
  realm?: string;
}

/**
 * Guard for `Authorization: Bearer <token>` with static tokens or a custom check (for JWTs use
 * `@kivinjs/jwt`). Answers `401` with a `WWW-Authenticate: Bearer` challenge.
 */
export function createBearerAuthGuard(options: BearerAuthOptions) {
  if (!options.tokens && !options.verify) {
    throw new TypeError('createBearerAuthGuard: pass tokens or verify');
  }
  const realm = (options.realm ?? 'api').replace(/["\\]/g, '');
  const tokens = options.tokens ?? [];
  const check = async (request: Request) => {
    const token = readBearerToken(request);
    if (!token) {
      throw unauthorized('Missing bearer token', { headers: { 'www-authenticate': `Bearer realm="${realm}"` } });
    }
    let ok = false;
    if (options.verify) {
      ok = await options.verify(token, request);
    } else {
      for (const candidate of tokens) {
        ok = safeCompare(token, candidate) || ok;
      }
    }
    if (!ok) {
      throw unauthorized('Invalid token', { headers: { 'www-authenticate': `Bearer realm="${realm}", error="invalid_token"` } });
    }
    return true;
  };

  return class BearerAuthGuard implements CanActivate {
    canActivateRaw(request: Request) {
      return check(request);
    }

    canActivate(context: RequestContext) {
      return check(context.request);
    }
  };
}

export interface CsrfOptions {
  /** Origins (e.g. `https://app.example.com`) allowed to send cross-site unsafe requests. */
  trustedOrigins?: string[] | ((origin: string) => boolean);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects cross-site state-changing requests from browsers with `403` (the algorithm of Go 1.25's
 * `CrossOriginProtection`): for methods other than GET / HEAD / OPTIONS, `Sec-Fetch-Site` must be
 * `same-origin` or `none`; without it, an `Origin` header must match the request's host. Requests
 * with neither header (curl, server-to-server) pass. `trustedOrigins` are always allowed.
 * Unlike checks that look only at form content types, this covers every body type.
 */
export function createCsrfMiddleware(options: CsrfOptions = {}) {
  const trusted = options.trustedOrigins;
  const isTrusted = typeof trusted === 'function'
    ? trusted
    : ((origins: Set<string>) => (origin: string) => origins.has(origin))(new Set((trusted ?? []).map((origin) => new URL(origin).origin)));

  const allowed = (request: Request) => {
    if (SAFE_METHODS.has(request.method)) {
      return true;
    }
    const origin = request.headers.get('origin');
    if (origin && isTrusted(origin)) {
      return true;
    }
    const site = request.headers.get('sec-fetch-site');
    if (site !== null) {
      return site === 'same-origin' || site === 'none';
    }
    if (origin === null) {
      return true;
    }
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    return originHost === (request.headers.get('host') ?? new URL(request.url).host);
  };

  const guard = (request: Request, next: () => Response | PromiseLike<Response>) => {
    if (!allowed(request)) {
      throw forbidden('Cross-origin request blocked');
    }
    return next();
  };

  return class CsrfMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      return guard(context.request, next);
    }

    handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      return guard(request, next);
    }
  };
}
