import { createApp, defineApplication, defineWebSocket } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { afterAll, describe, expect, test } from 'bun:test';
import { createClient, GRAPHQL_TRANSPORT_WS_PROTOCOL, makeServer } from 'graphql-ws';
import { createSchema, createYoga } from 'graphql-yoga';

interface SocketData {
  user: string;
}

let streamsFinished = 0;

const schema = createSchema<SocketData>({
  typeDefs: /* GraphQL */ `
    type Query {
      me: String!
    }
    type Subscription {
      count(to: Int!): Int!
      forever: Int!
    }
  `,
  resolvers: {
    Query: {
      me: (_parent, _args, context) => context.user,
    },
    Subscription: {
      count: {
        subscribe: async function* (_parent, args: { to: number }) {
          for (let value = 1; value <= args.to; value += 1) {
            yield { count: value };
          }
        },
      },
      forever: {
        subscribe: async function* () {
          try {
            for (let value = 1; ; value += 1) {
              yield { forever: value };
              await Bun.sleep(1);
            }
          } finally {
            streamsFinished += 1;
          }
        },
      },
    },
  },
});

const yoga = createYoga<SocketData>({ schema, logging: false });

const graphqlWs = makeServer<Record<string, unknown>, { user: string }>({
  execute: (args) => (args.rootValue as { execute: (args: unknown) => never }).execute(args),
  subscribe: (args) => (args.rootValue as { subscribe: (args: unknown) => never }).subscribe(args),
  onSubscribe: async (context, _id, payload) => {
    const { schema: envelopedSchema, execute, subscribe, contextFactory, parse, validate } = yoga.getEnveloped({ user: context.extra.user });
    const document = parse(payload.query);
    const errors = validate(envelopedSchema, document);
    if (errors.length > 0) {
      return errors;
    }
    return {
      schema: envelopedSchema,
      operationName: payload.operationName,
      document,
      variableValues: payload.variables,
      contextValue: await contextFactory(),
      rootValue: { execute, subscribe },
    };
  },
});

interface Session {
  receive?: (message: string) => Promise<void>;
  closed?: (code?: number, reason?: string) => Promise<void>;
}

const sessions = new WeakMap<object, Session>();

const graphqlSocket = defineWebSocket<SocketData>({
  upgrade(request) {
    const user = new URL(request.url).searchParams.get('user');
    return user ? { user } : new Response('Unauthorized', { status: 401 });
  },
  open(socket) {
    const session: Session = {};
    sessions.set(socket, session);
    session.closed = graphqlWs.opened({
      protocol: GRAPHQL_TRANSPORT_WS_PROTOCOL,
      send: (message) => {
        socket.send(message);
      },
      close: (code, reason) => {
        socket.close(code, reason);
      },
      onMessage: (receive) => {
        session.receive = receive;
      },
    }, { user: socket.data.data.user });
  },
  async message(socket, message) {
    await sessions.get(socket)?.receive?.(String(message));
  },
  async close(socket, code, reason) {
    await sessions.get(socket)?.closed?.(code, reason);
  },
});

const app = createApp(defineApplication({ modules: [], schemaAdapter: createValibotAdapter() }), { routes: [] });
const server = app.listen({ port: 0, hostname: '127.0.0.1', websockets: { '/graphql': graphqlSocket } });

const url = (query = '?user=ada') => `ws://127.0.0.1:${server.port}/graphql${query}`;
const client = (query?: string) => createClient({ url: url(query), webSocketImpl: WebSocket, retryAttempts: 0 });

const collect = async <T>(iterator: AsyncIterableIterator<T>) => {
  const values: T[] = [];
  for await (const value of iterator) {
    values.push(value);
  }
  return values;
};

afterAll(() => {
  server.stop(true);
});

describe('graphql-ws over listen({ websockets })', () => {
  test('the socket negotiates the graphql-transport-ws subprotocol', async () => {
    const socket = new WebSocket(url(), GRAPHQL_TRANSPORT_WS_PROTOCOL);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    expect(socket.protocol).toBe(GRAPHQL_TRANSPORT_WS_PROTOCOL);
    socket.close();
  });

  test('a subscription streams its values', async () => {
    const subscriber = client();
    const results = await collect(subscriber.iterate<{ count: number }>({ query: 'subscription { count(to: 3) }' }));
    await subscriber.dispose();
    expect(results.map((result) => result.data?.count)).toEqual([1, 2, 3]);
  });

  test('a value returned by the upgrade hook reaches resolvers', async () => {
    const subscriber = client('?user=grace');
    const results = await collect(subscriber.iterate<{ me: string }>({ query: '{ me }' }));
    await subscriber.dispose();
    expect(results.map((result) => result.data?.me)).toEqual(['grace']);
  });

  test('the upgrade hook refuses a request before the socket opens', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/graphql`);
    expect(response.status).toBe(401);
  });

  test('an invalid operation reports validation errors to the subscriber', async () => {
    const subscriber = client();
    await expect(collect(subscriber.iterate({ query: 'subscription { missing }' }))).rejects.toMatchObject([{ message: expect.stringContaining('missing') }]);
    await subscriber.dispose();
  });

  test('closing the socket finishes the running subscription', async () => {
    const before = streamsFinished;
    const subscriber = client();
    const iterator = subscriber.iterate<{ forever: number }>({ query: 'subscription { forever }' });
    expect((await iterator.next()).value?.data?.forever).toBe(1);

    await subscriber.dispose();

    for (let attempt = 0; attempt < 100 && streamsFinished === before; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(streamsFinished).toBe(before + 1);
  });
});
