import { createApp, defineApplication, defineModule, defineWebSocket, type WebSocketPhase } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

const app = () => createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), { routes: [] });

async function connect(url: string) {
  const socket = new WebSocket(url);
  const messages: string[] = [];
  const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
  socket.addEventListener('message', (event) => messages.push(String(event.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  return { socket, messages, closed };
}

describe('WebSocket handler errors', () => {
  const consoleError = spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => consoleError.mockClear());

  test('a throwing upgrade answers 500 instead of reaching Bun', async () => {
    const instance = app();
    const server = instance.listen({ port: 0, hostname: '127.0.0.1', websockets: { '/ws': defineWebSocket({ upgrade() { throw new Error('auth backend down'); } }) } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/ws`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: 'Internal Server Error' });
      expect(String(consoleError.mock.calls[0]?.[0])).toContain('WebSocket upgrade failed for /ws');
    } finally {
      await instance.close();
    }
  });

  test('a failing message handler is reported and the socket keeps working', async () => {
    const instance = app();
    const reported: Array<[WebSocketPhase, string]> = [];
    const server = instance.listen({
      port: 0,
      hostname: '127.0.0.1',
      websockets: {
        '/echo': defineWebSocket({
          async message(socket, message) {
            if (message === 'throw') {
              throw new Error('handler boom');
            }
            socket.send(`echo:${message}`);
          },
          error(_socket, error, phase) {
            reported.push([phase, (error as Error).message]);
          },
        }),
        '/plain': defineWebSocket({
          message() {
            throw new Error('sync boom');
          },
        }),
      },
    });
    try {
      const { socket, messages } = await connect(`ws://127.0.0.1:${server.port}/echo`);
      socket.send('a');
      socket.send('throw');
      socket.send('b');
      await Bun.sleep(100);
      expect(messages).toEqual(['echo:a', 'echo:b']);
      expect(reported).toEqual([['message', 'handler boom']]);
      socket.close();

      const plain = await connect(`ws://127.0.0.1:${server.port}/plain`);
      plain.socket.send('x');
      await Bun.sleep(50);
      expect(String(consoleError.mock.calls.at(-1)?.[0])).toContain('WebSocket message handler failed for /plain');
      plain.socket.close();
    } finally {
      await instance.close();
    }
  });

  test('a failing open closes the socket with 1011', async () => {
    const instance = app();
    const server = instance.listen({ port: 0, hostname: '127.0.0.1', websockets: { '/ws': defineWebSocket({ async open() { throw new Error('init failed'); } }) } });
    try {
      const { closed } = await connect(`ws://127.0.0.1:${server.port}/ws`);
      expect(await closed).toBe(1011);
    } finally {
      await instance.close();
    }
  });

  test('errors outside kivin handling get a generic 500 from the server error hook', async () => {
    const instance = app();
    const server = instance.listen({ port: 0, hostname: '127.0.0.1', routes: { '/native': () => { throw new Error('native route boom'); } } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/native`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ message: 'Internal Server Error' });
    } finally {
      await instance.close();
    }
  });
});
