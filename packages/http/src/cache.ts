// Shared response cache (Hono's `cache`). Bun has no Web Cache API, so entries live in a pluggable
// store. Anything that could be per-user is left uncached by default: a response must never reach a
// user it was not made for.
import type { NestLikeMiddleware, RequestContext } from '@kivinjs/core';

/** A cached response, or the `Vary` header names recorded for a URL. */
export type CacheRecord =
  | { kind: 'vary'; names: string[] }
  | { kind: 'response'; status: number; statusText: string; headers: Array<[string, string]>; body: Uint8Array<ArrayBuffer>; storedAt: number };

export interface ResponseCacheStore {
  get(key: string): CacheRecord | undefined | Promise<CacheRecord | undefined>;
  /** Stores `record` for `ttlMs` and files `key` under each tag (for `deleteTag`). */
  set(key: string, record: CacheRecord, ttlMs: number, tags: readonly string[]): void | Promise<void>;
  /** Removes every key filed under `tag`. */
  deleteTag(tag: string): void | Promise<void>;
}

export interface MemoryCacheStoreOptions {
  /** Most entries kept; the least recently used go first. Default 1000. */
  maxEntries?: number;
  /** Most body bytes kept in total. Default 64 MiB. */
  maxBytes?: number;
}

interface MemoryEntry {
  record: CacheRecord;
  expiresAt: number;
  tags: readonly string[];
  bytes: number;
}

/** A per-process LRU store with entry and size limits. */
export class MemoryCacheStore implements ResponseCacheStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly tagged = new Map<string, Set<string>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(options: MemoryCacheStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  }

  get(key: string): CacheRecord | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.remove(key);
      return undefined;
    }
    // Re-insert: Map order is the recency order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.record;
  }

  set(key: string, record: CacheRecord, ttlMs: number, tags: readonly string[]) {
    this.remove(key);
    const bytes = record.kind === 'response' ? record.body.byteLength : 0;
    if (ttlMs <= 0 || bytes > this.maxBytes) {
      return;
    }
    this.entries.set(key, { record, expiresAt: Date.now() + ttlMs, tags, bytes });
    this.bytes += bytes;
    for (const tag of tags) {
      let keys = this.tagged.get(tag);
      if (!keys) {
        keys = new Set();
        this.tagged.set(tag, keys);
      }
      keys.add(key);
    }
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) {
        break;
      }
      this.remove(oldest);
    }
  }

  deleteTag(tag: string) {
    for (const key of this.tagged.get(tag) ?? []) {
      this.remove(key);
    }
    this.tagged.delete(tag);
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    for (const tag of entry.tags) {
      const keys = this.tagged.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) {
        this.tagged.delete(tag);
      }
    }
  }
}

export interface CacheOptions {
  /** Seconds to keep a response, overriding its `Cache-Control` (`s-maxage`, then `max-age`). */
  ttl?: number;
  /** Tags to invalidate the response by, e.g. `['users']` or `(request) => [...]`. */
  tags?: readonly string[] | ((request: Request, response: Response) => readonly string[]);
  /** Statuses to cache. Default `[200]`. */
  statuses?: readonly number[];
  /** Largest body to cache, in bytes. Default 1 MiB. */
  maxSize?: number;
  /**
   * Request headers that split entries in addition to the response's `Vary`, for headers the
   * response is varied on outside this middleware (e.g. `['accept-language']` with `@kivinjs/i18n`).
   */
  vary?: readonly string[];
}

export interface ResponseCacheOptions {
  store?: ResponseCacheStore;
  /** Cache key of a request (default its full URL). Requests with equal keys share entries. */
  key?: (request: Request) => string;
  /** Adds `<name>: HIT | MISS` to responses the cache handled, e.g. `'x-cache'`. Default off. */
  statusHeader?: string;
}

const KEY_TAG = '\0key:';
const STREAMING = /^text\/event-stream|^application\/(x-ndjson|jsonl)/i;

function cacheControl(header: string | null) {
  const directives = new Map<string, string | undefined>();
  for (const part of (header ?? '').split(',')) {
    const [name, value] = part.split('=') as [string, string | undefined];
    if (name.trim()) {
      directives.set(name.trim().toLowerCase(), value?.trim().replace(/^"|"$/g, ''));
    }
  }
  return directives;
}

