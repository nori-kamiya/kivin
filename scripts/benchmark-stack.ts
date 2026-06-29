import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { Agent, request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const httpAgent = new Agent({ keepAlive: true, maxSockets: 256 });
const bunExecutable = process.execPath;
const iterations = Number(process.env.BENCH_ITERATIONS ?? 5);
const selectedVariantNames = parseSelectedVariants(process.env.BENCH_VARIANTS);
const selectedRuntimeFilters = parseSelectedRuntimes(process.env.BENCH_RUNTIMES);

interface BenchmarkRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

interface ScenarioDefinition {
  name: string;
  requests: number;
  concurrency: number;
  makeRequest: (index: number) => BenchmarkRequest;
}

interface BenchmarkVariant {
  name: 'health' | 'docs' | 'users' | 'create' | 'patch' | 'delete' | 'delete-inline' | 'delete-no-guard' | 'delete-bare';
  scenarios: ScenarioDefinition[];
  warmupRequest: (index: number) => BenchmarkRequest;
}

interface RuntimeDefinition {
  artifactPath: string | null;
  launch: 'compiled' | 'source';
  name: 'kivin' | 'hono' | 'elysia';
  spawnArgs: string[];
}

interface BenchmarkTarget extends RuntimeDefinition {
  variant: BenchmarkVariant;
}

interface RuntimeResult {
  artifactBytes: number | null;
  artifactLabel: string;
  iterations: number;
  launch: 'compiled' | 'source';
  name: 'kivin' | 'hono' | 'elysia';
  samples: RuntimeSample[];
  scenarioMeans: ScenarioResult[];
  scenarioMedians: ScenarioResult[];
  startupMsMean: number;
  startupMsMedian: number;
  variant: BenchmarkVariant['name'];
}

interface RuntimeSample {
  startupMs: number;
  scenarios: ScenarioResult[];
}

interface ScenarioResult {
  name: string;
  requests: number;
  concurrency: number;
  throughput: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

const variants: BenchmarkVariant[] = [
  {
    name: 'health',
    warmupRequest: () => ({ path: '/health' }),
    scenarios: [
      {
        name: 'health',
        requests: 4000,
        concurrency: 64,
        makeRequest: () => ({ path: '/health' }),
      },
    ],
  },
  {
    name: 'docs',
    warmupRequest: () => ({ path: '/docs' }),
    scenarios: [
      {
        name: 'docs-html',
        requests: 4000,
        concurrency: 64,
        makeRequest: () => ({ path: '/docs' }),
      },
    ],
  },
  {
    name: 'users',
    warmupRequest: (index) => ({ path: `/users?search=${index % 2 === 0 ? 'Ada' : 'Grace'}` }),
    scenarios: [
      {
        name: 'read-users',
        requests: 2500,
        concurrency: 48,
        makeRequest: (index) => ({ path: `/users?search=${index % 2 === 0 ? 'Ada' : 'Grace'}` }),
      },
    ],
  },
  {
    name: 'create',
    warmupRequest: (index) => ({
      method: 'POST',
      path: '/users',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'secret',
      },
      body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }),
    }),
    scenarios: [
      {
        name: 'create-user',
        requests: 1000,
        concurrency: 24,
        makeRequest: (index) => ({
          method: 'POST',
          path: '/users',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'secret',
          },
          body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }),
        }),
      },
    ],
  },
  {
    name: 'patch',
    warmupRequest: (index) => ({
      method: 'PATCH',
      path: '/users/1',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'secret',
      },
      body: JSON.stringify({ name: index % 2 === 0 ? 'Ada Lovelace' : 'Ada Byron' }),
    }),
    scenarios: [
      {
        name: 'patch-user',
        requests: 1250,
        concurrency: 24,
        makeRequest: (index) => ({
          method: 'PATCH',
          path: '/users/1',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'secret',
          },
          body: JSON.stringify({ name: index % 2 === 0 ? 'Ada Lovelace' : 'Ada Byron' }),
        }),
      },
    ],
  },
  {
    name: 'delete',
    warmupRequest: () => ({
      method: 'DELETE',
      path: '/users/1',
      headers: {
        'x-api-key': 'secret',
      },
    }),
    scenarios: [
      {
        name: 'delete-user',
        requests: 1250,
        concurrency: 24,
        makeRequest: (index) => ({
          method: 'DELETE',
          path: `/users/${index % 2 === 0 ? '1' : '2'}`,
          headers: {
            'x-api-key': 'secret',
          },
        }),
      },
    ],
  },
  {
    name: 'delete-inline',
    warmupRequest: () => ({
      method: 'DELETE',
      path: '/users-inline/1',
      headers: {
        'x-api-key': 'secret',
      },
    }),
    scenarios: [
      {
        name: 'delete-user-inline',
        requests: 1250,
        concurrency: 24,
        makeRequest: (index) => ({
          method: 'DELETE',
          path: `/users-inline/${index % 2 === 0 ? '1' : '2'}`,
          headers: {
            'x-api-key': 'secret',
          },
        }),
      },
    ],
  },
  {
    name: 'delete-no-guard',
    warmupRequest: () => ({
      method: 'DELETE',
      path: '/users-no-guard/1',
    }),
    scenarios: [
      {
        name: 'delete-user-no-guard',
        requests: 1250,
        concurrency: 24,
        makeRequest: (index) => ({
          method: 'DELETE',
          path: `/users-no-guard/${index % 2 === 0 ? '1' : '2'}`,
        }),
      },
    ],
  },
  {
    name: 'delete-bare',
    warmupRequest: () => ({
      method: 'DELETE',
      path: '/users-bare/1',
    }),
    scenarios: [
      {
        name: 'delete-user-bare',
        requests: 1250,
        concurrency: 24,
        makeRequest: (index) => ({
          method: 'DELETE',
          path: `/users-bare/${index % 2 === 0 ? '1' : '2'}`,
        }),
      },
    ],
  },
];

