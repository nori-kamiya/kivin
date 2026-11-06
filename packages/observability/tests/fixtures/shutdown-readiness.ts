// Runs in its own process: the test sends it real signals and observes the exit.
import { createApp, defineApplication, defineModule, type AppManifest } from '@kivin/core';
import { createHealthCheck } from '@kivin/observability';
import { createValibotAdapter } from '@kivin/valibot';

class Lifecycle {
  onApplicationShutdown(signal?: string) {
    if (process.env.FAIL_SHUTDOWN === '1') {
      throw new Error('db pool close failed');
    }
    console.log(`shutdown ${signal}`);
  }
}

class Routes {
  ping() {
    return { pong: true };
  }
}

const manifest: AppManifest = {
  routes: [{
    method: 'GET', fullPath: '/ping', controller: Routes, methodName: 'ping', parameters: [], guards: [], middleware: [], filters: [],
    docs: { tags: [], security: [], responses: [] },
  }],
};

const health = createHealthCheck();
const failHook = process.env.FAIL_HOOK === '1';
const app = createApp(defineApplication({
  modules: [defineModule({ providers: [Lifecycle], controllers: [Routes], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), manifest);
await app.init();

const server = app.listen({
  port: 0,
  hostname: '127.0.0.1',
  routes: health.routes(),
  shutdownSignals: ['SIGTERM'],
  shutdownDelayMs: Number(process.env.DELAY_MS),
  onShutdownStart(signal) {
    if (failHook) {
      throw new Error('hook failed');
    }
    console.log(`start ${signal}`);
    health.setReady(false);
  },
});
console.log(`url ${server.url}`);