function seconds(value: string | undefined) {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function varyNames(response: Response, extra: readonly string[]): string[] | '*' {
  const names = [...(response.headers.get('vary') ?? '').split(','), ...extra].map((name) => name.trim().toLowerCase()).filter(Boolean);
  return names.includes('*') ? '*' : [...new Set(names)].sort();
}

function variantKey(base: string, names: readonly string[], request: Request) {
  if (names.length === 0) {
    return `${base}\0`;
  }
  return `${base}\0${JSON.stringify(names.map((name) => request.headers.get(name)))}`;
}

function matchesIfNoneMatch(header: string | null, etag: string) {
  if (header === null) {
    return false;
  }
  const opaque = etag.replace(/^W\//, '');
  return header.trim() === '*' || header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === opaque);
}

/**
 * A shared response cache:
 *
 * ```ts
 * const cache = createResponseCache({ store: new RedisCacheStore(new RedisClient(url)) });
 * @UseMiddleware(cache.middleware({ ttl: 60, tags: ['products'] }))
 * …
 * await cache.invalidateTag('products');
 * ```
 *
 * Only GET responses are stored (HEAD is answered from them). Requests with `Authorization` or
 * `Cookie`, and responses with `Set-Cookie`, `Cache-Control: private | no-store | no-cache` or
 * `Vary: *`, are never cached. Entries are split by the response's `Vary` headers.
 */
export function createResponseCache(options: ResponseCacheOptions = {}) {
  const store = options.store ?? new MemoryCacheStore();
  const keyOf = options.key ?? ((request: Request) => request.url);
  const statusHeader = options.statusHeader;

  const mark = (response: Response, status: 'HIT' | 'MISS') => {
    if (statusHeader) {
      response.headers.set(statusHeader, status);
    }
    return response;
  };

  const answer = (request: Request, record: Extract<CacheRecord, { kind: 'response' }>) => {
    const headers = new Headers(record.headers);
    headers.set('age', String(Math.max(0, Math.floor((Date.now() - record.storedAt) / 1000))));
    const etag = headers.get('etag');
    if (etag && matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
      headers.delete('content-length');
      headers.delete('content-type');
      return mark(new Response(null, { status: 304, headers }), 'HIT');
    }
    const body = request.method === 'HEAD' ? null : record.body;
    return mark(new Response(body, { status: record.status, statusText: record.statusText, headers }), 'HIT');
  };

  const middleware = (cacheOptions: CacheOptions = {}) => {
    const statuses = new Set(cacheOptions.statuses ?? [200]);
    const maxSize = cacheOptions.maxSize ?? 1024 * 1024;

    const ttlOf = (response: Response) => {
      if (cacheOptions.ttl !== undefined) {
        return cacheOptions.ttl;
      }
      const directives = cacheControl(response.headers.get('cache-control'));
      return seconds(directives.get('s-maxage')) ?? seconds(directives.get('max-age'));
    };

    const store$ = async (request: Request, base: string, response: Response): Promise<Response> => {
      if (request.method !== 'GET' || !statuses.has(response.status) || response.body === null || response.headers.has('set-cookie')) {
        return response;
      }
      const directives = cacheControl(response.headers.get('cache-control'));
      if (directives.has('private') || directives.has('no-store') || directives.has('no-cache')) {
        return response;
      }
      if (STREAMING.test(response.headers.get('content-type') ?? '')) {
        return response;
      }
      const vary = varyNames(response, cacheOptions.vary ?? []);
      const ttl = ttlOf(response);
      const knownLength = Number(response.headers.get('content-length') ?? 0);
      if (vary === '*' || ttl === undefined || ttl <= 0 || knownLength > maxSize) {
        return response;
      }
      const body = new Uint8Array(await response.arrayBuffer());
      const copy = new Response(body, response);
      if (body.byteLength > maxSize) {
        return copy;
      }
      const tags = typeof cacheOptions.tags === 'function' ? cacheOptions.tags(request, copy) : cacheOptions.tags ?? [];
      const headers = [...copy.headers].filter(([name]) => name !== 'age' && name !== statusHeader);
      const ttlMs = ttl * 1000;
      const allTags = [`${KEY_TAG}${base}`, ...tags];
      await store.set(base, { kind: 'vary', names: vary }, ttlMs, allTags);
      await store.set(variantKey(base, vary, request), { kind: 'response', status: copy.status, statusText: copy.statusText, headers, body, storedAt: Date.now() }, ttlMs, allTags);
      return mark(copy, 'MISS');
    };

    const run = async (request: Request, next: () => Response | PromiseLike<Response>) => {
      if ((request.method !== 'GET' && request.method !== 'HEAD') || request.headers.has('authorization') || request.headers.has('cookie')) {
        return next();
      }
      const base = keyOf(request);
      const vary = await store.get(base);
      if (vary?.kind === 'vary') {
        const record = await store.get(variantKey(base, vary.names, request));
        if (record?.kind === 'response') {
          return answer(request, record);
        }
      }
      return store$(request, base, await next());
    };

    return class ResponseCacheMiddleware implements NestLikeMiddleware {
      handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
        return run(context.request, next);
      }

      handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
        return run(request, next);
      }
    };
  };

  return {
    /** Middleware caching the routes it is applied to (`@UseMiddleware(...)` or app middleware). */
    middleware,
    /** Drops every cached variant of a URL (or of the key `options.key` gives for it). */
    invalidate: async (target: string | Request) => {
      await store.deleteTag(`${KEY_TAG}${typeof target === 'string' ? target : keyOf(target)}`);
    },
    /** Drops every response cached with `tag`. */
    invalidateTag: async (tag: string) => {
      await store.deleteTag(tag);
    },
  };
}
