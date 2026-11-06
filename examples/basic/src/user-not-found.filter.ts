import type { ExceptionFilter, RequestContext } from '@kivinjs/core';
import { Injectable } from '@kivinjs/decorators';
import { UserNotFoundError } from './users.service';

@Injectable()
export class UserNotFoundFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof UserNotFoundError)) {
      return undefined;
    }

    return context.json({ message: error.message }, { status: 404 });
  }
}
