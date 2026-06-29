import { Hono } from 'hono';
import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { Agent, request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApp as createCoreApp, defineApplication, defineModule, forbidden, notFound, type AppManifest, type CanActivate, type RequestContext, type SchemaAdapter } from '../packages/core/src/index.ts';
import { createJsonResponse } from '../packages/core/src/response.ts';
import { Router } from '../packages/core/src/router.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const httpAgent = new Agent({ keepAlive: true, maxSockets: 256 });
const bunExecutable = process.execPath;
const benchmarkMode = parseBenchmarkMode(process.env.BENCH_MODE);
const selectedVariantNames = parseSelectedVariants(process.env.BENCH_VARIANTS);

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
  name:
    | 'health'
    | 'users'
    | 'patch'
    | 'users-validation'
    | 'patch-validation'
    | 'patch-logger'
    | 'patch-validation-logger'
    | 'create'
    | 'create-no-request-id'
    | 'create-no-guard'
    | 'create-no-validation'
    | 'create-bare';
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
  scenarios: ScenarioResult[];
  startupMs: number;
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

interface ProfileRow {
  metric: string;
  opsPerSecond: number;
  iterations: number;
}

interface ProfileReport {
  rows: ProfileRow[];
}

const iterations = Number(process.env.BENCH_ITERATIONS ?? 5);
const profileIterations = Number(process.env.BENCH_PROFILE_ITERATIONS ?? 100000);
const profileRequestIterations = Number(process.env.BENCH_PROFILE_REQUESTS ?? 10000);

const baselineVariants: BenchmarkVariant[] = [
  {
    name: 'health',
    warmupRequest: () => ({ path: '/health' }),
    scenarios: [
      {
        name: 'health',
        requests: 5000,
        concurrency: 64,
        makeRequest: () => ({ path: '/health' }),
      },
    ],
  },
  {
    name: 'users',
    warmupRequest: (index) => ({ path: `/users?search=${index % 2 === 0 ? 'Ada' : 'Grace'}` }),
    scenarios: [
      {
        name: 'read-users',
        requests: 3000,
        concurrency: 64,
        makeRequest: (index) => ({ path: `/users?search=${index % 2 === 0 ? 'Ada' : 'Grace'}` }),
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
        requests: 1500,
        concurrency: 32,
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
];

const extendedVariants: BenchmarkVariant[] = [
  {
    name: 'users-validation',
    warmupRequest: (index) => ({ path: `/users?search=${index % 2 === 0 ? 'Ada' : 'Grace'}` }),
    scenarios: [
      {
        name: 'read-users-validated',
        requests: 3000,
        concurrency: 64,
        makeRequest: (index) => ({ path: `/users?search=${index % 2 === 0 ? 'Ada' : 'Grace'}` }),
      },
    ],
  },
  {
    name: 'patch-validation',
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
        name: 'patch-user-validated',
        requests: 1500,
        concurrency: 32,
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
    name: 'patch-logger',
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
        name: 'patch-user-logged',
        requests: 1500,
        concurrency: 32,
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
    name: 'patch-validation-logger',
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
        name: 'patch-user-validated-logged',
        requests: 1500,
        concurrency: 32,
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
    name: 'create-no-request-id',
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
        name: 'create-user-no-request-id',
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
    name: 'create-no-guard',
    warmupRequest: (index) => ({
      method: 'POST',
      path: '/users',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }),
    }),
    scenarios: [
      {
        name: 'create-user-no-guard',
        requests: 1000,
        concurrency: 24,
        makeRequest: (index) => ({
          method: 'POST',
          path: '/users',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }),
        }),
      },
    ],
  },
  {
    name: 'create-no-validation',
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
        name: 'create-user-no-validation',
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
    name: 'create-bare',
    warmupRequest: (index) => ({
      method: 'POST',
      path: '/users',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }),
    }),
    scenarios: [
      {
        name: 'create-user-bare',
        requests: 1000,
        concurrency: 24,
        makeRequest: (index) => ({
          method: 'POST',
          path: '/users',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }),
        }),
      },
    ],
  },
];

const variants = selectBenchmarkVariants(benchmarkMode);
const activeVariants = selectedVariantNames
  ? variants.filter((variant) => selectedVariantNames.has(variant.name))
  : variants;

if (selectedVariantNames && activeVariants.length === 0) {
  throw new Error(`BENCH_VARIANTS did not match any benchmark variants for mode ${benchmarkMode}: ${[...selectedVariantNames].join(', ')}`);
}

