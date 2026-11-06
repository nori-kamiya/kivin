import { createApp, defineApplication, defineModule, type AppManifest } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';

class PingController {
  ping() {
    return { pong: true };
  }
}

const manifest: AppManifest = {
  routes: [
    {
      method: 'GET',
      fullPath: '/ping',
      controller: PingController,
      methodName: 'ping',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: { tags: [], security: [], responses: [] },
    },
  ],
};

const definition = defineApplication({
  modules: [defineModule({ providers: [], controllers: [PingController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});

describe('app.listen', () => {
  test('serves app routes and extra native routes side by side', async () => {
    const app = createApp(definition, manifest);
    const server = app.listen({
      port: 0,
      hostname: '127.0.0.1',
      routes: { '/openapi.json': Response.json({ openapi: '3.1.0' }) },
    });

    try {
      const ping = await fetch(new URL('/ping', server.url));
      expect(ping.status).toBe(200);
      expect(await ping.json()).toEqual({ pong: true });

      const document = await fetch(new URL('/openapi.json', server.url));
      expect(await document.json()).toEqual({ openapi: '3.1.0' });

      const missing = await fetch(new URL('/nope', server.url));
      expect(missing.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  test('still accepts a bare port number', async () => {
    const server = createApp(definition, manifest).listen(0);
    try {
      expect((await fetch(new URL('/ping', server.url))).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test('shutdown sequencing options without shutdownSignals are rejected instead of being ignored', () => {
    const app = createApp(definition, manifest);
    expect(() => app.listen({ port: 0, shutdownDelayMs: 5000 })).toThrow('require shutdownSignals');
    expect(() => app.listen({ port: 0, onShutdownStart: () => {} })).toThrow('require shutdownSignals');
  });

  test('rejects extra routes that would shadow an app route', () => {
    const app = createApp(definition, manifest);
    expect(() => app.listen({ port: 0, routes: { '/ping': new Response('shadow') } })).toThrow('collides with an application route');
  });
});
