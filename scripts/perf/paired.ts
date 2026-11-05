// Paired in-process benchmark: loads the base and the current bench app into ONE process and
// alternates short timed blocks between them (A B B A ...), so CPU frequency, noisy neighbours and
// GC drift hit both sides equally. Each adjacent block pair yields one current/base throughput ratio.
//
//   bun paired.ts <base bench-app bundle> <current bench-app bundle>
// Prints one JSON line: { results: [{ name, base: ops[], current: ops[], ratios: number[] }] }.
import type { BenchScenario } from './bench-app';

type BenchApp = { fetch: (request: Request) => Response | Promise<Response> };
type BenchModule = { createBenchApp: (variant?: BenchScenario['app']) => BenchApp; scenarios: BenchScenario[] };

const [basePath, currentPath] = process.argv.slice(2);
if (!basePath || !currentPath) {
  throw new Error('usage: bun paired.ts <base bench-app bundle> <current bench-app bundle>');
}

const blockMs = Number(process.env.PERF_BLOCK_MS ?? 60);
const pairs = Number(process.env.PERF_PAIRS ?? 16);
const warmupOps = Number(process.env.PERF_WARMUP_OPS ?? 4000);
const only = process.env.PERF_SCENARIOS?.split(',');

const baseModule = (await import(basePath)) as BenchModule;
const currentModule = (await import(currentPath)) as BenchModule;
// One app per side and variant, created lazily. Both bundles share the harness (scenarios, bench-app.ts)
// from the current tree, so every variant exists on both sides.
const modules = [baseModule, currentModule] as const;
const apps = [new Map<string, BenchApp>(), new Map<string, BenchApp>()] as const;
function appFor(sideIndex: 0 | 1, scenario: BenchScenario) {
  const variant = scenario.app ?? 'default';
  let app = apps[sideIndex].get(variant);
  if (!app) {
    app = modules[sideIndex].createBenchApp(variant);
    apps[sideIndex].set(variant, app);
  }
  return app;
}
const sides = [{ scenarios: baseModule.scenarios }, { scenarios: currentModule.scenarios }] as const;

async function block(app: BenchApp, scenario: BenchScenario) {
  let ops = 0;
  const startedAt = performance.now();
  let elapsed = 0;
  while (elapsed < blockMs) {
    for (let index = 0; index < 32; index += 1) {
      await (await app.fetch(scenario.request())).arrayBuffer();
    }
    ops += 32;
    elapsed = performance.now() - startedAt;
  }
  return (ops * 1000) / elapsed;
}

const results: Array<{ name: string; base: number[]; current: number[]; ratios: number[] }> = [];

for (const [index, scenario] of sides[0].scenarios.entries()) {
  if (only && !only.includes(scenario.name)) {
    continue;
  }
  const scenarioPerSide = [scenario, sides[1].scenarios[index]!] as const;
  if (scenarioPerSide[1].name !== scenario.name) {
    throw new Error(`scenario mismatch: ${scenario.name} vs ${scenarioPerSide[1].name}`);
  }

  const sideApps = [appFor(0, scenarioPerSide[0]), appFor(1, scenarioPerSide[1])] as const;
  for (const sideIndex of [0, 1] as const) {
    const current = scenarioPerSide[sideIndex]!;
    const app = sideApps[sideIndex];
    const label = sideIndex === 0 ? 'base' : 'current';
    const first = await app.fetch(current.request());
    await first.arrayBuffer();
    if (first.status !== current.status) {
      console.error(`${current.name} (${label}): expected status ${current.status}, got ${first.status}`);
      process.exit(2);
    }
    if (current.header && !first.headers.has(current.header)) {
      console.error(`${current.name} (${label}): expected response header ${current.header}`);
      process.exit(2);
    }
    for (let op = 0; op < warmupOps; op += 1) {
      await (await app.fetch(current.request())).arrayBuffer();
    }
  }

  const base: number[] = [];
  const current: number[] = [];
  const ratios: number[] = [];
  for (let pair = 0; pair < pairs; pair += 1) {
    // Alternate which side goes first so neither always benefits from a warmer cache.
    if (pair % 2 === 0) {
      const b = await block(sideApps[0], scenarioPerSide[0]);
      const c = await block(sideApps[1], scenarioPerSide[1]);
      base.push(b);
      current.push(c);
      ratios.push(c / b);
    } else {
      const c = await block(sideApps[1], scenarioPerSide[1]);
      const b = await block(sideApps[0], scenarioPerSide[0]);
      base.push(b);
      current.push(c);
      ratios.push(c / b);
    }
  }

  results.push({ name: scenario.name, base, current, ratios });
}

console.log(JSON.stringify({ results }));