const activeVariants = selectedVariantNames
  ? variants.filter((variant) => selectedVariantNames.has(variant.name))
  : variants;

if (selectedVariantNames && activeVariants.length === 0) {
  throw new Error(`BENCH_VARIANTS did not match any stack benchmark variants: ${[...selectedVariantNames].join(', ')}`);
}

const runtimes: RuntimeDefinition[] = [
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-stack-kivin/bin/benchmark-stack-kivin'),
    launch: 'compiled',
    name: 'kivin',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-stack-kivin/bin/benchmark-stack-kivin')],
  },
  {
    artifactPath: null,
    launch: 'source',
    name: 'kivin',
    spawnArgs: [bunExecutable, 'run', resolve(scriptDir, '../examples/benchmark-stack-kivin/src/main.ts')],
  },
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-stack-hono/bin/benchmark-stack-hono'),
    launch: 'compiled',
    name: 'hono',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-stack-hono/bin/benchmark-stack-hono')],
  },
  {
    artifactPath: null,
    launch: 'source',
    name: 'hono',
    spawnArgs: [bunExecutable, 'run', resolve(scriptDir, '../examples/benchmark-stack-hono/src/main.ts')],
  },
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-stack-elysia/bin/benchmark-stack-elysia'),
    launch: 'compiled',
    name: 'elysia',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-stack-elysia/bin/benchmark-stack-elysia')],
  },
  {
    artifactPath: null,
    launch: 'source',
    name: 'elysia',
    spawnArgs: [bunExecutable, 'run', resolve(scriptDir, '../examples/benchmark-stack-elysia/src/main.ts')],
  },
];

const activeRuntimes = selectedRuntimeFilters
  ? runtimes.filter((runtime) => matchesRuntimeFilter(runtime, selectedRuntimeFilters))
  : runtimes;

if (selectedRuntimeFilters && activeRuntimes.length === 0) {
  throw new Error(`BENCH_RUNTIMES did not match any stack benchmark runtimes: ${[...selectedRuntimeFilters].join(', ')}`);
}

const targets: BenchmarkTarget[] = activeRuntimes.flatMap((runtime) => activeVariants.map((variant) => ({ ...runtime, variant })));
const results: RuntimeResult[] = [];

for (let index = 0; index < targets.length; index += 1) {
  const target = targets[index];
  const port = 3600 + index;
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactBytes = target.artifactPath ? (await stat(target.artifactPath)).size : null;
  const samples: RuntimeSample[] = [];

  console.log(`collecting ${iterations} stack samples for ${target.name}-${target.launch}-${target.variant.name}`);
  for (let sampleIndex = 0; sampleIndex < iterations; sampleIndex += 1) {
    samples.push(await collectRuntimeSample({
      baseUrl,
      launch: target.launch,
      name: target.name,
      port,
      sampleIndex,
      spawnArgs: target.spawnArgs,
      variant: target.variant,
    }));
  }

  results.push({
    artifactBytes,
    artifactLabel: target.artifactPath ? formatBytes(artifactBytes ?? 0) : 'source',
    iterations,
    launch: target.launch,
    name: target.name,
    samples,
    scenarioMeans: aggregateScenarioMeans(samples),
    scenarioMedians: aggregateScenarioMedians(samples),
    startupMsMean: mean(samples.map((sample) => sample.startupMs)),
    startupMsMedian: median(samples.map((sample) => sample.startupMs)),
    variant: target.variant.name,
  });
}

