// Paired HTTP load client for scripts/perf-regression.ts.
//
//   bun load.ts <base url> <current url>
//
// Both compiled servers run at the same time; for each scenario the client alternates short load
// blocks between them (A B, B A, ...) so each adjacent pair yields one current/base ratio.
// Prints one JSON line: { results: [{ name, base: rps[], current: rps[], ratios: number[] }] }.
import { scenarios } from './bench-app';

const [baseUrl, currentUrl] = process.argv.slice(2);
if (!baseUrl || !currentUrl) {
  throw new Error('usage: bun load.ts <base url> <current url>');
}

const blockMs = Number(process.env.PERF_NET_BLOCK_MS ?? 300);
const pairs = Number(process.env.PERF_NET_PAIRS ?? 6);
const concurrency = Number(process.env.PERF_NET_CONCURRENCY ?? 32);
const only = process.env.PERF_SCENARIOS?.split(',');

async function prepare(url: string, scenario: (typeof scenarios)[number]) {
  const template = scenario.request();
  const parsed = new URL(template.url);
  const target = `${url}${parsed.pathname}${parsed.search}`;
  const body = template.body ? await template.text() : undefined;
  const init: RequestInit = { method: template.method, headers: template.headers, ...(body ? { body } : {}) };

  const first = await fetch(target, init);
  await first.arrayBuffer();
  if (first.status !== scenario.status) {
    console.error(`${scenario.name} @ ${url}: expected status ${scenario.status}, got ${first.status}`);
    process.exit(2);
  }
  await loadBlock(target, init, 400);
  return { target, init };
}

async function loadBlock(target: string, init: RequestInit, durationMs: number) {
  let completed = 0;
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      await (await fetch(target, init)).arrayBuffer();
      completed += 1;
    }
  }));
  return (completed * 1000) / (performance.now() - startedAt);
}

const results: Array<{ name: string; base: number[]; current: number[]; ratios: number[] }> = [];
for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) {
    continue;
  }
  const baseTarget = await prepare(baseUrl, scenario);
  const currentTarget = await prepare(currentUrl, scenario);
  const base: number[] = [];
  const current: number[] = [];
  const ratios: number[] = [];
  for (let pair = 0; pair < pairs; pair += 1) {
    let b: number;
    let c: number;
    if (pair % 2 === 0) {
      b = await loadBlock(baseTarget.target, baseTarget.init, blockMs);
      c = await loadBlock(currentTarget.target, currentTarget.init, blockMs);
    } else {
      c = await loadBlock(currentTarget.target, currentTarget.init, blockMs);
      b = await loadBlock(baseTarget.target, baseTarget.init, blockMs);
    }
    base.push(b);
    current.push(c);
    ratios.push(c / b);
  }
  results.push({ name: scenario.name, base, current, ratios });
}

console.log(JSON.stringify({ results }));
