// Per-scenario timing for profiling: runs bench scenarios in a tight `app.fetch` loop and prints
// ns/request. Not a regression check (use `bun run perf:regression`); meant to be run under the
// CPU profiler to see where a scenario spends its time:
//
//   bun packages/cli/src/bin.ts generate --entry scripts/perf/app/app.ts --outDir scripts/perf/generated
//   ONLY=patch-global-mw bun --cpu-prof --cpu-prof-dir=/tmp/prof scripts/perf/profile.ts
//   bun scripts/perf/summarize-profile.ts /tmp/prof
//
// ONLY=a,b selects scenarios, N sets the measured requests per scenario (default 200000).
import { createBenchApp, scenarios } from './bench-app';

const only = process.env.ONLY?.split(',');
const n = Number(process.env.N ?? 200_000);
const apps = new Map<string, ReturnType<typeof createBenchApp>>();

for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) {
    continue;
  }
  const variant = scenario.app ?? 'default';
  const app = apps.get(variant) ?? createBenchApp(scenario.app);
  apps.set(variant, app);
  for (let index = 0; index < 20_000; index += 1) {
    await (await app.fetch(scenario.request())).arrayBuffer();
  }
  const startedAt = performance.now();
  for (let index = 0; index < n; index += 1) {
    await (await app.fetch(scenario.request())).arrayBuffer();
  }
  console.log(`${scenario.name.padEnd(22)} ${(((performance.now() - startedAt) * 1e6) / n).toFixed(0)} ns/req`);
}
