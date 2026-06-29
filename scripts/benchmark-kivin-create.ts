import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { Agent, request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { createApp, createJsonResponseCreated, defineApplication, defineModule, forbidden, setInjectableMetadata, type AppManifest, type CanActivate, type NestLikeMiddleware, type RequestContext, type ResponseState } from '../packages/core/src/index.ts';
import { createLoggerModule, LOGGER, type Logger } from '../packages/logger/src/index.ts';
import { createValibotAdapter } from '../packages/valibot/src/index.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const httpAgent = new Agent({ keepAlive: true, maxSockets: 128 });
const bunExecutable = process.execPath;
const iterations = Number(process.env.BENCH_ITERATIONS ?? 5);
const selectedVariantNames = parseSelectedVariants(process.env.BENCH_VARIANTS);
const profileRequestIterations = Number(process.env.BENCH_PROFILE_REQUESTS ?? 10000);
const warmupRequests = Number(process.env.BENCH_WARMUP_REQUESTS ?? 160);

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
  name: 'create' | 'create-request-id-pass-through' | 'create-no-request-id' | 'create-no-guard' | 'create-no-validation' | 'create-bare';
  scenarios: ScenarioDefinition[];
  warmupRequest: (index: number) => BenchmarkRequest;
}

interface RuntimeDefinition {
  artifactPath: string | null;
  launch: 'compiled' | 'source';
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

interface ProfileRow {
  metric: string;
  opsPerSecond: number;
  iterations: number;
}

interface ProfileReport {
  rows: ProfileRow[];
}

function createRequestHeaders(variant: BenchmarkVariant['name']) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };

  if (variant === 'create-request-id-pass-through') {
    headers['x-request-id'] = 'bench-request-id';
  }

  if (variant !== 'create-no-guard' && variant !== 'create-bare') {
    headers['x-api-key'] = 'secret';
  }

  return headers;
}

const variants: BenchmarkVariant[] = [
  {
    name: 'create',
    warmupRequest: (index) => ({
      method: 'POST',
      path: '/users',
      headers: createRequestHeaders('create'),
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
          headers: createRequestHeaders('create'),
          body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }),
        }),
      },
    ],
  },
  {
    name: 'create-request-id-pass-through',
    warmupRequest: (index) => ({
      method: 'POST',
      path: '/users',
      headers: createRequestHeaders('create-request-id-pass-through'),
      body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }),
    }),
    scenarios: [
      {
        name: 'create-user-request-id-pass-through',
        requests: 1000,
        concurrency: 24,
        makeRequest: (index) => ({
          method: 'POST',
          path: '/users',
          headers: createRequestHeaders('create-request-id-pass-through'),
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
      headers: createRequestHeaders('create-no-request-id'),
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
          headers: createRequestHeaders('create-no-request-id'),
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
      headers: createRequestHeaders('create-no-guard'),
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
          headers: createRequestHeaders('create-no-guard'),
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
      headers: createRequestHeaders('create-no-validation'),
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
          headers: createRequestHeaders('create-no-validation'),
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
      headers: createRequestHeaders('create-bare'),
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
          headers: createRequestHeaders('create-bare'),
          body: JSON.stringify({ name: `Benchmark User ${index}`, email: `benchmark-${index}@example.com` }),
        }),
      },
    ],
  },
];

const activeVariants = selectedVariantNames
  ? variants.filter((variant) => selectedVariantNames.has(variant.name))
  : variants;

if (selectedVariantNames && activeVariants.length === 0) {
  throw new Error(`BENCH_VARIANTS did not match any kivin create benchmark variants: ${[...selectedVariantNames].join(', ')}`);
}

const runtimes: RuntimeDefinition[] = [
  {
    artifactPath: resolve(scriptDir, '../examples/benchmark-stack-kivin/bin/benchmark-stack-kivin'),
    launch: 'compiled',
    spawnArgs: [resolve(scriptDir, '../examples/benchmark-stack-kivin/bin/benchmark-stack-kivin')],
  },
  {
    artifactPath: null,
    launch: 'source',
    spawnArgs: [bunExecutable, 'run', resolve(scriptDir, '../examples/benchmark-stack-kivin/src/main.ts')],
  },
];

const targets: BenchmarkTarget[] = runtimes.flatMap((runtime) => activeVariants.map((variant) => ({ ...runtime, variant })));
const results: RuntimeResult[] = [];

