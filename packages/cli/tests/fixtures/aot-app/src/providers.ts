import { HttpError, type CanActivate, type ExceptionFilter, type NestLikeMiddleware, type RequestContext } from '@kivinjs/core';
import { Injectable } from '@kivinjs/decorators';

export class ItemMissing extends Error {}

@Injectable()
export class Store {
  items = new Map<number, { id: number; name: string; price: number }>([[1, { id: 1, name: 'Pen', price: 2 }]]);
}

@Injectable()
export class RawKeyGuard implements CanActivate {
  canActivateRaw(request: Request) {
    return request.headers.get('x-key') !== 'deny';
  }

  canActivate(): boolean {
    throw new Error('raw path expected');
  }
}

@Injectable()
export class RoleGuard implements CanActivate {
  canActivate(context: RequestContext) {
    context.set('role', context.request.headers.get('x-role') ?? 'guest');
    if (context.request.headers.get('x-role') === 'banned') {
      throw new HttpError(401, 'Banned', { headers: { 'www-authenticate': 'Role' } });
    }
    return context.request.headers.get('x-role') !== 'guest';
  }
}

@Injectable()
export class HeaderMiddleware implements NestLikeMiddleware {
  async handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    context.setResponseHeader('x-mw', 'header');
    if (context.request.headers.get('x-short-circuit') === '1') {
      return context.json({ shortCircuit: true }, { status: 202 });
    }
    const response = await next();
    response.headers.set('x-after', String(response.status));
    return response;
  }
}

@Injectable()
export class TraceMiddleware implements NestLikeMiddleware {
  use(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    context.setCookie('trace', 'on');
    return next();
  }
}

@Injectable()
export class MissingFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (error instanceof ItemMissing) {
      context.setResponseHeader('x-filtered', '1');
      return Response.json({ message: 'missing' }, { status: 404 });
    }
    return undefined;
  }
}

export const REQUEST_ID = Symbol.for('aot.requestId');
let counter = 0;
export const requestIdProvider = { provide: REQUEST_ID, scope: 'request' as const, useFactory: () => ({ id: ++counter }) };
export function resetCounter() {
  counter = 0;
}
