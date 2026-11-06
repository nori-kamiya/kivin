// @kivinjs/session: server-side sessions with a signed session-ID cookie and pluggable stores.
import { parseCookies, serializeCookie, serializeDeletedCookie, signCookieValue, verifyCookieValue, type CookieOptions, type CookieSecrets, type NestLikeMiddleware, type RequestContext } from '@kivinjs/core';

export type SessionData = Record<string, unknown>;

/** Where sessions live. Implement it for Redis, a database, … (methods may be sync or async). */
export interface SessionStore {
  get(id: string): SessionData | undefined | Promise<SessionData | undefined>;
  /** Saves `data` for `ttlSeconds`. */
  set(id: string, data: SessionData, ttlSeconds: number): void | Promise<void>;
  delete(id: string): void | Promise<void>;
  /** Extends the lifetime without rewriting the data (rolling sessions). Optional: `set` is used otherwise. */
  touch?(id: string, data: SessionData, ttlSeconds: number): void | Promise<void>;
}

/**
 * In-memory store: for development, tests and single-instance apps (sessions are lost on restart and
 * not shared between processes). Expired entries are dropped on access and by a periodic sweep.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, { data: string; expiresAt: number }>();
  private lastSweep = Date.now();

  constructor(private readonly options: { sweepIntervalMs?: number } = {}) {}

  get(id: string) {
    const entry = this.sessions.get(id);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    // Stored as JSON so callers never share mutable objects with the store (as with a real backend).
    return JSON.parse(entry.data) as SessionData;
  }

  set(id: string, data: SessionData, ttlSeconds: number) {
    this.sweep();
    this.sessions.set(id, { data: JSON.stringify(data), expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  touch(id: string, _data: SessionData, ttlSeconds: number) {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.expiresAt = Date.now() + ttlSeconds * 1000;
    }
  }

  delete(id: string) {
    this.sessions.delete(id);
  }

  /** Number of live sessions (for tests / metrics). */
  get size() {
    this.sweep(true);
    return this.sessions.size;
  }

  private sweep(force = false) {
    const now = Date.now();
    if (!force && now - this.lastSweep < (this.options.sweepIntervalMs ?? 60_000)) {
      return;
    }
    this.lastSweep = now;
    for (const [id, entry] of this.sessions) {
      if (entry.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }
}

/** The session of one request. Reads are synchronous (loaded before the handler runs). */
export class Session<TData extends SessionData = SessionData> {
  /** @internal */ dirty = false;
  /** @internal */ destroyed = false;
  /** @internal */ regenerated = false;

  /** @internal */
  constructor(
    // `undefined` for a new session until the ID is needed: anonymous requests that never set
    // anything do not pay for generating one.
    private currentId: string | undefined,
    private data: Partial<TData>,
    /** Whether the session existed in the store before this request. */
    readonly isNew: boolean,
  ) {}

  get id(): string {
    return (this.currentId ??= newSessionId());
  }

  get<K extends keyof TData & string>(key: K): TData[K] | undefined {
    return this.data[key];
  }

  set<K extends keyof TData & string>(key: K, value: TData[K]) {
    this.data[key] = value;
    this.dirty = true;
  }

  delete(key: keyof TData & string) {
    if (key in this.data) {
      delete this.data[key];
      this.dirty = true;
    }
  }

  has(key: keyof TData & string) {
    return key in this.data;
  }

  /** A copy of all values. */
  all(): Partial<TData> {
    return { ...this.data };
  }

  /**
   * Moves the data to a new session ID (the old one is deleted). Call it after login or a privilege
   * change so an ID planted before authentication (session fixation) becomes useless.
   */
  regenerate() {
    this.currentId = newSessionId();
    this.regenerated = true;
    this.dirty = true;
  }

  /** Deletes the session and clears the cookie. */
  destroy() {
    this.data = {};
    this.destroyed = true;
  }

  /** @internal */
  snapshot() {
    return this.data as SessionData;
  }
}

export interface SessionOptions {
  /** Secret(s) signing the session-ID cookie; an array rotates keys (sign with the first). */
  secret: CookieSecrets;
  /** Default: a `MemorySessionStore`. */
  store?: SessionStore;
  /** Cookie name. Default `sid`. */
  name?: string;
  /** Session lifetime in seconds (store TTL and cookie Max-Age). Default 86400 (one day). */
  ttl?: number;
  /** Renew the lifetime on every request that has a session (the cookie is re-sent). Default false. */
  rolling?: boolean;
  /** Cookie attributes. Default `{ httpOnly: true, sameSite: 'Lax', path: '/' }` (+ `secure` behind HTTPS: set it). */
  cookie?: Omit<CookieOptions, 'maxAge' | 'expires'>;
}

const sessions = new WeakMap<Request, Session>();

function newSessionId() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/**
 * The session of a request (`context.request` or the raw request). Throws when the session middleware
 * did not run for this request.
 */
export function getSession<TData extends SessionData = SessionData>(request: Request): Session<TData> {
  const session = sessions.get(request);
  if (!session) {
    throw new Error('getSession: no session for this request; add createSessionMiddleware(...) to the route or app middleware');
  }
  return session as unknown as Session<TData>;
}

/**
 * Loads the session named by a signed cookie before the route runs and saves it afterwards (only
 * when changed, unless `rolling`). New sessions are stored and get a cookie only once something is
 * set, so anonymous traffic creates no sessions.
 *
 * ```ts
 * const Sessions = createSessionMiddleware({ secret: process.env.SESSION_SECRET!, cookie: { secure: true } });
 * defineApplication({ ..., globals: { middleware: [Sessions] } });
 *
 * login({ context, body }: RouteInput<…>) {
 *   const session = getSession(context.request);
 *   session.regenerate();
 *   session.set('userId', user.id);
 * }
 * ```
 */
export function createSessionMiddleware(options: SessionOptions) {
  const store = options.store ?? new MemorySessionStore();
  const name = options.name ?? 'sid';
  const ttl = options.ttl ?? 86_400;
  const cookieOptions: CookieOptions = { httpOnly: true, sameSite: 'Lax', path: '/', ...options.cookie, maxAge: ttl };
  const deletion = { ...(cookieOptions.domain ? { domain: cookieOptions.domain } : {}), ...(cookieOptions.path ? { path: cookieOptions.path } : {}), ...(cookieOptions.secure ? { secure: true } : {}), ...(cookieOptions.sameSite ? { sameSite: cookieOptions.sameSite } : {}) };

  const load = async (request: Request) => {
    const signed = parseCookies(request.headers.get('cookie'))[name];
    const id = signed === undefined ? false : await verifyCookieValue(name, signed, options.secret);
    if (id) {
      const data = await store.get(id);
      if (data) {
        return new Session(id, data, false);
      }
    }
    // No cookie, a forged / stale one, or an expired session: a fresh ID (never the client's).
    return new Session(undefined, {}, true);
  };

  const save = async (session: Session, originalId: string): Promise<string | undefined> => {
    if (session.destroyed) {
      if (!session.isNew) {
        await store.delete(originalId);
      }
      return session.isNew ? undefined : serializeDeletedCookie(name, deletion);
    }
    if (session.regenerated && !session.isNew) {
      await store.delete(originalId);
    }
    const data = session.snapshot();
    const hasData = Object.keys(data).length > 0;
    if (session.dirty) {
      if (session.isNew && !hasData) {
        return undefined;
      }
      await store.set(session.id, data, ttl);
    } else if (options.rolling && !session.isNew) {
      await (store.touch ? store.touch(session.id, data, ttl) : store.set(session.id, data, ttl));
    } else {
      return undefined;
    }
    return serializeCookie(name, await signCookieValue(name, session.id, options.secret), cookieOptions);
  };

  const run = async (request: Request, next: () => Response | PromiseLike<Response>) => {
    const session = await load(request);
    // Only an existing session has an ID to delete on regenerate / destroy.
    const originalId = session.isNew ? '' : session.id;
    sessions.set(request, session);
    const response = await next();
    const cookie = await save(session, originalId);
    if (cookie === undefined) {
      return response;
    }
    try {
      response.headers.append('set-cookie', cookie);
      return response;
    } catch {
      const copy = new Response(response.body, response);
      copy.headers.append('set-cookie', cookie);
      return copy;
    }
  };

  return class SessionMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      return run(context.request, next);
    }

    handleRaw(request: Request, _params: Record<string, string>, _state: unknown, next: () => Response | PromiseLike<Response>) {
      return run(request, next);
    }
  };
}
