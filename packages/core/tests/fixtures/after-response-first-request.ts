// Runs in its own process: `afterResponseInUse` is module state, so "the first registration in the
// process" cannot be reproduced once any other test has registered a callback.
import { afterResponse, createApp, defineApplication, defineModule, type NestLikeMiddleware, type RequestContext, type ResponseState } from '@kivin/core';

const statuses: number[] = [];

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
  globals: { middleware: [ObserveMiddleware] },
}), {
  routes: [{
    method: 'GET', fullPath: '/ok', controller: Routes, methodName: 'ok', parameters: [], guards: [], middleware: [], filters: [],
    docs: { tags: [], security: [], responses: [] },
  }],
});

await app.fetch(new Request('http://localhost/ok'));
console.log(JSON.stringify(statuses));