console.log(renderResults(results));
console.log('\nJSON\n');
console.log(JSON.stringify({ benchmarks: results }, null, 2));

async function collectRuntimeSample(input: {
  baseUrl: string;
  launch: 'compiled' | 'source';
  name: 'kivin' | 'hono' | 'elysia';
  port: number;
  sampleIndex: number;
  spawnArgs: string[];
  variant: BenchmarkVariant;
}): Promise<RuntimeSample> {
  const startedAt = performance.now();
  const processHandle = spawn(input.spawnArgs[0] ?? '', input.spawnArgs.slice(1), {
    env: {
      ...process.env,
      BENCH_VARIANT: input.variant.name,
      PORT: String(input.port),
    },
    stdio: 'inherit',
  });

  try {
    await waitForReady(input.baseUrl);
    const startupMs = performance.now() - startedAt;
    await warmup(input.baseUrl, input.variant);

    const scenarios: ScenarioResult[] = [];
    for (const scenario of input.variant.scenarios) {
      scenarios.push(await runScenario(input.baseUrl, scenario));
    }

    return {
      startupMs: round(startupMs),
      scenarios,
    };
  } finally {
    await stopProcess(processHandle);
  }
}

async function waitForReady(baseUrl: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await sendRequest(baseUrl, { path: '/health' });
      if (response.status >= 200 && response.status < 300) {
        return;
      }
    } catch {
      // Retry until the server becomes ready.
    }

    await delay(50);
  }

  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

async function warmup(baseUrl: string, variant: BenchmarkVariant) {
  let nextIndex = 0;
  const workers = Array.from({ length: 24 }, async () => {
    while (nextIndex < 160) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const response = await sendRequest(baseUrl, variant.warmupRequest(currentIndex));
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`warmup received ${response.status}`);
      }
    }
  });

  await Promise.all(workers);
}

