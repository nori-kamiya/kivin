// Runs in its own process: `afterResponseInUse` is module state, see after-response-first-request.ts.
import { afterResponse, createApp, defineApplication, defineModule, enableAfterResponse, type NestLikeMiddleware, type RequestContext, type ResponseState } from '@kivin/core';

enableAfterResponse();

const statuses: number[] = [];

class AsyncGuard {
  async canActivate() {
    await Promise.resolve();
    return true;
  }
}

class ObserveMiddleware implements NestLikeMiddleware {
  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    return this.handleRaw(context.request, {}, undefined as never, next);
  }

  handleRaw(request: Request, _params: Record<string, string>, _state: ResponseState, next: () => Response | PromiseLike<Response>) {
    afterResponse(request, (response) => {
      statuses.push(response.status);
    });
    return next();
  }
}

class Routes {
  ok() {
    return { ok: true };
  }
}

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  globals: { guards: [AsyncGuard], middleware: [ObserveMiddleware] },
}), {
  routes: [{
    method: 'GET', fullPath: '/ok', controller: Routes, methodName: 'ok', parameters: [], guards: [], middleware: [], filters: [],
    docs: { tags: [], security: [], responses: [] },
  }],
});

await app.fetch(new Request('http://localhost/ok'));
console.log(JSON.stringify(statuses));
