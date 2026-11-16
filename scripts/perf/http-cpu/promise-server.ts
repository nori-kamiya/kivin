// Bare Bun server for #65: native routes that answer a Response synchronously, an already-resolved
// promise, a promise still pending when the handler returns, or an async function that awaited once.
// `GET /cpu` answers the process CPU time in µs (see client.ts).
//
//   PORT=4651 taskset -c 3 bun scripts/perf/http-cpu/promise-server.ts
const body = 'ok';
const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  routes: {
    '/sync': () => new Response(body),
    '/resolved': () => Promise.resolve(new Response(body)),
    // What `execute(...).then(cors.ensure)` returned before #65: pending until the next microtask.
    '/pending': () => Promise.resolve(body).then((text) => new Response(text)),
    '/async': async () => {
      await null;
      return new Response(body);
    },
    '/cpu': () => {
      const usage = process.cpuUsage();
      return new Response(String(usage.user + usage.system));
    },
  },
  fetch: () => new Response('Not Found', { status: 404 }),
});
console.log(`READY ${server.port}`);
