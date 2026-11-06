import type { CanActivate, ExceptionFilter, NestLikeMiddleware, RequestContext, ResponseState } from '@kivinjs/core';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
}

export class UserNotFoundError extends Error {}

export class UserStore {
  readonly users: UserRecord[] = Array.from({ length: 20 }, (_, index) => ({
    id: String(index + 1),
    name: `User ${index + 1}`,
    email: `user${index + 1}@example.com`,
  }));

  list(search?: string) {
    return search ? this.users.filter((user) => user.name.toLowerCase().includes(search.toLowerCase())) : this.users;
  }

  find(id: string) {
    const user = this.users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new UserNotFoundError(id);
    }
    return user;
  }
}

export class ApiKeyGuard implements CanActivate {
  canActivateRaw(request: Request) {
    return request.headers.get('x-api-key') === 'secret';
  }

  canActivate(context: RequestContext) {
    return context.req.raw.headers.get('x-api-key') === 'secret';
  }
}

export class RequestIdMiddleware implements NestLikeMiddleware {
  handleRaw(request: Request, _params: Record<string, string>, state: ResponseState, next: () => Response | PromiseLike<Response>) {
    state.setResponseHeader('x-request-id', request.headers.get('x-request-id') ?? 'generated');
    return next();
  }

  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    context.setResponseHeader('x-request-id', context.req.raw.headers.get('x-request-id') ?? 'generated');
    return next();
  }
}

export class UserNotFoundFilter implements ExceptionFilter {
  catch(error: unknown) {
    if (error instanceof UserNotFoundError) {
      return Response.json({ message: 'not found' }, { status: 404 });
    }
    return undefined;
  }
}

export const REQUEST_STAMP = Symbol.for('perf.requestStamp');
let stampCounter = 0;
export const requestStampProvider = { provide: REQUEST_STAMP, scope: 'request' as const, useFactory: () => ({ value: ++stampCounter }) };
