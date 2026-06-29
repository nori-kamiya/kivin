const bunExecutable = process.execPath;
const iterations = Number(process.env.PERF_GATE_ITERATIONS ?? 5);

interface HealthRow {
  artifactBytes: number | null;
  artifactLabel: string;
  healthMode: string;
  iterations: number;
  launch: 'compiled' | 'source';
  name: 'kivin' | 'hono';
  startupMs: number;
  throughput: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
}

interface StackRow {
  artifactBytes: number | null;
  artifactLabel: string;
  iterations: number;
  launch: 'compiled' | 'source';
  name: 'kivin' | 'hono' | 'elysia';
  scenarioMedians: Array<{
    name: string;
    requests: number;
    concurrency: number;
    throughput: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }>;
  startupMsMedian: number;
  variant: 'health' | 'docs' | 'users' | 'create' | 'patch' | 'delete';
}

const healthReport = await runJsonCommand<HealthRow[]>('bench:health');
const stackReport = await runJsonCommand<StackRow[]>('bench:stack', {
  BENCH_VARIANTS: 'docs,patch,create',
});

const healthRows = healthReport.benchmarks;
const stackRows = stackReport.benchmarks;
const failures: string[] = [];

assertRatio({
  failures,
  actual: throughputForHealth(healthRows, 'kivin', 'compiled', 'static-object'),
  expected: throughputForHealth(healthRows, 'kivin', 'compiled', 'context-json'),
  minimumRatio: 1.15,
  label: 'kivin compiled static-object health vs kivin compiled context-json health',
});

assertRatio({
  failures,
  actual: throughputForHealth(healthRows, 'kivin', 'compiled', 'plain-response'),
  expected: throughputForHealth(healthRows, 'kivin', 'compiled', 'context-json'),
  minimumRatio: 1.10,
  label: 'kivin compiled plain-response health vs kivin compiled context-json health',
});

assertRatio({
  failures,
  actual: throughputForStack(stackRows, 'kivin', 'source', 'docs'),
  expected: throughputForStack(stackRows, 'hono', 'source', 'docs'),
  minimumRatio: 1.05,
  label: 'kivin source docs vs hono source docs',
});

assertRatio({
  failures,
  actual: throughputForStack(stackRows, 'kivin', 'source', 'patch'),
  expected: throughputForStack(stackRows, 'hono', 'source', 'patch'),
  minimumRatio: 1.0,
  label: 'kivin source patch vs hono source patch',
});

assertRatio({
  failures,
  actual: throughputForStack(stackRows, 'kivin', 'source', 'create'),
  expected: throughputForStack(stackRows, 'hono', 'source', 'create'),
  minimumRatio: 1.05,
  label: 'kivin source create vs hono source create',
});

assertRatio({
  failures,
  actual: throughputForStack(stackRows, 'kivin', 'compiled', 'create'),
  expected: throughputForStack(stackRows, 'hono', 'compiled', 'create'),
  minimumRatio: 0.95,
  label: 'kivin compiled create vs hono compiled create',
});

if (failures.length > 0) {
  console.error('Performance gate failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Performance gate passed with ${iterations} iterations.`);

async function runJsonCommand<T>(scriptName: string, extraEnv: Record<string, string> = {}): Promise<{ benchmarks: T }> {
  const processHandle = Bun.spawn({
    cmd: [bunExecutable, 'run', scriptName],
    env: {
      ...process.env,
      BENCH_ITERATIONS: String(iterations),
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const output = await new Response(processHandle.stdout).text();
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    throw new Error(`${scriptName} exited with code ${exitCode}`);
  }

  const jsonStart = output.indexOf('{\n  "benchmarks"');
  if (jsonStart === -1) {
    throw new Error(`${scriptName} did not emit JSON output`);
  }

  return JSON.parse(output.slice(jsonStart)) as { benchmarks: T };
}

function throughputForHealth(rows: HealthRow[], name: HealthRow['name'], launch: HealthRow['launch'], healthMode: string) {
  const row = rows.find((candidate) => candidate.name === name && candidate.launch === launch && candidate.healthMode === healthMode);
  if (!row) {
    throw new Error(`Missing health row for ${name}/${launch}/${healthMode}`);
  }

  return row.throughput;
}

function throughputForStack(rows: StackRow[], name: StackRow['name'], launch: StackRow['launch'], variant: StackRow['variant']) {
  const row = rows.find((candidate) => candidate.name === name && candidate.launch === launch && candidate.variant === variant);
  if (!row) {
    throw new Error(`Missing stack row for ${name}/${launch}/${variant}`);
  }

  const scenario = row.scenarioMedians[0];
  if (!scenario) {
    throw new Error(`Missing stack scenario for ${name}/${launch}/${variant}`);
  }

  return scenario.throughput;
}

function assertRatio(input: {
  failures: string[];
  actual: number;
  expected: number;
  minimumRatio: number;
  label: string;
}) {
  const ratio = input.actual / input.expected;
  if (ratio >= input.minimumRatio) {
    return;
  }

  input.failures.push(`${input.label} dropped to ${(ratio * 100).toFixed(1)}% of expected (${input.actual.toFixed(3)} vs ${input.expected.toFixed(3)}; required ${(input.minimumRatio * 100).toFixed(1)}%)`);
}