const runtimes: RuntimeDefinition[] = [
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-kivin/bin/benchmark-kivin'),
    launch: 'compiled',
    name: 'kivin',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-kivin/bin/benchmark-kivin')],
  },
  {
    artifactPath: null,
    launch: 'source',
    name: 'kivin',
    spawnArgs: [bunExecutable, 'run', resolve(scriptDir, '../examples/benchmark-kivin/src/main.ts')],
  },
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-hono/bin/benchmark-hono'),
    launch: 'compiled',
    name: 'hono',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-hono/bin/benchmark-hono')],
  },
  {
    artifactPath: null,
    launch: 'source',
    name: 'hono',
    spawnArgs: [bunExecutable, 'run', resolve(scriptDir, '../examples/benchmark-hono/src/main.ts')],
  },
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-elysia/bin/benchmark-elysia'),
    launch: 'compiled',
    name: 'elysia',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-elysia/bin/benchmark-elysia')],
  },
  {
    artifactPath: null,
    launch: 'source',
    name: 'elysia',
    spawnArgs: [bunExecutable, 'run', resolve(scriptDir, '../examples/benchmark-elysia/src/main.ts')],
  },
];

const targets: BenchmarkTarget[] = runtimes.flatMap((runtime) => variants.map((variant) => ({ ...runtime, variant })));
const resolvedTargets: BenchmarkTarget[] = runtimes.flatMap((runtime) => activeVariants.map((variant) => ({ ...runtime, variant })));
const results: RuntimeResult[] = [];

for (let index = 0; index < resolvedTargets.length; index += 1) {
  const target = resolvedTargets[index];
  const port = 3500 + index;
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactBytes = target.artifactPath ? (await stat(target.artifactPath)).size : null;
  const samples: RuntimeSample[] = [];

  console.log(`collecting ${iterations} samples for ${target.name}-${target.launch}-${target.variant.name}`);
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
    scenarios: aggregateScenarioMedians(samples),
    startupMs: median(samples.map((sample) => sample.startupMs)),
    variant: target.variant.name,
  });
}

