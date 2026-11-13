import type { ManifestRoute } from './app';
import type { RequestContext, ResponseState } from './context';

export interface CanActivate<TSchema = unknown> {
  canActivateRaw?(request: Request, params: Record<string, string>, route: ManifestRoute<TSchema>): boolean | Promise<boolean>;
  canActivate(context: RequestContext, route: ManifestRoute<TSchema>): boolean | Promise<boolean>;
}

export interface NestLikeMiddleware<TSchema = unknown> {
  handle(context: RequestContext, next: () => Response | PromiseLike<Response>, route: ManifestRoute<TSchema>): Response | PromiseLike<Response>;
  handleRaw?(request: Request, params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>, route: ManifestRoute<TSchema>): Response | PromiseLike<Response>;
  /**
   * Optional, global middleware only: called with the response of a request that reached no route —
   * 404, 405, an automatic `OPTIONS` / CORS preflight answer, or a response an `onRequest` hook returned
   * — so metrics or logs can count it. Return a `Response` to replace it. Errors are logged and ignored.
   */
  handleUnmatched?(request: Request, response: Response): Response | void;
}

export interface HonoLikeMiddleware<TSchema = unknown> {
  use(context: RequestContext, next: () => Response | PromiseLike<Response>, route: ManifestRoute<TSchema>): Response | PromiseLike<Response>;
  useRaw?(request: Request, params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>, route: ManifestRoute<TSchema>): Response | PromiseLike<Response>;
  /** See `NestLikeMiddleware.handleUnmatched`. */
  handleUnmatched?(request: Request, response: Response): Response | void;
}

export interface ExceptionFilter<TSchema = unknown> {
  catch(error: unknown, context: RequestContext, route: ManifestRoute<TSchema>): Response | void | Promise<Response | void>;
}
