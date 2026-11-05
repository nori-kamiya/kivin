// In-process throughput for every bench scenario: `app.fetch(request)` in a tight loop, no network.
// Prints one JSON line: { results: [{ name, opsPerSec }] }. Run by scripts/perf-regression.ts.
import { createBenchApp, scenarios } from './bench-app';

const durationMs = Number(process.env.PERF_DURATION_MS ?? 400);
const warmupOps = Number(process.env.PERF_WARMUP_OPS ?? 3000);
const only = process.env.PERF_SCENARIOS?.split(',');

const app = createBenchApp();
const results: Array<{ name: string; opsPerSec: number }> = [];

for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) {
    continue;
  }

  const first = await app.fetch(scenario.request());
  await first.arrayBuffer();
  if (first.status !== scenario.status) {
    console.error(`${scenario.name}: expected status ${scenario.status}, got ${first.status}`);
    process.exit(2);
  }

  for (let index = 0; index < warmupOps; index += 1) {
    await (await app.fetch(scenario.request())).arrayBuffer();
  }

  let ops = 0;
  const startedAt = performance.now();
  let elapsed = 0;
  while (elapsed < durationMs) {
    // Check the clock every 64 requests to keep timer overhead out of the loop.
    for (let index = 0; index < 64; index += 1) {
      await (await app.fetch(scenario.request())).arrayBuffer();
    }
    ops += 64;
    elapsed = performance.now() - startedAt;
  }

  results.push({ name: scenario.name, opsPerSec: Math.round((ops * 1000) / elapsed) });
}

console.log(JSON.stringify({ results }));