console.log(renderResults(results));
const profiles = await collectProfiles();
console.log('');
console.log(renderProfileResults(profiles));
console.log('\nJSON\n');
console.log(JSON.stringify({ benchmarks: results, profiles }, null, 2));

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

  console.log(`starting ${input.name}-${input.launch}-${input.variant.name} sample ${input.sampleIndex + 1}/${iterations} on ${input.baseUrl}`);
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
    const scenarioResults: ScenarioResult[] = [];
    for (const scenario of input.variant.scenarios) {
      console.log(`running ${input.name}-${input.launch}-${input.variant.name} sample ${input.sampleIndex + 1}/${iterations}:${scenario.name}`);
      scenarioResults.push(await runScenario(input.baseUrl, scenario));
    }

    return {
      startupMs: round(startupMs),
      scenarios: scenarioResults,
    };
  } catch (error) {
    await stopProcess(processHandle);
    throw error;
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
  const workers = Array.from({ length: 32 }, async () => {
    while (nextIndex < 200) {
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

function renderResults(results: RuntimeResult[]) {
  const sections = ['Benchmark results'];

  sections.push('');
  sections.push(`mode: ${benchmarkMode}; median of ${iterations} execution-phase samples; binaries are built once before measurement`);
  sections.push('');
  sections.push('| runtime | launch | variant | artifact | startup ms | scenario | req/s | avg ms | p50 ms | p95 ms | p99 ms |');
  sections.push('| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |');

  for (const runtime of results) {
    for (let index = 0; index < runtime.scenarios.length; index += 1) {
      const scenario = runtime.scenarios[index];
      sections.push(`| ${index === 0 ? runtime.name : ''} | ${index === 0 ? runtime.launch : ''} | ${index === 0 ? runtime.variant : ''} | ${index === 0 ? runtime.artifactLabel : ''} | ${index === 0 ? runtime.startupMs : ''} | ${scenario.name} | ${scenario.throughput} | ${scenario.avgMs} | ${scenario.p50Ms} | ${scenario.p95Ms} | ${scenario.p99Ms} |`);
    }
  }

  return sections.join('\n');
}

async function collectProfiles(): Promise<ProfileReport> {
  const rows: ProfileRow[] = [];
  const usersPayload = [
    { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
    { id: '2', name: 'Grace Hopper', email: 'grace@example.com' },
  ];

  const router = new Router<{ id: string }>();
  router.register('GET', '/health', { id: 'health' });
  router.register('GET', '/users', { id: 'users' });
  router.register('GET', '/users/:id', { id: 'user-by-id' });
  router.register('PATCH', '/users/:id', { id: 'patch-user' });

  rows.push(measureSyncProfile('kivin.router.match.static', profileIterations, () => {
    const match = router.match('GET', '/users');
    if (!match) {
      throw new Error('router static match failed');
    }
    return match.data.id;
  }));

  rows.push(measureSyncProfile('kivin.router.match.param', profileIterations, () => {
    const match = router.match('GET', '/users/1');
    if (!match) {
      throw new Error('router param match failed');
    }
    return match.params.id;
  }));

  rows.push(measureSyncProfile('kivin.response.plain.json', Math.floor(profileIterations / 2), () => createJsonResponse(usersPayload)));

  const kivinProfile = createProfileFw();
  const honoProfile = createProfileHono();
  const usersRequest = new Request('http://localhost/users?search=Ada');
  const healthRequest = new Request('http://localhost/health');
  const patchRequest = () => new Request('http://localhost/users/1', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'secret',
    },
    body: JSON.stringify({ name: 'Ada Lovelace' }),
  });

  rows.push(measureSyncProfile('kivin.handler.direct.read-users', profileIterations, () => kivinProfile.directRead('Ada').length));
  rows.push(measureSyncProfile('hono.handler.direct.read-users', profileIterations, () => honoProfile.directRead('Ada').length));

  rows.push(await measureAsyncProfile('kivin.app.fetch.health.context-json', profileRequestIterations, async () => {
    const response = await kivinProfile.contextHealthFetch(new Request(healthRequest));
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.health.plain-response', profileRequestIterations, async () => {
    const response = await kivinProfile.plainHealthFetch(new Request(healthRequest));
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.read-users', profileRequestIterations, async () => {
    const response = await kivinProfile.usersFetch(new Request(usersRequest));
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.patch.no-body.no-guard', profileRequestIterations, async () => {
    const response = await kivinProfile.patchNoBodyNoGuardFetch(patchRequest());
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.patch.json-only.no-guard', profileRequestIterations, async () => {
    const response = await kivinProfile.patchJsonOnlyNoGuardFetch(patchRequest());
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.patch.schema.no-guard', profileRequestIterations, async () => {
    const response = await kivinProfile.patchSchemaNoGuardFetch(patchRequest());
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.patch.schema.context-guard', profileRequestIterations, async () => {
    const response = await kivinProfile.patchSchemaContextGuardFetch(patchRequest());
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.patch.schema.raw-guard', profileRequestIterations, async () => {
    const response = await kivinProfile.patchSchemaRawGuardFetch(patchRequest());
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('hono.app.fetch.read-users', profileRequestIterations, async () => {
    const response = await honoProfile.fetch(new Request(usersRequest));
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('hono.app.fetch.patch', profileRequestIterations, async () => {
    const response = await honoProfile.patchFetch(patchRequest());
    await response.arrayBuffer();
  }));

  return { rows };
}

function selectBenchmarkVariants(mode: 'baseline' | 'extended' | 'all') {
  if (mode === 'extended') {
    return extendedVariants;
  }

  if (mode === 'all') {
    return baselineVariants.concat(extendedVariants);
  }

  return baselineVariants;
}

function parseBenchmarkMode(value: string | undefined): 'baseline' | 'extended' | 'all' {
  if (value === 'extended' || value === 'all') {
    return value;
  }

  return 'baseline';
}

function parseSelectedVariants(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  return new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean));
}

function createProfileFw() {
  type BenchmarkSchema = { kind: 'body' };

  interface UserRecord {
    id: string;
    name: string;
    email: string;
  }

  class UserStore {
    private readonly users: UserRecord[] = [
      { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
      { id: '2', name: 'Grace Hopper', email: 'grace@example.com' },
    ];

    list(search?: string) {
      if (!search) {
        return this.users;
      }

      const keyword = search.toLowerCase();
      return this.users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword));
    }

    patch(id: string, input: { name?: string }) {
      const user = this.users.find((candidate) => candidate.id === id);
      if (!user) {
        throw notFound(`User ${id} was not found`);
      }

      if (input.name) {
        user.name = input.name;
      }

      return user;
    }
  }

  const store = new UserStore();

  class ContextApiKeyGuard implements CanActivate {
    canActivate(context: RequestContext) {
      const method = context.req.raw.method;
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return true;
      }

      if (context.req.raw.headers.get('x-api-key') === 'secret') {
        return true;
      }

      throw forbidden();
    }
  }

  class RawApiKeyGuard implements CanActivate {
    canActivateRaw(request: Request) {
      const method = request.method;
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return true;
      }

      if (request.headers.get('x-api-key') === 'secret') {
        return true;
      }

      throw forbidden();
    }

    canActivate(context: RequestContext) {
      const method = context.req.raw.method;
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
        return true;
      }

      if (context.req.raw.headers.get('x-api-key') === 'secret') {
        return true;
      }

      throw forbidden();
    }
  }

  class BenchmarkController {
    healthContext(context: RequestContext) {
      return context.json({ ok: true });
    }

    healthPlain() {
      return createJsonResponse({ ok: true });
    }

    list(search?: string) {
      return store.list(search);
    }

    patchNoBody(id: string) {
      return store.patch(id, { name: 'Ada Lovelace' });
    }

    patchJsonOnly(id: string, body: { name?: string }) {
      return store.patch(id, body);
    }

    patch(id: string, body: { name?: string }) {
      return store.patch(id, body);
    }
  }

  const bodySchema: BenchmarkSchema = { kind: 'body' };
  const schemaAdapter: SchemaAdapter<BenchmarkSchema> = {
    name: 'passthrough',
    parse: <TOutput>(_schema: BenchmarkSchema, input: unknown) => ({ success: true, output: input as TOutput }),
    toOpenApiSchema: () => ({}),
  };

  const benchmarkModule = defineModule({
    providers: [ContextApiKeyGuard, RawApiKeyGuard],
    controllers: [BenchmarkController],
    imports: [],
  });

  const definition = defineApplication({
    modules: [benchmarkModule],
    schemaAdapter,
    globals: {
      guards: [],
      middleware: [],
      filters: [],
    },
  });

  const usersManifest: AppManifest<BenchmarkSchema> = {
    routes: [
      {
        method: 'GET',
        fullPath: '/users',
        controller: BenchmarkController,
        methodName: 'list',
        parameters: [{ index: 0, source: 'query', name: 'search' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: { tags: ['benchmark'], security: [], responses: [] },
      },
      {
        method: 'PATCH',
        fullPath: '/users/:id',
        controller: BenchmarkController,
        methodName: 'patch',
        parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
        guards: [RawApiKeyGuard],
        middleware: [],
        filters: [],
        docs: { tags: ['benchmark'], bodySchema, security: [], responses: [] },
      },
    ],
  };

  const patchNoBodyNoGuardManifest: AppManifest<BenchmarkSchema> = {
    routes: [
      {
        method: 'PATCH',
        fullPath: '/users/:id',
        controller: BenchmarkController,
        methodName: 'patchNoBody',
        parameters: [{ index: 0, source: 'path', name: 'id' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: { tags: ['benchmark'], security: [], responses: [] },
      },
    ],
  };

  const patchJsonOnlyNoGuardManifest: AppManifest<BenchmarkSchema> = {
    routes: [
      {
        method: 'PATCH',
        fullPath: '/users/:id',
        controller: BenchmarkController,
        methodName: 'patchJsonOnly',
        parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: { tags: ['benchmark'], security: [], responses: [] },
      },
    ],
  };

  const patchSchemaNoGuardManifest: AppManifest<BenchmarkSchema> = {
    routes: [
      {
        method: 'PATCH',
        fullPath: '/users/:id',
        controller: BenchmarkController,
        methodName: 'patch',
        parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: { tags: ['benchmark'], bodySchema, security: [], responses: [] },
      },
    ],
  };

  const patchSchemaContextGuardManifest: AppManifest<BenchmarkSchema> = {
    routes: [
      {
        method: 'PATCH',
        fullPath: '/users/:id',
        controller: BenchmarkController,
        methodName: 'patch',
        parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
        guards: [ContextApiKeyGuard],
        middleware: [],
        filters: [],
        docs: { tags: ['benchmark'], bodySchema, security: [], responses: [] },
      },
    ],
  };

  const patchSchemaRawGuardManifest: AppManifest<BenchmarkSchema> = {
    routes: [
      {
        method: 'PATCH',
        fullPath: '/users/:id',
        controller: BenchmarkController,
        methodName: 'patch',
        parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
        guards: [RawApiKeyGuard],
        middleware: [],
        filters: [],
        docs: { tags: ['benchmark'], bodySchema, security: [], responses: [] },
      },
    ],
  };

  const contextHealthManifest: AppManifest<BenchmarkSchema> = {
    routes: [
      {
        method: 'GET',
        fullPath: '/health',
        controller: BenchmarkController,
        methodName: 'healthContext',
        parameters: [{ index: 0, source: 'context' }],
        guards: [],
        middleware: [],
        filters: [],
        docs: { tags: ['benchmark'], security: [], responses: [] },
      },
    ],
  };

  const plainHealthManifest: AppManifest<BenchmarkSchema> = {
    routes: [
      {
        method: 'GET',
        fullPath: '/health',
        controller: BenchmarkController,
        methodName: 'healthPlain',
        parameters: [],
        guards: [],
        middleware: [],
        filters: [],
        docs: { tags: ['benchmark'], security: [], responses: [] },
      },
    ],
  };

  const controller = new BenchmarkController();

  return {
    contextHealthFetch: createCoreApp(definition, contextHealthManifest).fetch,
    directRead: (search?: string) => controller.list(search),
    patchJsonOnlyNoGuardFetch: createCoreApp(definition, patchJsonOnlyNoGuardManifest).fetch,
    patchNoBodyNoGuardFetch: createCoreApp(definition, patchNoBodyNoGuardManifest).fetch,
    patchSchemaContextGuardFetch: createCoreApp(definition, patchSchemaContextGuardManifest).fetch,
    patchSchemaNoGuardFetch: createCoreApp(definition, patchSchemaNoGuardManifest).fetch,
    patchSchemaRawGuardFetch: createCoreApp(definition, patchSchemaRawGuardManifest).fetch,
    plainHealthFetch: createCoreApp(definition, plainHealthManifest).fetch,
    usersFetch: createCoreApp(definition, usersManifest).fetch,
  };
}

function createProfileHono() {
  const users = [
    { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
    { id: '2', name: 'Grace Hopper', email: 'grace@example.com' },
  ];

  const directRead = (search?: string) => {
    if (!search) {
      return users;
    }

    const keyword = search.toLowerCase();
    return users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword));
  };

  const app = new Hono();
  app.get('/users', (context) => {
    const search = context.req.query('search');
    return context.json(directRead(search));
  });

  app.patch('/users/:id', async (context) => {
    if (context.req.header('x-api-key') !== 'secret') {
      return context.json({ message: 'Forbidden' }, 403);
    }

    const body = await context.req.json<{ name?: string }>();
    const id = context.req.param('id');
    const user = users.find((candidate) => candidate.id === id);
    if (!user) {
      return context.json({ message: `User ${id} was not found` }, 404);
    }

    if (body.name) {
      user.name = body.name;
    }

    return context.json(user);
  });

  return {
    directRead,
    fetch: app.fetch,
    patchFetch: app.fetch,
  };
}

function measureSyncProfile(metric: string, count: number, fn: () => unknown): ProfileRow {
  let sink = 0;
  const startedAt = performance.now();

  for (let index = 0; index < count; index += 1) {
    const value = fn();
    sink += typeof value === 'string' ? value.length : 1;
  }

  const elapsedMs = Math.max(performance.now() - startedAt, 0.001);
  if (sink < 0) {
    throw new Error('unreachable');
  }

  return {
    metric,
    opsPerSecond: round((count * 1000) / elapsedMs),
    iterations: count,
  };
}

async function measureAsyncProfile(metric: string, count: number, fn: () => Promise<void>): Promise<ProfileRow> {
  const startedAt = performance.now();

  for (let index = 0; index < count; index += 1) {
    await fn();
  }

  const elapsedMs = Math.max(performance.now() - startedAt, 0.001);
  return {
    metric,
    opsPerSecond: round((count * 1000) / elapsedMs),
    iterations: count,
  };
}

function renderProfileResults(report: ProfileReport) {
  const sections = ['Profiling results', '', `in-process microbenchmarks; profile iterations=${profileIterations}, profile request iterations=${profileRequestIterations}`, '', '| metric | ops/s | iterations |', '| --- | ---: | ---: |'];

  for (const row of report.rows) {
    sections.push(`| ${row.metric} | ${row.opsPerSecond} | ${row.iterations} |`);
  }

  return sections.join('\n');
}
