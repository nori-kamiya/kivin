// Framework overhead against a hand-written floor, in process: the Stack benchmark app (the one
// compared with Hono / Elysia) is called through the handlers kivin gives Bun's native routes, next
// to a minimal hand-written implementation doing the same work (request ID, guard, validation,
// handler, JSON response). "net" subtracts the cost of building the Request / reading the Response.
//
//   bun run bench:stack:generate
//   bun scripts/perf/floor.ts                 # all workloads
//   ONLY=patch-user N=200000 bun scripts/perf/floor.ts
import { createApp, defineApplication } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import * as v from 'valibot';
import manifest from '../../examples/benchmark-stack-kivin/.kivin/generated/manifest';
import { BenchmarkModule, LoggerModule, RequestIdMiddleware } from '../../examples/benchmark-stack-kivin/src/app';

// Capture the native route table `listen()` builds, without opening a port.
const realServe = Bun.serve;
let routes: Record<string, unknown> = {};
(Bun as unknown as { serve: unknown }).serve = (options: { routes: Record<string, unknown> }) => {
  routes = options.routes;
  return { stop() {}, port: 0, hostname: 'x', url: new URL('http://x'), requestIP: () => null };
};
createApp(defineApplication({
  modules: [LoggerModule, BenchmarkModule],
  schemaAdapter: createValibotAdapter(),
  globals: { guards: [], middleware: [RequestIdMiddleware], filters: [] },
}), { routes: manifest.routes.filter((route) => !route.fullPath.startsWith('/variants/')) }).listen(0);
(Bun as unknown as { serve: unknown }).serve = realServe;

const base = 'http://127.0.0.1:3000';
const jsonAuth = { 'content-type': 'application/json', 'x-api-key': 'secret' };
const withParams = (url: string, init: RequestInit | undefined, params: Record<string, string>) => Object.assign(new Request(url, init), { params });

type Workload = [name: string, path: string, method: string, make: (index: number) => Request];
const workloads: Workload[] = [
  ['health', '/health', 'GET', () => withParams(`${base}/health`, undefined, {})],
  ['read-users', '/users', 'GET', (index) => withParams(`${base}/users?search=${index % 2 === 0 ? 'Ada' : 'Grace'}`, undefined, {})],
  ['patch-user', '/users/:id', 'PATCH', (index) => withParams(`${base}/users/1`, { method: 'PATCH', headers: jsonAuth, body: JSON.stringify({ name: index % 2 === 0 ? 'Ada Lovelace' : 'Ada Byron' }) }, { id: '1' })],
  ['delete-user', '/users/:id', 'DELETE', (index) => withParams(`${base}/users/${index % 2 === 0 ? '1' : '2'}`, { method: 'DELETE', headers: { 'x-api-key': 'secret' } }, { id: index % 2 === 0 ? '1' : '2' })],
  ['create-user', '/users', 'POST', (index) => withParams(`${base}/users`, { method: 'POST', headers: jsonAuth, body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }) }, {})],
];

// The hand-written floor.
const users = [{ id: '1', name: 'Ada Lovelace', email: 'ada@example.com' }, { id: '2', name: 'Grace Hopper', email: 'grace@example.com' }];
const Patch = v.object({ name: v.optional(v.string()), email: v.optional(v.pipe(v.string(), v.email())) });
const Create = v.object({ name: v.string(), email: v.pipe(v.string(), v.email()) });
const Id = v.object({ id: v.string() });
const Search = v.object({ search: v.pipe(v.string(), v.minLength(2)) });
const withId = (request: Request, response: Response) => {
  response.headers.set('x-request-id', request.headers.get('x-request-id') ?? crypto.randomUUID());
  return response;
};
const forbidden = () => Response.json({ message: 'Forbidden' }, { status: 403 });
const floor: Record<string, (request: Request & { params: Record<string, string> }) => Response | Promise<Response>> = {
  health: (request) => withId(request, Response.json({ ok: true, suite: 'stack' })),
  'read-users': (request) => {
    const query = v.parse(Search, Object.fromEntries(new URL(request.url).searchParams));
    const keyword = query.search.toLowerCase();
    return withId(request, Response.json(users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword))));
  },
  'patch-user': async (request) => {
    if (request.headers.get('x-api-key') !== 'secret') return forbidden();
    const params = v.parse(Id, request.params);
    const body = v.parse(Patch, await request.json());
    const user = users.find((candidate) => candidate.id === params.id)!;
    if (body.name) user.name = body.name;
    return withId(request, Response.json(user));
  },
  'delete-user': (request) => {
    if (request.headers.get('x-api-key') !== 'secret') return forbidden();
    const params = v.parse(Id, request.params);
    users.find((candidate) => candidate.id === params.id);
    return withId(request, new Response(null, { status: 204 }));
  },
  'create-user': async (request) => {
    if (request.headers.get('x-api-key') !== 'secret') return forbidden();
    const body = v.parse(Create, await request.json());
    const created = { id: String(users.length + 1), ...body };
    users.push(created);
    return withId(request, Response.json(created, { status: 201 }));
  },
};

const only = process.env.ONLY?.split(',');
const n = Number(process.env.N ?? 100_000);
const rounds = Number(process.env.ROUNDS ?? 5);
const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;

for (const [name, path, method, make] of workloads) {
  if (only && !only.includes(name)) {
    continue;
  }
  const definition = routes[path] as ((request: Request) => Response | Promise<Response>) | Record<string, (request: Request) => Response | Promise<Response>>;
  const kivin = typeof definition === 'function' ? definition : definition[method]!;
  const sides: Record<string, (request: Request) => Response | Promise<Response>> = {
    kivin,
    floor: floor[name] as (request: Request) => Response | Promise<Response>,
    noop: () => new Response(null),
  };
  const results: Record<string, number[]> = {};
  for (let round = 0; round < rounds; round += 1) {
    for (const [side, handler] of Object.entries(sides)) {
      for (let index = 0; index < 3_000; index += 1) await (await handler(make(index))).arrayBuffer();
      const startedAt = performance.now();
      for (let index = 0; index < n; index += 1) await (await handler(make(index))).arrayBuffer();
      (results[side] ??= []).push(((performance.now() - startedAt) * 1e6) / n);
    }
  }
  const noop = median(results.noop!);
  const kivinNet = median(results.kivin!) - noop;
  const floorNet = median(results.floor!) - noop;
  console.log(`${name.padEnd(12)} kivin ${median(results.kivin!).toFixed(0).padStart(5)} ns  floor ${median(results.floor!).toFixed(0).padStart(5)} ns  | net kivin ${kivinNet.toFixed(0).padStart(5)}  floor ${floorNet.toFixed(0).padStart(5)}  overhead ${(kivinNet - floorNet).toFixed(0).padStart(5)} ns`);
}
