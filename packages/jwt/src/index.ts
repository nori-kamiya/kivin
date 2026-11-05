// JSON Web Tokens on Web Crypto (no dependencies) and a bearer-token guard for kivin.
import { unauthorized, type CanActivate, type RequestContext } from '@kivin/core';

export type JwtAlgorithm =
  | 'HS256' | 'HS384' | 'HS512'
  | 'RS256' | 'RS384' | 'RS512'
  | 'PS256' | 'PS384' | 'PS512'
  | 'ES256' | 'ES384' | 'ES512'
  | 'EdDSA';

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

/** Key material: a shared secret for HS*, otherwise a `CryptoKey` or JWK (public to verify, private to sign). */
export type JwtKey = string | Uint8Array | CryptoKey | JsonWebKey;

export interface VerifyJwtOptions {
  key: JwtKey;
  /** Accepted algorithms. Required, so a token can never choose a weaker algorithm (or `none`). */
  algorithms: readonly JwtAlgorithm[];
  issuer?: string | readonly string[];
  audience?: string | readonly string[];
  subject?: string;
  /** Seconds of clock skew tolerated for `exp` / `nbf`. Default 0. */
  clockToleranceSec?: number;
  /** Reject tokens whose `iat` is older than this many seconds. */
  maxAgeSec?: number;
  /** Claims that must be present. `exp` is required by default; pass `[]` to allow non-expiring tokens. */
  requiredClaims?: readonly string[];
  /** Current time in seconds, for tests. */
  now?: () => number;
}

export interface SignJwtOptions {
  key: JwtKey;
  algorithm: JwtAlgorithm;
  /** Lifetime in seconds; sets `exp` (and `iat`). */
  expiresInSec?: number;
  notBeforeSec?: number;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  keyId?: string;
  now?: () => number;
}

export type JwtErrorCode = 'malformed' | 'algorithm' | 'signature' | 'expired' | 'not-yet-valid' | 'claim';