for (let index = 0; index < targets.length; index += 1) {
  const target = targets[index];
  const port = 3700 + index;
  const baseUrl = `http://127.0.0.1:${port}`;
  const artifactBytes = target.artifactPath ? (await stat(target.artifactPath)).size : null;
  const samples: RuntimeSample[] = [];

  console.log(`collecting ${iterations} kivin create samples for ${target.launch}-${target.variant.name}`);
  for (let sampleIndex = 0; sampleIndex < iterations; sampleIndex += 1) {
    samples.push(await collectRuntimeSample({
      baseUrl,
      launch: target.launch,
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
    samples,
    scenarioMeans: aggregateScenarioMeans(samples),
    scenarioMedians: aggregateScenarioMedians(samples),
    startupMsMean: mean(samples.map((sample) => sample.startupMs)),
    startupMsMedian: median(samples.map((sample) => sample.startupMs)),
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
    await waitForServer(input.baseUrl);
    const startupMs = performance.now() - startedAt;
    await warmup(input.baseUrl, input.variant);
    const scenarios: ScenarioResult[] = [];

    for (const scenario of input.variant.scenarios) {
      scenarios.push(await runScenario(input.baseUrl, scenario));
    }

    return { startupMs, scenarios };
  } finally {
    await stopProcess(processHandle);
  }
}

async function waitForServer(baseUrl: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await performRequest(baseUrl, { path: '/health' });
      return;
    } catch {
      await delay(25);
    }
  }

  throw new Error(`Timed out waiting for server: ${baseUrl}/health`);
}

async function warmup(baseUrl: string, variant: BenchmarkVariant) {
  let nextIndex = 0;

  await Promise.all(Array.from({ length: 24 }, async () => {
    while (nextIndex < warmupRequests) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      const response = await performRequest(baseUrl, variant.warmupRequest(currentIndex));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`warmup received ${response.statusCode}`);
      }
    }
  }));
}

async function runScenario(baseUrl: string, scenario: ScenarioDefinition): Promise<ScenarioResult> {
  const latencies: number[] = [];
  let nextIndex = 0;
  const startedAt = performance.now();

  await Promise.all(Array.from({ length: scenario.concurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= scenario.requests) {
        return;
      }

      const request = scenario.makeRequest(currentIndex);
      const requestStartedAt = performance.now();
      await performRequest(baseUrl, request);
      latencies.push(performance.now() - requestStartedAt);
    }
  }));

  const totalMs = performance.now() - startedAt;
  const throughput = scenario.requests / (totalMs / 1000);

  return {
    name: scenario.name,
    requests: scenario.requests,
    concurrency: scenario.concurrency,
    throughput,
    avgMs: mean(latencies),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
}

