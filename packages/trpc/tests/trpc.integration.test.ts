import { createApp, defineApplication, defineModule, forbidden, markErrorReported, RequestContext, unauthorized } from '@kivinjs/core';
import { createTrpcRoutes, httpErrors } from '@kivinjs/trpc';
import { createValibotAdapter } from '@kivinjs/valibot';
import { createTRPCClient, httpBatchLink, httpLink, TRPCClientError } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as v from 'valibot';

class RequestId {
  static created = 0;
  readonly id = ++RequestId.created;
}

class Users {
  find(id: number) {
    return id === 1 ? { id, name: 'Ada' } : undefined;
  }
}

interface Context {
  user: string;
  requestId: number;
  users: Users;
  context: RequestContext;
}

const t = initTRPC.context<Context>().create();
const procedure = t.procedure.use(httpErrors);

let subscriptionFinished = 0;
let createContextCalls = 0;

const router = t.router({
  whoami: procedure.query(({ ctx }) => ({ user: ctx.user, requestId: ctx.requestId })),
  user: procedure.input(v.object({ id: v.number() })).query(({ ctx, input }) => ctx.users.find(input.id) ?? null),
  rename: procedure.input(v.object({ name: v.pipe(v.string(), v.minLength(1)) })).mutation(({ input }) => ({ name: input.name })),
  sameScope: procedure.query(({ ctx }) => ctx.context.inject(RequestId).id === ctx.requestId),
  denied: procedure.query(() => {
    throw forbidden('no access');
  }),
  denyWithoutMiddleware: t.procedure.query(() => {
    throw forbidden('no access');
  }),
  boom: procedure.query(() => {
    throw new Error('database is down');
  }),
  logged: procedure.query(() => {
    const error = new Error('already logged');
    markErrorReported(error);
    throw error;
  }),
  ticks: procedure.input(v.object({ count: v.number(), delayMs: v.number() })).subscription(async function* ({ input, signal }) {
    try {
      for (let value = 1; value <= input.count; value += 1) {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
        if (signal?.aborted) {
          return;
        }
        yield value;
      }
    } finally {
      subscriptionFinished += 1;
    }
  }),
});

const app = createApp(defineApplication({
  modules: [defineModule({
    providers: [Users, { provide: RequestId, scope: 'request', useClass: RequestId }],
    controllers: [],
    imports: [],
  })],
  schemaAdapter: createValibotAdapter(),
}), { routes: [] });

const server = app.listen({
  port: 0,
  hostname: '127.0.0.1',
  idleTimeout: 1,
  routes: {
    ...createTrpcRoutes(router, {
      app,
      createContext: ({ req, requestContext }) => {
        createContextCalls += 1;
        const user = req.headers.get('x-user');
        if (user === 'teapot') {
          throw new Response('short and stout', { status: 418 });
        }
        if (!user) {
          throw unauthorized('sign in first');
        }
        const context = requestContext();
        return { user, requestId: context.inject(RequestId).id, users: context.inject(Users), context };
      },
    }),
  },
});

const url = new URL('/trpc', server.url).toString();
const client = (user: string | undefined, link: 'batch' | 'single' = 'batch') => createTRPCClient<typeof router>({
  links: [(link === 'batch' ? httpBatchLink : httpLink)({ url, headers: user ? { 'x-user': user } : {} })],
});

// Bun has no EventSource (which tRPC's httpSubscriptionLink needs), so subscriptions are read as the
// raw SSE stream the link would consume.
const subscribe = (input: { count: number; delayMs: number }, signal?: AbortSignal) => fetch(
  `${url}/ticks?input=${encodeURIComponent(JSON.stringify(input))}`,
  { headers: { accept: 'text/event-stream', 'x-user': 'ada' }, signal: signal ?? null },
);
async function* sseData(response: Response) {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of response.body!) {
    buffered += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffered.indexOf('\n\n')) !== -1) {
      const event = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const data = event.split('\n').find((line) => line.startsWith('data: '));
      if (data && !event.split('\n').some((line) => line.startsWith('event: '))) {
        yield JSON.parse(data.slice('data: '.length)) as unknown;
      }
    }
  }
}

let consoleError: ReturnType<typeof spyOn<Console, 'error'>>;
beforeEach(() => {
  consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
  createContextCalls = 0;
});
afterEach(() => {
  consoleError.mockRestore();
});
afterAll(() => {
  server.stop(true);
});

const clientError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TRPCClientError) {
      return error as TRPCClientError<typeof router>;
    }
    throw error;
  }
  throw new Error('expected the call to fail');
};