export class JwtError extends Error {
  constructor(readonly code: JwtErrorCode, message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ALGORITHMS: Record<JwtAlgorithm, { import: RsaHashedImportParams | EcKeyImportParams | HmacImportParams | Algorithm; sign: Algorithm | RsaPssParams | EcdsaParams }> = {
  HS256: { import: { name: 'HMAC', hash: 'SHA-256' }, sign: { name: 'HMAC' } },
  HS384: { import: { name: 'HMAC', hash: 'SHA-384' }, sign: { name: 'HMAC' } },
  HS512: { import: { name: 'HMAC', hash: 'SHA-512' }, sign: { name: 'HMAC' } },
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  RS384: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  RS512: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { import: { name: 'RSA-PSS', hash: 'SHA-256' }, sign: { name: 'RSA-PSS', saltLength: 32 } as RsaPssParams },
  PS384: { import: { name: 'RSA-PSS', hash: 'SHA-384' }, sign: { name: 'RSA-PSS', saltLength: 48 } as RsaPssParams },
  PS512: { import: { name: 'RSA-PSS', hash: 'SHA-512' }, sign: { name: 'RSA-PSS', saltLength: 64 } as RsaPssParams },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams },
  ES384: { import: { name: 'ECDSA', namedCurve: 'P-384' }, sign: { name: 'ECDSA', hash: 'SHA-384' } as EcdsaParams },
  ES512: { import: { name: 'ECDSA', namedCurve: 'P-521' }, sign: { name: 'ECDSA', hash: 'SHA-512' } as EcdsaParams },
  EdDSA: { import: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
};

// Imported keys are cached per key object / secret, per algorithm and usage.
const keyCache = new WeakMap<object, Map<string, Promise<CryptoKey>>>();
const secretKeyCache = new Map<string, Promise<CryptoKey>>();

function importKey(key: JwtKey, algorithm: JwtAlgorithm, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const cacheKey = `${algorithm}:${usage}`;
  if (typeof key === 'string') {
    const secretKey = `${cacheKey}:${key}`;
    let cached = secretKeyCache.get(secretKey);
    if (!cached) {
      cached = doImport(key, algorithm, usage);
      if (secretKeyCache.size > 64) {
        secretKeyCache.clear();
      }
      secretKeyCache.set(secretKey, cached);
    }
    return cached;
  }
  let perKey = keyCache.get(key);
  if (!perKey) {
    perKey = new Map();
    keyCache.set(key, perKey);
  }
  let cached = perKey.get(cacheKey);
  if (!cached) {
    cached = doImport(key, algorithm, usage);
    perKey.set(cacheKey, cached);
  }
  return cached;
}

async function doImport(key: JwtKey, algorithm: JwtAlgorithm, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const params = ALGORITHMS[algorithm].import;
  if (typeof CryptoKey !== 'undefined' && key instanceof CryptoKey) {
    return key;
  }
  if (typeof key === 'string' || key instanceof Uint8Array) {
    if (!algorithm.startsWith('HS')) {
      throw new JwtError('algorithm', `${algorithm} needs a CryptoKey or JWK, not a shared secret`);
    }
    return crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : Uint8Array.from(key), params, false, [usage]);
  }
  return crypto.subtle.importKey('jwk', key as JsonWebKey, params, false, [usage]);
}

export async function signJwt(payload: JwtPayload, options: SignJwtOptions): Promise<string> {
  const now = Math.floor(options.now?.() ?? Date.now() / 1000);
  const claims: JwtPayload = { ...payload };
  if (options.expiresInSec !== undefined) {
    claims.iat ??= now;
    claims.exp = now + options.expiresInSec;
  }
  if (options.notBeforeSec !== undefined) {
    claims.nbf = now + options.notBeforeSec;
  }
  if (options.issuer) {
    claims.iss = options.issuer;
  }
  if (options.audience) {
    claims.aud = options.audience;
  }
  if (options.subject) {
    claims.sub = options.subject;
  }

  const header = { alg: options.algorithm, typ: 'JWT', ...(options.keyId ? { kid: options.keyId } : {}) };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(claims)}`;
  const key = await importKey(options.key, options.algorithm, 'sign');
  const signature = await crypto.subtle.sign(ALGORITHMS[options.algorithm].sign, key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyJwt<TPayload extends JwtPayload = JwtPayload>(token: string, options: VerifyJwtOptions): Promise<TPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('malformed', 'Token must have three parts');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = decodeJson<{ alg?: string; crit?: unknown }>(encodedHeader, 'header');
  const algorithm = header.alg as JwtAlgorithm | undefined;
  if (!algorithm || !(algorithm in ALGORITHMS) || !options.algorithms.includes(algorithm)) {
    throw new JwtError('algorithm', `Algorithm ${String(header.alg)} is not allowed`);
  }
  if (header.crit !== undefined) {
    throw new JwtError('malformed', 'Unsupported critical header parameters');
  }

  const key = await importKey(options.key, algorithm, 'verify');
  const valid = await crypto.subtle.verify(
    ALGORITHMS[algorithm].sign,
    key,
    base64UrlDecode(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  ).catch(() => false);
  if (!valid) {
    throw new JwtError('signature', 'Invalid signature');
  }

  const payload = decodeJson<TPayload>(encodedPayload, 'payload');
  validateClaims(payload, options);
  return payload;
}

function validateClaims(payload: JwtPayload, options: VerifyJwtOptions) {
  const now = Math.floor(options.now?.() ?? Date.now() / 1000);
  const tolerance = options.clockToleranceSec ?? 0;
  for (const claim of options.requiredClaims ?? ['exp']) {
    if (payload[claim] === undefined) {
      throw new JwtError('claim', `Missing required claim "${claim}"`);
    }
  }
  if (payload.exp !== undefined && (typeof payload.exp !== 'number' || now - tolerance >= payload.exp)) {
    throw new JwtError('expired', 'Token has expired');
  }
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || now + tolerance < payload.nbf)) {
    throw new JwtError('not-yet-valid', 'Token is not valid yet');
  }
  if (options.maxAgeSec !== undefined) {
    if (typeof payload.iat !== 'number' || now - tolerance > payload.iat + options.maxAgeSec) {
      throw new JwtError('expired', 'Token is too old');
    }
  }
  if (options.issuer !== undefined) {
    const issuers = typeof options.issuer === 'string' ? [options.issuer] : options.issuer;
    if (typeof payload.iss !== 'string' || !issuers.includes(payload.iss)) {
      throw new JwtError('claim', 'Unexpected issuer');
    }
  }
  if (options.audience !== undefined) {
    const expected = typeof options.audience === 'string' ? [options.audience] : options.audience;
    const actual = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
    if (!actual.some((audience) => expected.includes(audience))) {
      throw new JwtError('claim', 'Unexpected audience');
    }
  }
  if (options.subject !== undefined && payload.sub !== options.subject) {
    throw new JwtError('claim', 'Unexpected subject');
  }
}

export interface JwtGuardOptions extends VerifyJwtOptions {
  /** Where to read the token. Default: `Authorization: Bearer <token>`. */
  getToken?: (request: Request, context: RequestContext) => string | null | undefined;
  /** Also accept the token from this cookie when there is no Authorization header. */
  cookie?: string;
  /** Extra check on the verified payload (roles, scopes...). Return false to reject with 403. */
  authorize?: (payload: JwtPayload, context: RequestContext) => boolean | Promise<boolean>;
}

const PAYLOAD_KEY = 'kivin.jwt.payload';

/**
 * Guard class that requires a valid JWT. Missing or invalid tokens get `401` with a
 * `WWW-Authenticate: Bearer` header; a failed `authorize` check gets `403`. The verified payload is
 * available to the handler through `getJwtPayload(context)`.
 */
export function createJwtGuard(options: JwtGuardOptions) {
  return class JwtGuard implements CanActivate {
    async canActivate(context: RequestContext) {
      const token = options.getToken?.(context.request, context) ?? readBearerToken(context.request) ?? (options.cookie ? context.cookie(options.cookie) : undefined);
      if (!token) {
        throw unauthorized('Missing bearer token', { headers: { 'www-authenticate': 'Bearer' } });
      }

      let payload: JwtPayload;
      try {
        payload = await verifyJwt(token, options);
      } catch (error) {
        const reason = error instanceof JwtError ? error.code : 'invalid';
        throw unauthorized('Invalid token', { headers: { 'www-authenticate': `Bearer error="invalid_token", error_description="${reason}"` } });
      }

      context.set(PAYLOAD_KEY, payload);
      return options.authorize ? options.authorize(payload, context) : true;
    }
  };
}

/** The payload a `createJwtGuard` guard verified for this request. */
export function getJwtPayload<TPayload extends JwtPayload = JwtPayload>(context: RequestContext): TPayload | undefined {
  return context.get<TPayload>(PAYLOAD_KEY);
}

function readBearerToken(request: Request) {
  const header = request.headers.get('authorization');
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

function decodeJson<T>(segment: string, label: string): T {
  try {
    const value = JSON.parse(decoder.decode(base64UrlDecode(segment))) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value as T;
  } catch {
    throw new JwtError('malformed', `Invalid token ${label}`);
  }
}

function base64UrlEncodeJson(value: unknown) {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlDecode(segment: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new JwtError('malformed', 'Invalid base64url');
  }
  return new Uint8Array(Buffer.from(segment, 'base64url'));
}
