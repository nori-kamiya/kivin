// Guard combinators (equivalent of Hono's `some` / `every` / `except` from the combine middleware).
import { forbidden, getInjectableMetadata, setInjectableMetadata, type CanActivate, type ManifestRoute, type RequestContext } from '@kivinjs/core';

/** A guard class. Constructor dependencies (`@Injectable({ deps })`) are injected by the app. */
export type GuardClass = new (...args: never[]) => CanActivate;

/**
 * The class `anyGuard` / `everyGuard` / `exceptGuard` return. The app's container passes the composed
 * guards to the constructor; `new Combined()` outside an app creates guards without dependencies.
 */
export type ComposedGuardClass = new (...guards: CanActivate[]) => CanActivate;

/**
 * Routes a guard is skipped on: route templates (`route.fullPath`, including `basePath`) such as
 * `'/health'` or `'/public/*'` (the prefix and everything under it), or a predicate.
 */
export type GuardExemption = string | readonly string[] | ((request: Request, route: ManifestRoute<unknown>) => boolean);

type Verdict = boolean | Promise<boolean>;
type Attempt = (guard: CanActivate) => Verdict;
type Decide = (guards: readonly CanActivate[], attempt: Attempt, request: Request, route: ManifestRoute<unknown>) => Verdict;

const isPromiseLike = (value: unknown): value is PromiseLike<boolean> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

/**
 * A guard that passes when **any** of `guards` passes, e.g. Bearer token *or* Basic auth. They are
 * tried in order and the first that allows wins. When all refuse, the first refusal that was thrown
 * is rethrown (so a `401` with `WWW-Authenticate` from an auth guard survives), otherwise `403`.
 *
 * The composed guards are created by the app's container, so they may have constructor dependencies
 * (`@Injectable({ deps })`) and need not be listed in a module's `providers`. Guards that are all
 * raw-capable keep the context-free fast path, and the check stays synchronous while they answer
 * synchronously.
 *
 * ```ts
 * @UseGuards(anyGuard(createBearerAuthGuard({ tokens: [apiKey] }), createBasicAuthGuard({ users: { admin: password } })))
 * ```
 */
export function anyGuard(...guards: GuardClass[]): ComposedGuardClass {
  if (guards.length < 2) {
    throw new TypeError('anyGuard: give at least two guards');
  }
  return composeGuards('anyGuard', guards, (instances, attempt) => passesAny(instances, attempt, 0, undefined));
}

/**
 * A guard that passes when **all** of `guards` pass, in order (the first refusal wins). Listing
 * guards in `@UseGuards(A, B)` already means "all"; this is for nesting, e.g.
 * `anyGuard(everyGuard(SessionGuard, CsrfGuard), BearerGuard)`.
 */
export function everyGuard(...guards: GuardClass[]): ComposedGuardClass {
  if (guards.length < 2) {
    throw new TypeError('everyGuard: give at least two guards');
  }
  return composeGuards('everyGuard', guards, (instances, attempt) => passesEvery(instances, attempt, 0));
}

/**
 * Runs `guards` (all must pass) except on the routes `exempt` matches, e.g. an app-wide auth guard
 * that skips the health check and public pages:
 *
 * ```ts
 * defineApplication({ ..., globals: { guards: [exceptGuard(['/health', '/public/*'], ApiKeyGuard)] } });
 * ```
 *
 * Path patterns are matched against the route template once per route (no per-request cost). A
 * predicate runs on every request.
 */
export function exceptGuard(exempt: GuardExemption, ...guards: GuardClass[]): ComposedGuardClass {
  if (guards.length < 1) {
    throw new TypeError('exceptGuard: give at least one guard');
  }
  const isExempt = createExemption(exempt);
  return composeGuards('exceptGuard', guards, (instances, attempt, request, route) => isExempt(request, route) ? true : passesEvery(instances, attempt, 0));
}

