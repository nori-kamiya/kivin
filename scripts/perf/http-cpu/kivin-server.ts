// kivin server for #65, built from the checkout in KIVIN_ROOT (default: this repository), so a base
// worktree and the current tree can be compared on the same CPU. MODE: `plain`, `cors`, `cors-hook`.
//
//   git worktree add --detach /tmp/kivin-base origin/main
//   KIVIN_ROOT=/tmp/kivin-base MODE=cors PORT=4701 taskset -c 3 bun scripts/perf/http-cpu/kivin-server.ts &
//   MODE=cors PORT=4702 taskset -c 3 bun scripts/perf/http-cpu/kivin-server.ts &
//   taskset -c 0,1 bun scripts/perf/http-cpu/client.ts --ports 4701,4702 --paths item
import { resolve } from 'node:path';

const root = process.env.KIVIN_ROOT ?? resolve(import.meta.dir, '../../..');
// Core only: it has no `@kivinjs/*` imports, so each checkout's own copy is loaded.
const { createApp, defineApplication, defineModule } = await import(`${root}/packages/core/src/index.ts`);

class Routes {
  item() {
    return { ok: true };
  }
}

const mode = process.env.MODE ?? 'cors';
const app = createApp(defineApplication({
  modules: [defineModule({ providers: [], controllers: [Routes], imports: [] })],
  ...(mode.includes('cors') ? { cors: { origin: '*' } } : {}),
  ...(mode.includes('hook') ? { onRequest: () => undefined } : {}),
}), {
  routes: [{ method: 'GET', fullPath: '/item', controller: Routes, methodName: 'item', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } }],
});
const server = app.listen({
  port: Number(process.env.PORT ?? 0),
  routes: {
    '/cpu': () => {
      const usage = process.cpuUsage();
      return new Response(String(usage.user + usage.system));
    },
  },
});
console.log(`READY ${server.port}`);