async function runScenario(baseUrl: string, scenario: ScenarioDefinition): Promise<ScenarioResult> {
  const latencies: number[] = [];
  let nextIndex = 0;
  const startedAt = performance.now();

  const workers = Array.from({ length: scenario.concurrency }, async () => {
    while (nextIndex < scenario.requests) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const request = scenario.makeRequest(currentIndex);
      const requestStartedAt = performance.now();
      const response = await sendRequest(baseUrl, request);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${scenario.name} received ${response.status}`);
      }
      latencies.push(performance.now() - requestStartedAt);
    }
  });

  await Promise.all(workers);
  const elapsedMs = performance.now() - startedAt;
  latencies.sort((left, right) => left - right);

  return {
    name: scenario.name,
    requests: scenario.requests,
    concurrency: scenario.concurrency,
    throughput: round((scenario.requests * 1000) / elapsedMs),
    avgMs: round(latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
}

async function sendRequest(baseUrl: string, request: BenchmarkRequest) {
  const url = new URL(request.path, baseUrl);

  return new Promise<{ status: number; body: Buffer }>((resolveRequest, rejectRequest) => {
    const clientRequest = httpRequest(url, {
      agent: httpAgent,
      method: request.method ?? 'GET',
      headers: request.headers,
    }, (response) => {
      const chunks: Buffer[] = [];

      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        resolveRequest({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks),
        });
      });
      response.on('error', rejectRequest);
    });

    clientRequest.on('error', rejectRequest);
    clientRequest.setTimeout(5000, () => {
      clientRequest.destroy(new Error(`Request timed out: ${request.method ?? 'GET'} ${url.pathname}${url.search}`));
    });

    if (request.body) {
      clientRequest.write(request.body);
    }

    clientRequest.end();
  });
}

async function stopProcess(processHandle: ChildProcess) {
  if (processHandle.exitCode !== null || processHandle.killed) {
    return;
  }

  processHandle.kill('SIGTERM');
  await onceExit(processHandle, 1000);

  if (processHandle.exitCode === null && !processHandle.killed) {
    processHandle.kill('SIGKILL');
    await onceExit(processHandle, 1000);
  }
}

async function onceExit(processHandle: ChildProcess, timeoutMs: number) {
  if (processHandle.exitCode !== null) {
    return;
  }

  await Promise.race([
    new Promise<void>((resolveExit) => {
      processHandle.once('exit', () => resolveExit());
    }),
    delay(timeoutMs),
  ]);
}

function aggregateScenarioMeans(samples: RuntimeSample[]): ScenarioResult[] {
  const firstSample = samples[0];
  if (!firstSample) {
    return [];
  }

  return firstSample.scenarios.map((scenario, scenarioIndex) => ({
    name: scenario.name,
    requests: scenario.requests,
    concurrency: scenario.concurrency,
    throughput: mean(samples.map((sample) => sample.scenarios[scenarioIndex]?.throughput ?? 0)),
    avgMs: mean(samples.map((sample) => sample.scenarios[scenarioIndex]?.avgMs ?? 0)),
    p50Ms: mean(samples.map((sample) => sample.scenarios[scenarioIndex]?.p50Ms ?? 0)),
    p95Ms: mean(samples.map((sample) => sample.scenarios[scenarioIndex]?.p95Ms ?? 0)),
    p99Ms: mean(samples.map((sample) => sample.scenarios[scenarioIndex]?.p99Ms ?? 0)),
  }));
}

function aggregateScenarioMedians(samples: RuntimeSample[]): ScenarioResult[] {
  const firstSample = samples[0];
  if (!firstSample) {
    return [];
  }

  return firstSample.scenarios.map((scenario, scenarioIndex) => ({
    name: scenario.name,
    requests: scenario.requests,
    concurrency: scenario.concurrency,
    throughput: median(samples.map((sample) => sample.scenarios[scenarioIndex]?.throughput ?? 0)),
    avgMs: median(samples.map((sample) => sample.scenarios[scenarioIndex]?.avgMs ?? 0)),
    p50Ms: median(samples.map((sample) => sample.scenarios[scenarioIndex]?.p50Ms ?? 0)),
    p95Ms: median(samples.map((sample) => sample.scenarios[scenarioIndex]?.p95Ms ?? 0)),
    p99Ms: median(samples.map((sample) => sample.scenarios[scenarioIndex]?.p99Ms ?? 0)),
  }));
}

function mean(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function median(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
  }

  return round(sorted[middle] ?? 0);
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.min(values.length - 1, Math.floor(values.length * ratio));
  return round(values[index] ?? 0);
}

function round(value: number) {
  return Number(value.toFixed(3));
}

function formatBytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function parseSelectedVariants(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const variants = new Set(
    value
      .split(',')
      .map((variant) => variant.trim())
      .filter((variant): variant is BenchmarkVariant['name'] => variant.length > 0),
  );

  return variants.size > 0 ? variants : undefined;
}

function parseSelectedRuntimes(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const runtimes = new Set(
    value
      .split(',')
      .map((runtime) => runtime.trim())
      .filter((runtime) => runtime.length > 0),
  );

  return runtimes.size > 0 ? runtimes : undefined;
}

function matchesRuntimeFilter(runtime: RuntimeDefinition, selectedFilters: Set<string>) {
  return selectedFilters.has(runtime.name)
    || selectedFilters.has(runtime.launch)
    || selectedFilters.has(`${runtime.name}:${runtime.launch}`);
}

function renderResults(results: RuntimeResult[]) {
  const sections = ['Stack benchmark results'];
  sections.push('');
  sections.push(`${iterations} execution-phase samples per runtime/launch/variant; binaries are built once before measurement`);
  sections.push('');
  sections.push('Mean summary');
  sections.push('');
  sections.push('| runtime | launch | variant | artifact | startup ms mean | scenario | req/s mean | avg ms mean | p50 ms mean | p95 ms mean | p99 ms mean |');
  sections.push('| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |');

  for (const runtime of results) {
    for (let index = 0; index < runtime.scenarioMeans.length; index += 1) {
      const scenario = runtime.scenarioMeans[index];
      sections.push(`| ${index === 0 ? runtime.name : ''} | ${index === 0 ? runtime.launch : ''} | ${index === 0 ? runtime.variant : ''} | ${index === 0 ? runtime.artifactLabel : ''} | ${index === 0 ? runtime.startupMsMean : ''} | ${scenario.name} | ${scenario.throughput} | ${scenario.avgMs} | ${scenario.p50Ms} | ${scenario.p95Ms} | ${scenario.p99Ms} |`);
    }
  }

  sections.push('');
  sections.push('Median summary');
  sections.push('');
  sections.push('| runtime | launch | variant | artifact | startup ms median | scenario | req/s median | avg ms median | p50 ms median | p95 ms median | p99 ms median |');
  sections.push('| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |');

  for (const runtime of results) {
    for (let index = 0; index < runtime.scenarioMedians.length; index += 1) {
      const scenario = runtime.scenarioMedians[index];
      sections.push(`| ${index === 0 ? runtime.name : ''} | ${index === 0 ? runtime.launch : ''} | ${index === 0 ? runtime.variant : ''} | ${index === 0 ? runtime.artifactLabel : ''} | ${index === 0 ? runtime.startupMsMedian : ''} | ${scenario.name} | ${scenario.throughput} | ${scenario.avgMs} | ${scenario.p50Ms} | ${scenario.p95Ms} | ${scenario.p99Ms} |`);
    }
  }

  return sections.join('\n');
}
