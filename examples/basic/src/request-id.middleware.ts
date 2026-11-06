import type { NestLikeMiddleware, RequestContext } from '@kivinjs/core';
import { Injectable } from '@kivinjs/decorators';

@Injectable()
export class RequestIdMiddleware implements NestLikeMiddleware {
  handle(context: RequestContext, next: () => Promise<Response>) {
    const requestId = context.request.headers.get('x-request-id') ?? crypto.randomUUID();
    context.set('requestId', requestId);
    context.setResponseHeader('x-request-id', requestId);
    return next();
  }
}
