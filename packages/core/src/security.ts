import type { NestLikeMiddleware } from './runtime-types';

const DEFAULT_SECURITY_HEADERS = Object.freeze({
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const);

export interface SecureHeadersOptions {
  contentSecurityPolicy?: string | null;
  frameOptions?: string | null;
  referrerPolicy?: string | null;
  contentTypeOptions?: string | null;
  headers?: Record<string, string | null | undefined>;
}

function normalizeSecureHeaders(options: SecureHeadersOptions = {}) {
  return {
    ...DEFAULT_SECURITY_HEADERS,
    ...(options.referrerPolicy === undefined ? {} : { 'referrer-policy': options.referrerPolicy }),
    ...(options.contentTypeOptions === undefined ? {} : { 'x-content-type-options': options.contentTypeOptions }),
    ...(options.frameOptions === undefined ? {} : { 'x-frame-options': options.frameOptions }),
    ...(options.contentSecurityPolicy === undefined ? {} : { 'content-security-policy': options.contentSecurityPolicy }),
    ...(options.headers ?? {}),
  } as Record<string, string | null | undefined>;
}

function applySecurityHeaders(response: Response, headers: Record<string, string | null | undefined>) {
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) {
      response.headers.delete(name);
      continue;
    }

    if (!response.headers.has(name)) {
      response.headers.set(name, value);
    }
  }
}

export class SecureHeadersMiddleware implements NestLikeMiddleware {
  protected readonly headers = normalizeSecureHeaders();

  async handle(_context: import('./context').RequestContext, next: () => Promise<Response>) {
    const response = await next();

    applySecurityHeaders(response, this.headers);
    return response;
  }
}

export function createSecureHeadersMiddleware(options: SecureHeadersOptions = {}) {
  const headers = normalizeSecureHeaders(options);

  return class ConfiguredSecureHeadersMiddleware implements NestLikeMiddleware {
    async handle(_context: import('./context').RequestContext, next: () => Promise<Response>) {
      const response = await next();
      applySecurityHeaders(response, headers);
      return response;
    }
  };
}