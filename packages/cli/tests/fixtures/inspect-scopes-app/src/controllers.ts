import { RequestContext } from '@kivin/core';
import { Controller, Get, UseFilters, UseGuards, UseMiddleware } from '@kivin/decorators';

export const REQUEST_TRACE = Symbol.for('cli.inspect.requestTrace');

@Controller('/inspect')
export class SingletonController {
  @Get('/static')
  static() {
    return { ok: true };
  }
}

export class RequestScopedGuard {
  constructor(private readonly trace: { requestId: string }) {}

  canActivate(context: RequestContext) {
    return this.trace.requestId === context.req.raw.headers.get('x-allow-request-id');
  }
}

export class RequestScopedMiddleware {
  constructor(private readonly trace: { requestId: string }) {}

  async handle(_context: RequestContext, next: () => Promise<Response>) {
    return next();
  }
}

export class RequestScopedFilter {
  constructor(private readonly trace: { requestId: string }) {}

  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof Error) || error.message !== 'boom') {
      return undefined;
    }

    return context.json({ requestId: this.trace.requestId }, { status: 418 });
  }
}

@Controller('/inspect')
@UseGuards(RequestScopedGuard)
@UseMiddleware(RequestScopedMiddleware)
export class RequestScopedController {
  constructor(private readonly trace: { requestId: string }) {}

  @Get('/scoped')
  stack(context: RequestContext) {
    return { requestId: this.trace.requestId, header: context.req.raw.headers.get('x-request-id') };
  }

  @Get('/boom')
  @UseFilters(RequestScopedFilter)
  boom() {
    throw new Error('boom');
  }
}