async function performRequest(baseUrl: string, request: BenchmarkRequest) {
  const response = await new Promise<{ statusCode: number; body: string }>((resolvePromise, rejectPromise) => {
    const clientRequest = httpRequest(`${baseUrl}${request.path}`, {
      agent: httpAgent,
      headers: request.headers,
      method: request.method ?? 'GET',
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        resolvePromise({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    clientRequest.on('error', rejectPromise);

    if (request.body) {
      clientRequest.write(request.body);
    }

    clientRequest.end();
  });

  if (response.statusCode >= 400) {
    throw new Error(`Request failed with status ${response.statusCode}: ${response.body}`);
  }

  return response;
}

async function stopProcess(processHandle: ChildProcess) {
  if (processHandle.exitCode !== null) {
    return;
  }

  processHandle.kill('SIGTERM');
  await new Promise<void>((resolvePromise) => {
    processHandle.once('exit', () => resolvePromise());
    setTimeout(() => resolvePromise(), 1000);
  });
}

function aggregateScenarioMeans(samples: RuntimeSample[]) {
  const grouped = groupScenarioResults(samples);
  return grouped.map(([name, scenarios]) => ({
    name,
    requests: scenarios[0]!.requests,
    concurrency: scenarios[0]!.concurrency,
    throughput: mean(scenarios.map((scenario) => scenario.throughput)),
    avgMs: mean(scenarios.map((scenario) => scenario.avgMs)),
    p50Ms: mean(scenarios.map((scenario) => scenario.p50Ms)),
    p95Ms: mean(scenarios.map((scenario) => scenario.p95Ms)),
    p99Ms: mean(scenarios.map((scenario) => scenario.p99Ms)),
  }));
}

function aggregateScenarioMedians(samples: RuntimeSample[]) {
  const grouped = groupScenarioResults(samples);
  return grouped.map(([name, scenarios]) => ({
    name,
    requests: scenarios[0]!.requests,
    concurrency: scenarios[0]!.concurrency,
    throughput: median(scenarios.map((scenario) => scenario.throughput)),
    avgMs: median(scenarios.map((scenario) => scenario.avgMs)),
    p50Ms: median(scenarios.map((scenario) => scenario.p50Ms)),
    p95Ms: median(scenarios.map((scenario) => scenario.p95Ms)),
    p99Ms: median(scenarios.map((scenario) => scenario.p99Ms)),
  }));
}

function groupScenarioResults(samples: RuntimeSample[]) {
  const grouped = new Map<string, ScenarioResult[]>();
  for (const sample of samples) {
    for (const scenario of sample.scenarios) {
      const existing = grouped.get(scenario.name);
      if (existing) {
        existing.push(scenario);
      } else {
        grouped.set(scenario.name, [scenario]);
      }
    }
  }

  return [...grouped.entries()];
}

function renderResults(results: RuntimeResult[]) {
  const meanRows = results.flatMap((result) => result.scenarioMeans.map((scenario) => ({
    launch: result.launch,
    variant: result.variant,
    artifact: result.artifactLabel,
    startupMsMean: result.startupMsMean,
    scenario: scenario.name,
    throughput: scenario.throughput,
    avgMs: scenario.avgMs,
    p50Ms: scenario.p50Ms,
    p95Ms: scenario.p95Ms,
    p99Ms: scenario.p99Ms,
  })));
  const medianRows = results.flatMap((result) => result.scenarioMedians.map((scenario) => ({
    launch: result.launch,
    variant: result.variant,
    artifact: result.artifactLabel,
    startupMsMedian: result.startupMsMedian,
    scenario: scenario.name,
    throughput: scenario.throughput,
    avgMs: scenario.avgMs,
    p50Ms: scenario.p50Ms,
    p95Ms: scenario.p95Ms,
    p99Ms: scenario.p99Ms,
  })));

  return [
    'kivin create benchmark results',
    '',
    `${iterations} execution-phase samples per launch/variant; binary is built once before measurement`,
    '',
    'Mean summary',
    '',
    renderTable([
      ['launch', 'variant', 'artifact', 'startup ms mean', 'scenario', 'req/s mean', 'avg ms mean', 'p50 ms mean', 'p95 ms mean', 'p99 ms mean'],
      ...meanRows.map((row) => [
        row.launch,
        row.variant,
        row.artifact,
        formatNumber(row.startupMsMean),
        row.scenario,
        formatNumber(row.throughput),
        formatNumber(row.avgMs),
        formatNumber(row.p50Ms),
        formatNumber(row.p95Ms),
        formatNumber(row.p99Ms),
      ]),
    ]),
    '',
    'Median summary',
    '',
    renderTable([
      ['launch', 'variant', 'artifact', 'startup ms median', 'scenario', 'req/s median', 'avg ms median', 'p50 ms median', 'p95 ms median', 'p99 ms median'],
      ...medianRows.map((row) => [
        row.launch,
        row.variant,
        row.artifact,
        formatNumber(row.startupMsMedian),
        row.scenario,
        formatNumber(row.throughput),
        formatNumber(row.avgMs),
        formatNumber(row.p50Ms),
        formatNumber(row.p95Ms),
        formatNumber(row.p99Ms),
      ]),
    ]),
  ].join('\n');
}

function renderTable(rows: string[][]) {
  const [header, ...body] = rows;
  const separator = header.map(() => '---');
  return [header, separator, ...body].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function formatBytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatNumber(value: number) {
  return Number(value.toFixed(3)).toString();
}

async function collectProfiles(): Promise<ProfileReport> {
  const rows: ProfileRow[] = [];
  const profile = createProfileFwCreate();

  rows.push(measureSyncProfile('kivin.handler.direct.create', profileRequestIterations, () => profile.directCreate('Ada Lovelace', 'ada@example.com').id));
  rows.push(measureSyncProfile('kivin.guard.raw.create', profileRequestIterations, () => profile.guardAllows(profile.newGuardRequest())));
  rows.push(await measureAsyncProfile('kivin.body.json.parse.create', profileRequestIterations, async () => {
    await profile.parseBody(profile.newBodyRequest());
  }));
  rows.push(measureSyncProfile('kivin.body.schema.validate.create', profileRequestIterations, () => profile.validateBody(profile.newBodyInput()).email));
  rows.push(await measureAsyncProfile('kivin.body.json.parse+validate.create', profileRequestIterations, async () => {
    await profile.parseAndValidateBody(profile.newBodyRequest());
  }));
  rows.push(measureSyncProfile('kivin.response.finalize.created.create', profileRequestIterations, () => {
    return profile.finalizeCreated(profile.newCreatedRecord()).status;
  }));
  rows.push(measureSyncProfile('kivin.pipeline.local.create.prevalidated.no-finalize', profileRequestIterations, () => {
    return profile.completeLocalCreateFromValidated(profile.newValidatedBody()).id;
  }));
  rows.push(measureSyncProfile('kivin.pipeline.local.create.prevalidated.finalize', profileRequestIterations, () => {
    return profile.completeLocalCreateFromValidatedWithFinalize(profile.newValidatedBody()).status;
  }));
  rows.push(await measureAsyncProfile('kivin.pipeline.local.create', profileRequestIterations, async () => {
    const response = await profile.completeLocalCreate(profile.newBodyRequest());
    await response.arrayBuffer();
  }));
  rows.push(await measureAsyncProfile('kivin.pipeline.local.create.no-finalize', profileRequestIterations, async () => {
    await profile.completeLocalCreateWithoutFinalize(profile.newBodyRequest());
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.create', profileRequestIterations, async () => {
    const response = await profile.createFetch(profile.newRequest('create'));
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.create.no-request-id', profileRequestIterations, async () => {
    const response = await profile.createNoRequestIdFetch(profile.newRequest('create-no-request-id'));
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.create.no-guard', profileRequestIterations, async () => {
    const response = await profile.createNoGuardFetch(profile.newRequest('create-no-guard'));
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.create.no-validation', profileRequestIterations, async () => {
    const response = await profile.createNoValidationFetch(profile.newRequest('create-no-validation'));
    await response.arrayBuffer();
  }));

  rows.push(await measureAsyncProfile('kivin.app.fetch.create.bare', profileRequestIterations, async () => {
    const response = await profile.createBareFetch(profile.newRequest('create-bare'));
    await response.arrayBuffer();
  }));

  return { rows };
}

function createProfileFwCreate() {
  const CreateUserSchema = v.object({
    name: v.string(),
    email: v.pipe(v.string(), v.email()),
  });
  const schemaAdapter = createValibotAdapter();

  type CreateUserInput = v.InferOutput<typeof CreateUserSchema>;

  interface UserRecord {
    id: string;
    name: string;
    email: string;
  }

  class UserStore {
    private nextId = 3;
    private readonly users: UserRecord[] = [
      { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
      { id: '2', name: 'Grace Hopper', email: 'grace@example.com' },
    ];

    create(input: CreateUserInput) {
      const created = {
        id: String(this.nextId),
        name: input.name,
        email: input.email,
      };

      this.nextId += 1;
      this.users.push(created);
      return created;
    }
  }

  class RequestIdMiddleware implements NestLikeMiddleware {
    handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
      const request = context.request;
      const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
      context.setResponseHeader('x-request-id', requestId);
      return next();
    }

    handleRaw(request: Request, _params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>) {
      const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
      responseState.setResponseHeader('x-request-id', requestId);
      return next();
    }
  }

  class ApiKeyGuard implements CanActivate {
    canActivateRaw(request: Request) {
      if (request.headers.get('x-api-key') === 'secret') {
        return true;
      }

      throw forbidden();
    }

    canActivate(context: RequestContext) {
      if (context.request.headers.get('x-api-key') === 'secret') {
        return true;
      }

      throw forbidden();
    }
  }

  class BenchmarkController {
    constructor(private readonly logger: Logger, private readonly store: UserStore) {}

    create(input: CreateUserInput) {
      this.logger.info('users.create.requested', () => ({ email: input.email }));
      return this.store.create(input);
    }

    createBare(input: CreateUserInput) {
      return this.store.create(input);
    }
  }

  const store = new UserStore();
  const LoggerModule = createLoggerModule({
    serviceName: 'kivin-benchmark-profile',
    level: 'error',
    sink: () => {},
  });

  const benchmarkModule = defineModule({
    providers: [
      RequestIdMiddleware,
      ApiKeyGuard,
      { provide: UserStore, useValue: store },
      {
        provide: BenchmarkController,
        useFactory: (container) => new BenchmarkController(container.resolve(LOGGER), store),
      },
    ],
    controllers: [BenchmarkController],
    imports: [],
  });

  setInjectableMetadata(BenchmarkController, { deps: [LOGGER, UserStore] });

  const definition = defineApplication({
    modules: [LoggerModule, benchmarkModule],
    schemaAdapter,
    globals: {
      guards: [],
      middleware: [],
      filters: [],
    },
  });

  const buildManifest = (variant: BenchmarkVariant['name']): AppManifest => ({
    routes: [
      {
        method: 'POST',
        fullPath: '/users',
        controller: BenchmarkController,
        methodName: variant === 'create-bare' ? 'createBare' : 'create',
        parameters: [{ index: 0, source: 'body' }],
        guards: variant === 'create-no-guard' || variant === 'create-bare' ? [] : [ApiKeyGuard],
        middleware: [],
        filters: [],
        docs: {
          tags: ['benchmark-profile'],
          bodySchema: variant === 'create-no-validation' || variant === 'create-bare' ? undefined : CreateUserSchema,
          security: [],
          responses: [{ status: 201, description: 'Created' }],
        },
      },
    ],
  });

  const createAppForVariant = (variant: BenchmarkVariant['name']) => createApp({
    ...definition,
    globals: {
      guards: [],
      middleware: variant === 'create' || variant === 'create-no-guard' || variant === 'create-no-validation' ? [RequestIdMiddleware] : [],
      filters: [],
    },
  }, buildManifest(variant));

  const createFetch = createAppForVariant('create').fetch;
  const createNoRequestIdFetch = createAppForVariant('create-no-request-id').fetch;
  const createNoGuardFetch = createAppForVariant('create-no-guard').fetch;
  const createNoValidationFetch = createAppForVariant('create-no-validation').fetch;
  const createBareFetch = createAppForVariant('create-bare').fetch;
  const guard = new ApiKeyGuard();
  const createCreatedResponse = (data: unknown) => createJsonResponseCreated(data);
  const validateParsedBody = (input: unknown) => {
    const result = v.safeParse(CreateUserSchema, input);
    if (!result.success) {
      throw new Error('body validation failed');
    }

    return result.output as CreateUserInput;
  };

  let requestIndex = 0;

  const newBodyInput = () => {
    const index = requestIndex;
    requestIndex += 1;

    return {
      name: `Benchmark User ${index}`,
      email: `benchmark-${index}@example.com`,
    };
  };

  const newValidatedBody = () => validateParsedBody(newBodyInput());

  const newCreatedRecord = () => ({
    id: 'bench-id',
    ...newBodyInput(),
  });

  return {
    createFetch,
    createNoRequestIdFetch,
    createNoGuardFetch,
    createNoValidationFetch,
    createBareFetch,
    completeLocalCreateFromValidated: (input: CreateUserInput) => store.create(input),
    completeLocalCreateFromValidatedWithFinalize: (input: CreateUserInput) => createCreatedResponse(store.create(input)),
    finalizeCreated: (data: unknown) => createCreatedResponse(data),
    directCreate: (name: string, email: string) => store.create({ name, email }),
    guardAllows: (request: Request) => guard.canActivateRaw(request),
    newBodyInput,
    newCreatedRecord,
    newBodyRequest: () => new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(newBodyInput()),
    }),
    newGuardRequest: () => new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'x-api-key': 'secret' },
    }),
    newValidatedBody,
    parseBody: async (request: Request) => request.json() as Promise<CreateUserInput>,
    parseAndValidateBody: async (request: Request) => validateParsedBody(await request.json()),
    completeLocalCreateWithoutFinalize: async (request: Request) => {
      return store.create(validateParsedBody(await request.json()));
    },
    completeLocalCreate: async (request: Request) => {
      return createCreatedResponse(store.create(validateParsedBody(await request.json())));
    },
    newRequest: (variant: BenchmarkVariant['name']) => {
      const body = newBodyInput();
      const headers: Record<string, string> = { 'content-type': 'application/json' };

      if (variant !== 'create-no-guard' && variant !== 'create-bare') {
        headers['x-api-key'] = 'secret';
      }

      return new Request('http://localhost/users', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    },
    validateBody: (input: unknown) => {
      const result = v.safeParse(CreateUserSchema, input);
      if (!result.success) {
        throw new Error('body validation failed');
      }

      return result.output as CreateUserInput;
    },
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
  const sections = [
    'Profiling results',
    '',
    `in-process create microbenchmarks; profile request iterations=${profileRequestIterations}`,
    '',
    '| metric | ops/s | iterations |',
    '| --- | ---: | ---: |',
  ];

  for (const row of report.rows) {
    sections.push(`| ${row.metric} | ${row.opsPerSecond} | ${row.iterations} |`);
  }

  return sections.join('\n');
}

function round(value: number) {
  return Number(value.toFixed(3));
}

function mean(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index]!;
}

function parseSelectedVariants(value: string | undefined) {
  if (!value) {
    return null;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return new Set(entries);
}
