import type { ManifestRoute } from './app';
import type { RequestContext, ResponseState } from './context';

export interface CanActivate<TSchema = unknown> {
  canActivateRaw?(request: Request, params: Record<string, string>, route: ManifestRoute<TSchema>): boolean | Promise<boolean>;
  canActivate(context: RequestContext, route: ManifestRoute<TSchema>): boolean | Promise<boolean>;
}

export interface NestLikeMiddleware<TSchema = unknown> {
  handle(context: RequestContext, next: () => Response | PromiseLike<Response>, route: ManifestRoute<TSchema>): Response | PromiseLike<Response>;
  handleRaw?(request: Request, params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>, route: ManifestRoute<TSchema>): Response | PromiseLike<Response>;
}

export interface HonoLikeMiddleware<TSchema = unknown> {
  use(context: RequestContext, next: () => Response | PromiseLike<Response>, route: ManifestRoute<TSchema>): Response | PromiseLike<Response>;
  useRaw?(request: Request, params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>, route: ManifestRoute<TSchema>): Response | PromiseLike<Response>;
}

export interface ExceptionFilter<TSchema = unknown> {
  catch(error: unknown, context: RequestContext, route: ManifestRoute<TSchema>): Response | void | Promise<Response | void>;
}