function composeGuards(kind: string, guards: readonly GuardClass[], decide: Decide): ComposedGuardClass {
  for (const guard of guards) {
    if (typeof guard !== 'function') {
      throw new TypeError(`${kind}: every guard must be a class`);
    }
  }

  class ComposedGuard implements CanActivate {
    declare readonly canActivateRaw?: (request: Request, params: Record<string, string>, route: ManifestRoute<unknown>) => Verdict;
    private readonly guards: readonly CanActivate[];

    constructor(...instances: CanActivate[]) {
      // The app's container passes the composed guards (with their own dependencies). Outside an app,
      // `new Guard()` creates them itself, which only works for guards without dependencies.
      this.guards = instances.length > 0 ? instances : guards.map((guard) => instantiateStandalone(kind, guard));
      for (const [index, guard] of this.guards.entries()) {
        if (typeof guard?.canActivate !== 'function') {
          throw new TypeError(`${kind}: ${guards[index]?.name || 'a guard'} must implement canActivate(context, route)`);
        }
      }
      const composed = this.guards;
      if (composed.every((guard) => typeof guard.canActivateRaw === 'function')) {
        // Not `async`: the executor awaits only when a promise comes back.
        this.canActivateRaw = (request, params, route) => decide(composed, (guard) => guard.canActivateRaw!(request, params, route), request, route);
      }
    }

    canActivate(context: RequestContext, route: ManifestRoute<unknown>): Verdict {
      return decide(this.guards, (guard) => guard.canActivate(context, route), context.request, route);
    }
  }

  Object.defineProperty(ComposedGuard, 'name', { value: `${kind}(${guards.map((guard) => guard.name || 'Guard').join(', ')})` });
  // The app registers the composed classes and injects their instances (see `composesEnhancers`).
  setInjectableMetadata(ComposedGuard, { deps: [...guards], composesEnhancers: true });
  return ComposedGuard;
}

function instantiateStandalone(kind: string, Guard: GuardClass): CanActivate {
  if (getInjectableMetadata(Guard).deps.length > 0) {
    throw new TypeError(`${kind}: ${Guard.name || 'a guard'} has constructor dependencies; let the app create the combined guard (use it in @UseGuards / globals) instead of calling new`);
  }
  return new (Guard as new () => CanActivate)();
}

/** Synchronous while the guards answer synchronously; continues on a promise from the first async one. */
function passesAny(guards: readonly CanActivate[], attempt: Attempt, start: number, refusal: unknown): Verdict {
  for (let index = start; index < guards.length; index += 1) {
    let allowed: Verdict;
    try {
      allowed = attempt(guards[index]!);
    } catch (error) {
      refusal ??= error;
      continue;
    }
    if (isPromiseLike(allowed)) {
      const firstRefusal = refusal;
      return Promise.resolve(allowed).then(
        (resolved) => (resolved ? true : passesAny(guards, attempt, index + 1, firstRefusal)),
        (error: unknown) => passesAny(guards, attempt, index + 1, firstRefusal ?? error),
      );
    }
    if (allowed) {
      return true;
    }
  }
  // An HttpError (e.g. 401 with WWW-Authenticate) or a Response is answered as is; an unexpected
  // error surfaces as a 500.
  throw refusal ?? forbidden();
}

function passesEvery(guards: readonly CanActivate[], attempt: Attempt, start: number): Verdict {
  for (let index = start; index < guards.length; index += 1) {
    const allowed = attempt(guards[index]!);
    if (isPromiseLike(allowed)) {
      return Promise.resolve(allowed).then((resolved) => (resolved ? passesEvery(guards, attempt, index + 1) : false));
    }
    if (!allowed) {
      return false;
    }
  }
  return true;
}

function createExemption(exempt: GuardExemption): (request: Request, route: ManifestRoute<unknown>) => boolean {
  if (typeof exempt === 'function') {
    return exempt;
  }
  const matchers = (typeof exempt === 'string' ? [exempt] : [...exempt]).map(compilePattern);
  const decided = new WeakMap<object, boolean>();
  return (_request, route) => {
    let skip = decided.get(route);
    if (skip === undefined) {
      const path = trimTrailingSlash(route.fullPath);
      skip = matchers.some((matches) => matches(path));
      decided.set(route, skip);
    }
    return skip;
  };
}

function compilePattern(pattern: string): (path: string) => boolean {
  if (pattern === '*' || pattern === '/*') {
    return () => true;
  }
  if (!pattern.startsWith('/')) {
    throw new TypeError(`exceptGuard: path patterns start with "/" (got "${pattern}")`);
  }
  if (pattern.endsWith('/*')) {
    const prefix = trimTrailingSlash(pattern.slice(0, -2));
    return (path) => path === prefix || path.startsWith(`${prefix}/`);
  }
  if (pattern.includes('*')) {
    throw new TypeError(`exceptGuard: "*" is only allowed at the end ("/public/*"), got "${pattern}"`);
  }
  const exact = trimTrailingSlash(pattern);
  return (path) => path === exact;
}

function trimTrailingSlash(path: string) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
