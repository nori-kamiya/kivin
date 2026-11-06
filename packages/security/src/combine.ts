// Guard combinators (equivalent of Hono's `some` from the combine middleware).
import { forbidden, getInjectableMetadata, HttpError, type CanActivate, type ManifestRoute, type RequestContext } from '@kivin/core';

type GuardClass = new () => CanActivate;

/**
 * A guard that passes when **any** of `guards` passes, e.g. Bearer token *or* Basic auth. They are
 * tried in order and the first that allows wins. When all refuse, the first refusal that is an
 * `HttpError` is thrown (so a `401` with `WWW-Authenticate` from an auth guard survives), otherwise
 * `403`.
 *
 * The guards are created here, so they must not have constructor dependencies (the guards from
 * `@kivin/security` / `@kivin/jwt` factories have none). Guards that are all raw-capable keep the
 * context-free fast path.
 *
 * ```ts
 * @UseGuards(anyGuard(createBearerAuthGuard({ tokens: [apiKey] }), createBasicAuthGuard({ users: { admin: password } })))
 * ```
 */
export function anyGuard(...guards: GuardClass[]) {
  if (guards.length < 2) {
    throw new TypeError('anyGuard: give at least two guards');
  }
  for (const guard of guards) {
    if (getInjectableMetadata(guard).deps.length > 0) {
      throw new TypeError(`anyGuard: ${guard.name || 'a guard'} has constructor dependencies; compose it in your own guard instead`);
    }
  }
  const instances = guards.map((Guard) => new Guard());
  const allRaw = instances.every((guard) => typeof guard.canActivateRaw === 'function');

  const decide = async (attempt: (guard: CanActivate) => boolean | Promise<boolean>) => {
    let refusal: unknown;
    for (const guard of instances) {
      try {
        if (await attempt(guard)) {
          return true;
        }
      } catch (error) {
        refusal ??= error;
      }
    }
    if (refusal instanceof HttpError) {
      throw refusal;
    }
    if (refusal !== undefined && !(refusal instanceof Response)) {
      // An unexpected error from a guard is not a refusal: let it surface (500).
      throw refusal;
    }
    throw refusal ?? forbidden();
  };

  class AnyGuard implements CanActivate {
    canActivate(context: RequestContext, route?: ManifestRoute<unknown>) {
      return decide((guard) => guard.canActivate(context, route as ManifestRoute<unknown>));
    }
  }

  if (allRaw) {
    Object.defineProperty(AnyGuard.prototype, 'canActivateRaw', {
      value(request: Request, params: Record<string, string>, route: ManifestRoute<unknown>) {
        return decide((guard) => guard.canActivateRaw!(request, params, route));
      },
    });
  }
  return AnyGuard;
}
