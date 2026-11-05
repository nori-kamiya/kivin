// Cross-framework comparison: kivin vs Hono vs Elysia on the same app-like workloads
// (examples/benchmark-stack-*), measured with the same paired method as the regression gate.
//
//   bun run perf:check
//
// For each workload all three compiled servers run at once and the load client rotates short blocks
// between them (Latin-square order), so machine drift on shared CI runners hits every framework
// equally. Each rotation yields one kivin/hono and one kivin/elysia throughput ratio; the report gives
// medians with bootstrap 95% CIs. It is report-only: it fails only if a server cannot start or answers
// with an unexpected status, so the comparison never blocks a merge on runner noise.
import { appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const frameworks = ['kivin', 'hono', 'elysia'] as const;
type Framework = (typeof frameworks)[number];

interface RequestSpec {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

interface Workload {
  name: string;
  /** BENCH_VARIANT the stack apps are started with. */
  variant: string;
  expectStatus: (status: number) => boolean;
  request: (index: number) => RequestSpec;
}

const jsonAuth = { 'content-type': 'application/json', 'x-api-key': 'secret' };
const ok = (status: number) => status >= 200 && status < 300;

const workloads: Workload[] = [
  { name: 'health', variant: 'health', expectStatus: ok, request: () => ({ path: '/health' }) },
  { name: 'docs-html', variant: 'docs', expectStatus: ok, request: () => ({ path: '/docs' }) },
  { name: 'read-users (query validation)', variant: 'users', expectStatus: ok, request: (index) => ({ path: `/users?search=${index % 2 === 0 ? 'Ada' : 'Grace'}` }) },
  {
    name: 'create-user (guard + body validation)',
    variant: 'create',
    expectStatus: ok,
    request: (index) => ({ method: 'POST', path: '/users', headers: jsonAuth, body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }) }),
  },
  {
    name: 'patch-user (guard + body validation)',
    variant: 'patch',
    expectStatus: ok,
    request: (index) => ({ method: 'PATCH', path: '/users/1', headers: jsonAuth, body: JSON.stringify({ name: index % 2 === 0 ? 'Ada Lovelace' : 'Ada Byron' }) }),
  },
  {
    name: 'delete-user (guard)',
    variant: 'delete',
    expectStatus: ok,
    request: (index) => ({ method: 'DELETE', path: `/users/${index % 2 === 0 ? '1' : '2'}`, headers: { 'x-api-key': 'secret' } }),
  },
];

const blockMs = Number(process.env.COMPARE_BLOCK_MS ?? 300);
const rotations = Number(process.env.COMPARE_ROTATIONS ?? 8);
const concurrency = Number(process.env.COMPARE_CONCURRENCY ?? 32);
const only = process.env.COMPARE_WORKLOADS?.split(',');

const binaries: Record<Framework, string> = {
  kivin: resolve(repoRoot, 'examples/benchmark-stack-kivin/bin/benchmark-stack-kivin'),
  hono: resolve(repoRoot, 'examples/benchmark-stack-hono/bin/benchmark-stack-hono'),
  elysia: resolve(repoRoot, 'examples/benchmark-stack-elysia/bin/benchmark-stack-elysia'),
};

if (!process.argv.includes('--no-build')) {
  // The kivin app's manifest (with AOT executors) is generated from its decorator source.
  await run([process.execPath, resolve(repoRoot, 'packages/cli/src/bin.ts'), 'generate', '--entry', resolve(repoRoot, 'examples/benchmark-stack-kivin/src/app.ts'), '--outDir', resolve(repoRoot, 'examples/benchmark-stack-kivin/.kivin/generated')]);
  for (const framework of frameworks) {
    await run([process.execPath, 'build', resolve(repoRoot, `examples/benchmark-stack-${framework}/src/main.ts`), '--compile', '--outfile', binaries[framework]]);
  }
}

const random = seededRandom(7);
const rows: string[] = [];
let failed = false;