describe('createTrpcRoutes with a real tRPC client', () => {
  test('given a batched call, when two procedures run, then createContext runs once and both share one request scope', async () => {
    const trpc = client('ada');
    const [first, second, sameScope] = await Promise.all([trpc.whoami.query(), trpc.whoami.query(), trpc.sameScope.query()]);

    expect(createContextCalls).toBe(1);
    expect(first).toEqual(second);
    expect(first.user).toBe('ada');
    expect(sameScope).toBe(true);
  });

  test('given two HTTP requests, when each resolves a request-scoped provider, then each gets its own instance', async () => {
    const first = await client('ada', 'single').whoami.query();
    const second = await client('ada', 'single').whoami.query();

    expect(first.requestId).not.toBe(second.requestId);
  });

  test('given a singleton, when injected in createContext, then the procedure uses it', async () => {
    expect(await client('ada').user.query({ id: 1 })).toEqual({ id: 1, name: 'Ada' });
    expect(await client('ada').user.query({ id: 2 })).toBeNull();
  });

  test('given valibot input, when the input is invalid, then the client gets BAD_REQUEST', async () => {
    expect(await client('ada').rename.mutate({ name: 'Grace' })).toEqual({ name: 'Grace' });

    const error = await clientError(client('ada').rename.mutate({ name: '' }));
    expect(error.data?.code).toBe('BAD_REQUEST');
    expect(error.data?.httpStatus).toBe(400);
  });

  test('given createContext throws an HttpError, when called, then the client gets the matching tRPC error and status', async () => {
    const error = await clientError(client(undefined).whoami.query());

    expect(error.message).toBe('sign in first');
    expect(error.data?.code).toBe('UNAUTHORIZED');
    expect(error.data?.httpStatus).toBe(401);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('given createContext throws a Response, when called, then that response is returned as is', async () => {
    const response = await fetch(`${url}/whoami`, { headers: { 'x-user': 'teapot' } });

    expect(response.status).toBe(418);
    expect(await response.text()).toBe('short and stout');
  });

  test('given the httpErrors middleware, when a procedure throws an HttpError, then the client gets the matching code', async () => {
    const error = await clientError(client('ada').denied.query());

    expect(error.message).toBe('no access');
    expect(error.data?.code).toBe('FORBIDDEN');
    expect(error.data?.httpStatus).toBe(403);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('given no httpErrors middleware, when a procedure throws an HttpError, then it is an internal error and is logged once', async () => {
    const error = await clientError(client('ada').denyWithoutMiddleware.query());

    expect(error.data?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test('given an unexpected error, when a procedure throws it, then the client gets a 500 and the cause is logged once', async () => {
    const error = await clientError(client('ada').boom.query());

    expect(error.data?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(error.data?.httpStatus).toBe(500);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toBe('[kivin] Unhandled error');
    expect((consoleError.mock.calls[0]?.[1] as Error).message).toBe('database is down');
  });

  test('given an error a logger already reported, when a procedure throws it, then it is not logged again', async () => {
    await clientError(client('ada').logged.query());

    expect(consoleError).not.toHaveBeenCalled();
  });

  test('given a subscription slower than idleTimeout, when subscribed over SSE, then every value arrives', async () => {
    const response = await subscribe({ count: 2, delayMs: 3_000 });
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const values: unknown[] = [];
    for await (const data of sseData(response)) {
      values.push(data);
    }
    expect(values).toEqual([1, 2]);
  }, 15_000);

  test('given an open subscription, when the client aborts, then the server generator stops', async () => {
    const before = subscriptionFinished;
    const controller = new AbortController();
    const response = await subscribe({ count: 1_000, delayMs: 20 }, controller.signal);
    let received = 0;
    try {
      for await (const _ of sseData(response)) {
        received += 1;
        if (received === 2) {
          controller.abort();
        }
      }
    } catch (error) {
      expect((error as Error).name).toBe('AbortError');
    }

    const deadline = Date.now() + 3_000;
    while (subscriptionFinished === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(subscriptionFinished).toBe(before + 1);
  });
});

describe('createTrpcRoutes and app.close()', () => {
  test('given an open subscription, when the app closes, then close finishes within its timeout and the generator stops', async () => {
    const closingApp = createApp(defineApplication({ modules: [], schemaAdapter: createValibotAdapter() }), { routes: [] });
    const closingServer = closingApp.listen({ port: 0, hostname: '127.0.0.1', routes: createTrpcRoutes(router, { createContext: () => ({}) as Context }) });
    const before = subscriptionFinished;
    const response = await fetch(`${new URL('/trpc', closingServer.url)}/ticks?input=${encodeURIComponent(JSON.stringify({ count: 1_000, delayMs: 20 }))}`, {
      headers: { accept: 'text/event-stream' },
    });
    const reader = response.body!.getReader();
    await reader.read();

    const started = Date.now();
    await closingApp.close({ timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);

    const deadline = Date.now() + 3_000;
    while (subscriptionFinished === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(subscriptionFinished).toBe(before + 1);
    await reader.cancel().catch(() => undefined);
  });
});
