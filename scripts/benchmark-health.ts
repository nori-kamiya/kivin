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

interface BenchmarkRequest {
  path: string;
}

interface RuntimeDefinition {
  artifactPath: string | null;
  healthMode?: 'context-json' | 'plain-response' | 'static-object';
  launch: 'compiled' | 'source';
  name: 'kivin' | 'hono';
  spawnArgs: string[];
}

interface RuntimeResult {
  artifactBytes: number | null;
  artifactLabel: string;
  healthMode: string;
  iterations: number;
  launch: 'compiled' | 'source';
  name: 'kivin' | 'hono';
  samples: RuntimeSample[];
  startupMs: number;
  throughput: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
}

interface RuntimeSample {
  startupMs: number;
  throughput: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
}

const runtimes: RuntimeDefinition[] = [
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-kivin/bin/benchmark-kivin'),
    healthMode: 'context-json',
    launch: 'compiled',
    name: 'kivin',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-kivin/bin/benchmark-kivin')],
  },
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-kivin/bin/benchmark-kivin'),
    healthMode: 'plain-response',
    launch: 'compiled',
    name: 'kivin',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-kivin/bin/benchmark-kivin')],
  },
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-kivin/bin/benchmark-kivin'),
    healthMode: 'static-object',
    launch: 'compiled',
    name: 'kivin',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-kivin/bin/benchmark-kivin')],
  },
  {
    artifactPath: null,
    healthMode: 'context-json',
    launch: 'source',
    name: 'kivin',
    spawnArgs: [bunExecutable, 'run', resolve(scriptDir, '../examples/benchmark-kivin/src/main.ts')],
  },
  {
    artifactPath: null,
    healthMode: 'plain-response',
    launch: 'source',
    name: 'kivin',
    spawnArgs: [bunExecutable, 'run', resolve(scriptDir, '../examples/benchmark-kivin/src/main.ts')],
  },
  {
    artifactPath: null,
    healthMode: 'static-object',
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
];

const results: RuntimeResult[] = [];

for (let index = 0; index < runtimes.length; index += 1) {
  const runtime = runtimes[index];
  const port = 3700 + index;
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactBytes = runtime.artifactPath ? (await stat(runtime.artifactPath)).size : null;
  const samples: RuntimeSample[] = [];

  console.log(`collecting ${iterations} health samples for ${runtime.name}-${runtime.launch}-${runtime.healthMode ?? 'baseline'}`);
  for (let sampleIndex = 0; sampleIndex < iterations; sampleIndex += 1) {
    samples.push(await collectRuntimeSample({
      baseUrl,
      healthMode: runtime.healthMode,
      launch: runtime.launch,
      name: runtime.name,
      port,
      sampleIndex,
      spawnArgs: runtime.spawnArgs,
    }));
  }

  results.push({
    artifactBytes,
    artifactLabel: runtime.artifactPath ? formatBytes(artifactBytes ?? 0) : 'source',
    healthMode: runtime.healthMode ?? 'baseline',
    iterations,
    launch: runtime.launch,
    name: runtime.name,
    samples,
    startupMs: median(samples.map((sample) => sample.startupMs)),
    throughput: median(samples.map((sample) => sample.throughput)),
    avgMs: median(samples.map((sample) => sample.avgMs)),
    p95Ms: median(samples.map((sample) => sample.p95Ms)),
    p99Ms: median(samples.map((sample) => sample.p99Ms)),
  });
}

console.log(renderResults(results));
console.log('\nJSON\n');
console.log(JSON.stringify({ benchmarks: results }, null, 2));

async function collectRuntimeSample(input: {
  baseUrl: string;
  healthMode?: RuntimeDefinition['healthMode'];
  launch: 'compiled' | 'source';
  name: 'kivin' | 'hono';
  port: number;
  sampleIndex: number;
  spawnArgs: string[];
}): Promise<RuntimeSample> {
  const startedAt = performance.now();
  const processHandle = spawn(input.spawnArgs[0] ?? '', input.spawnArgs.slice(1), {
    env: {
      ...process.env,
      BENCH_HEALTH_MODE: input.healthMode,
      BENCH_VARIANT: 'health',
      PORT: String(input.port),
    },
    stdio: 'inherit',
  });

  try {
    await waitForReady(input.baseUrl);
    const startupMs = performance.now() - startedAt;
    await warmup(input.baseUrl);
    const scenario = await runScenario(input.baseUrl);
    return {
      startupMs: round(startupMs),
      ...scenario,
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

async function warmup(baseUrl: string) {
  let nextIndex = 0;
  const workers = Array.from({ length: 32 }, async () => {
    while (nextIndex < 200) {
      nextIndex += 1;
      const response = await sendRequest(baseUrl, { path: '/health' });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`warmup received ${response.status}`);
      }
    }
  });

  await Promise.all(workers);
}

async function runScenario(baseUrl: string) {
  const latencies: number[] = [];
  let nextIndex = 0;
  const requests = 5000;
  const concurrency = 64;
  const startedAt = performance.now();

  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < requests) {
      nextIndex += 1;
      const requestStartedAt = performance.now();
      const response = await sendRequest(baseUrl, { path: '/health' });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`health received ${response.status}`);
      }
      latencies.push(performance.now() - requestStartedAt);
    }
  });

  await Promise.all(workers);
  const elapsedMs = performance.now() - startedAt;
  latencies.sort((left, right) => left - right);

  return {
    throughput: round((requests * 1000) / elapsedMs),
    avgMs: round(latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
}

async function sendRequest(baseUrl: string, request: BenchmarkRequest) {
  const url = new URL(request.path, baseUrl);

  return new Promise<{ status: number; body: Buffer }>((resolveRequest, rejectRequest) => {
    const clientRequest = httpRequest(url, {
      agent: httpAgent,
      method: 'GET',
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
      clientRequest.destroy(new Error(`Request timed out: GET ${url.pathname}${url.search}`));
    });
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
  const sections = ['Health implementation benchmark results'];
  sections.push('');
  sections.push(`median of ${iterations} execution-phase samples; binaries are built once before measurement`);
  sections.push('');
  sections.push('| runtime | launch | health mode | artifact | startup ms | req/s | avg ms | p95 ms | p99 ms |');
  sections.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');

  for (const runtime of results) {
    sections.push(`| ${runtime.name} | ${runtime.launch} | ${runtime.healthMode} | ${runtime.artifactLabel} | ${runtime.startupMs} | ${runtime.throughput} | ${runtime.avgMs} | ${runtime.p95Ms} | ${runtime.p99Ms} |`);
  }

  return sections.join('\n');
}
