import type { ExceptionFilter, RequestContext } from '@kivin/core';
import { Injectable } from '@kivin/decorators';
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