for (const [workloadIndex, workload] of workloads.entries()) {
  if (only && !only.some((name) => workload.name.startsWith(name))) {
    continue;
  }

  // Fresh ports per workload, and every server is awaited on shutdown, so a port is never reused
  // while the previous process is still releasing it.
  const servers = await Promise.all(frameworks.map((framework, index) => startServer(framework, workload, 4300 + workloadIndex * 10 + index)));
  try {
    for (const server of servers) {
      const response = await send(server.url, workload.request(0));
      if (!workload.expectStatus(response)) {
        throw new Error(`${server.framework} answered ${response} for ${workload.name}`);
      }
      await loadBlock(server.url, workload, 400);
    }

    const rps: Record<Framework, number[]> = { kivin: [], hono: [], elysia: [] };
    const vsHono: number[] = [];
    const vsElysia: number[] = [];
    for (let rotation = 0; rotation < rotations; rotation += 1) {
      // Latin-square order: every framework goes first, second and third equally often.
      const order = frameworks.map((_, index) => servers[(index + rotation) % servers.length]!);
      const measured = {} as Record<Framework, number>;
      for (const server of order) {
        measured[server.framework] = await loadBlock(server.url, workload, blockMs);
      }
      for (const framework of frameworks) {
        rps[framework].push(measured[framework]);
      }
      vsHono.push(measured.kivin / measured.hono);
      vsElysia.push(measured.elysia > 0 ? measured.kivin / measured.elysia : Number.NaN);
    }

    const [honoLow, honoHigh] = bootstrap(vsHono);
    const [elysiaLow, elysiaHigh] = bootstrap(vsElysia);
    rows.push(`| ${workload.name} | ${fmt(median(rps.kivin))} | ${fmt(median(rps.hono))} | ${fmt(median(rps.elysia))} | ${pct(median(vsHono))} (${pct(honoLow)} … ${pct(honoHigh)}) | ${pct(median(vsElysia))} (${pct(elysiaLow)} … ${pct(elysiaHigh)}) |`);
    process.stdout.write(`  ${workload.name} done\n`);
  } catch (error) {
    failed = true;
    rows.push(`| ${workload.name} | ❌ ${error instanceof Error ? error.message : String(error)} | | | | |`);
  } finally {
    await Promise.all(servers.map((server) => server.stop()));
  }
}

const markdown = [
  '## kivin vs Hono vs Elysia (compiled binaries, paired)',
  '',
  'kivin / X > 100% means kivin served more requests per second than X in the same rotation.',
  '',
  '| workload | kivin req/s | hono req/s | elysia req/s | kivin / hono (95% CI) | kivin / elysia (95% CI) |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...rows,
  '',
].join('\n');
console.log(`\n${markdown}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
}
const output = process.argv[process.argv.indexOf('--output') + 1];
if (process.argv.includes('--output') && output) {
  await writeFile(resolve(output), markdown);
}
process.exit(failed ? 1 : 0);

// ---- helpers ------------------------------------------------------------------------------

async function startServer(framework: Framework, workload: Workload, port: number) {
  const child = Bun.spawn([binaries[framework]], { env: { ...process.env, PORT: String(port), BENCH_VARIANT: workload.variant }, stdout: 'ignore', stderr: 'pipe' });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${framework} exited early: ${await new Response(child.stderr).text()}`);
    }
    const reachable = await fetch(`${url}${workload.request(0).path}`, { method: 'HEAD' }).then(() => true, () => false);
    if (reachable) {
      return {
        framework,
        url,
        stop: async () => {
          child.kill();
          await child.exited;
        },
      };
    }
    await Bun.sleep(50);
  }
  child.kill();
  throw new Error(`${framework} did not start within 10s`);
}

function send(url: string, spec: RequestSpec) {
  return fetch(`${url}${spec.path}`, { method: spec.method ?? 'GET', headers: spec.headers, body: spec.body }).then(async (response) => {
    await response.arrayBuffer();
    return response.status;
  });
}

async function loadBlock(url: string, workload: Workload, durationMs: number) {
  let completed = 0;
  let next = 0;
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      const status = await send(url, workload.request(next++));
      if (!workload.expectStatus(status)) {
        throw new Error(`unexpected status ${status} during ${workload.name}`);
      }
      completed += 1;
    }
  }));
  return (completed * 1000) / (performance.now() - startedAt);
}

async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) {
    throw new Error(`${command.join(' ')} failed (${code})\n${stderr}${stdout}`);
  }
}

function median(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function bootstrap(values: number[]): [number, number] {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return [Number.NaN, Number.NaN];
  }
  const samples = Array.from({ length: 2000 }, () => median(finite.map(() => finite[Math.floor(random() * finite.length)]!))).sort((left, right) => left - right);
  return [samples[Math.floor(samples.length * 0.025)]!, samples[Math.floor(samples.length * 0.975)]!];
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fmt(value: number) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '-';
}

function pct(value: number) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-';
}
