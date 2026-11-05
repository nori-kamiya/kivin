// Performance regression gate: compares this tree against a base git ref on the same machine.
//
//   bun run perf:regression                 # base = origin/main
//   bun run perf:regression -- --base HEAD~1
//
// Both trees run the identical benchmark app (scripts/perf/bench-app.ts). In-process, both apps
// live in one process and alternate short timed blocks (scripts/perf/paired.ts), which cancels most
// machine noise; for HTTP both compiled binaries run at once and the client alternates load blocks
// between them (scripts/perf/load.ts). It fails when:
//   - any in-process scenario's median paired ratio drops more than PERF_SCENARIO_THRESHOLD (default 4%)
//     and its bootstrap 95% CI lies entirely below 1 (i.e. the slowdown is statistically clear);
//     a suspected scenario is re-measured with more rounds and must fail again
//   - the geometric mean over all scenarios drops more than PERF_GEOMEAN_THRESHOLD (default 1.5%), same CI rule
//   - the compiled binary grows more than PERF_SIZE_THRESHOLD (default 5%)
//   - median startup grows by more than PERF_STARTUP_SLACK_MS (default 10ms) and 25%
// HTTP throughput (both binaries serving, client alternating) is reported but only warns: on shared
// runners the load client competes with the servers for CPU, so it is too noisy to block a merge.
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const cacheDir = join(repoRoot, '.cache/perf');
const args = parseArgs(process.argv.slice(2));

const baseRef = args.base ?? process.env.PERF_BASE_REF ?? 'origin/main';
const rounds = Number(args.rounds ?? process.env.PERF_ROUNDS ?? 3);
const netRounds = Number(args['net-rounds'] ?? process.env.PERF_NET_ROUNDS ?? 2);
const skipNetwork = args['no-network'] === 'true' || process.env.PERF_SKIP_NETWORK === '1';
const scenarioThreshold = Number(process.env.PERF_SCENARIO_THRESHOLD ?? 0.04);
const geomeanThreshold = Number(process.env.PERF_GEOMEAN_THRESHOLD ?? 0.015);
const netWarnThreshold = Number(process.env.PERF_NET_WARN_THRESHOLD ?? 0.10);
const sizeThreshold = Number(process.env.PERF_SIZE_THRESHOLD ?? 0.05);
const startupSlackMs = Number(process.env.PERF_STARTUP_SLACK_MS ?? 10);

type Side = 'base' | 'current';

interface Runner {
  side: Side;
  tree: string;
  dir: string;
}

const baseSha = (await run(['git', 'rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot)).trim();
const baseTree = join(cacheDir, `tree-${baseSha.slice(0, 12)}`);
if (!existsSync(join(baseTree, 'packages'))) {
  await rm(baseTree, { recursive: true, force: true });
  await run(['git', 'worktree', 'prune'], repoRoot);
  await run(['git', 'worktree', 'add', '--detach', baseTree, baseSha], repoRoot);
}
await linkNodeModules(baseTree);

const runners: Record<Side, Runner> = {
  base: await prepareRunner('base', baseTree),
  current: await prepareRunner('current', repoRoot),
};

console.log(`perf regression: base ${baseRef} (${baseSha.slice(0, 12)}) vs current tree, ${rounds} paired in-process rounds`);

// ---- in-process (paired) ------------------------------------------------------------------
// Each round is a fresh process holding both apps; every scenario yields PERF_PAIRS paired ratios.
const ratiosByScenario = new Map<string, number[]>();
const opsBySide: Record<Side, Map<string, number[]>> = { base: new Map(), current: new Map() };

async function measureInProcess(roundCount: number, scenarioFilter?: string[]) {
  for (let round = 0; round < roundCount; round += 1) {
    const output = await run(
      [process.execPath, join(runners.current.dir, 'paired.ts'), join(runners.base.dir, 'bench-app.bundle.js'), join(runners.current.dir, 'bench-app.bundle.js')],
      runners.current.dir,
      scenarioFilter ? { PERF_SCENARIOS: scenarioFilter.join(',') } : {},
    );
    for (const result of parseJsonLine<{ results: Array<{ name: string; base: number[]; current: number[]; ratios: number[] }> }>(output).results) {
      for (const ratio of result.ratios) {
        push(ratiosByScenario, result.name, ratio);
      }
      push(opsBySide.base, result.name, median(result.base));
      push(opsBySide.current, result.name, median(result.current));
    }
    process.stdout.write(`  in-process round ${round + 1}/${roundCount}${scenarioFilter ? ` (confirming ${scenarioFilter.join(', ')})` : ''} done\n`);
  }
}

const random = seededRandom(42);

function evaluateScenario(name: string) {
  const ratios = ratiosByScenario.get(name)!;
  const ratio = median(ratios);
  const [low, high] = bootstrapInterval(ratios, median, random);
  // A regression must be both larger than the threshold and statistically clear (whole CI below 1).
  return { ratio, low, high, failed: ratio < 1 - scenarioThreshold && high < 1 };
}

await measureInProcess(rounds);
const scenarioNames = [...ratiosByScenario.keys()];

// Confirmation pass: a suspected regression is re-measured with twice the rounds (samples are
// added, not replaced) and only counts if it still fails. Keeps the gate strict without flaking.
const suspects = scenarioNames.filter((name) => evaluateScenario(name).failed);
if (suspects.length > 0) {
  await measureInProcess(rounds * 2, suspects);
}

const failures: string[] = [];
const warnings: string[] = [];
const report: string[] = [
  '### In-process throughput (paired, same process)',
  '',
  '| scenario | base ops/s | current ops/s | change | 95% CI |',
  '| --- | ---: | ---: | ---: | ---: |',
];
for (const name of scenarioNames) {
  const { ratio, low, high, failed } = evaluateScenario(name);
  if (failed) {
    failures.push(`in-process ${name}: ${formatChange(ratio)} (95% CI ${formatChange(low)} … ${formatChange(high)}, limit -${percent(scenarioThreshold)})`);
  }
  report.push(`| ${name} | ${Math.round(median(opsBySide.base.get(name)!)).toLocaleString('en-US')} | ${Math.round(median(opsBySide.current.get(name)!)).toLocaleString('en-US')} | ${formatChange(ratio)}${failed ? ' ❌' : ''} | ${formatChange(low)} … ${formatChange(high)} |`);
}

const geomeanOf = (samples: number[][]) => Math.exp(samples.reduce((sum, values) => sum + Math.log(median(values)), 0) / samples.length);
const allRatios = scenarioNames.map((name) => ratiosByScenario.get(name)!);
const geomean = geomeanOf(allRatios);
const geomeanSamples = Array.from({ length: 2000 }, () => geomeanOf(allRatios.map((values) => resample(values, random))));
geomeanSamples.sort((left, right) => left - right);
const geomeanHigh = geomeanSamples[Math.floor(geomeanSamples.length * 0.975)]!;
const geomeanLow = geomeanSamples[Math.floor(geomeanSamples.length * 0.025)]!;
report.push('', `Geometric mean: **${formatChange(geomean)}** (95% CI ${formatChange(geomeanLow)} … ${formatChange(geomeanHigh)}, limit -${percent(geomeanThreshold)})`);
if (geomean < 1 - geomeanThreshold && geomeanHigh < 1) {
  failures.push(`in-process geometric mean: ${formatChange(geomean)} (limit -${percent(geomeanThreshold)})`);
}

// ---- compiled binary: size, startup, HTTP ------------------------------------------------
if (!skipNetwork) {
  const binaries: Record<Side, string> = { base: '', current: '' };
  for (const side of ['base', 'current'] as const) {
    binaries[side] = join(runners[side].dir, 'perf-server');
    await run([process.execPath, 'build', join(runners[side].dir, 'server.ts'), '--compile', '--outfile', binaries[side]], runners[side].dir);
  }

  const sizes = { base: (await stat(binaries.base)).size, current: (await stat(binaries.current)).size };
  const sizeRatio = sizes.current / sizes.base;
  if (sizeRatio > 1 + sizeThreshold) {
    failures.push(`binary size: ${formatChange(sizeRatio)} (limit +${percent(sizeThreshold)})`);
  }

  // Startup: launch each binary alternately and time until it prints READY.
  const startups: Record<Side, number[]> = { base: [], current: [] };
  for (let round = 0; round < 6; round += 1) {
    for (const side of (round % 2 === 0 ? ['base', 'current'] : ['current', 'base']) as Side[]) {
      const server = await startServer(binaries[side]);
      startups[side].push(server.startupMs);
      server.stop();
    }
  }

  // HTTP: both binaries serve at once, the client alternates load blocks between them.
  const httpRatios = new Map<string, number[]>();
  const httpRps: Record<Side, Map<string, number[]>> = { base: new Map(), current: new Map() };
  for (let round = 0; round < netRounds; round += 1) {
    const baseServer = await startServer(binaries.base);
    const currentServer = await startServer(binaries.current);
    try {
      const output = await run(
        [process.execPath, join(runners.current.dir, 'load.ts'), `http://127.0.0.1:${baseServer.port}`, `http://127.0.0.1:${currentServer.port}`],
        runners.current.dir,
      );
      for (const result of parseJsonLine<{ results: Array<{ name: string; base: number[]; current: number[]; ratios: number[] }> }>(output).results) {
        for (const ratio of result.ratios) {
          push(httpRatios, result.name, ratio);
        }
        push(httpRps.base, result.name, median(result.base));
        push(httpRps.current, result.name, median(result.current));
      }
    } finally {
      baseServer.stop();
      currentServer.stop();
    }
    process.stdout.write(`  http round ${round + 1}/${netRounds} done\n`);
  }

  report.push('', '### HTTP throughput via compiled binary (paired)', '', '| scenario | base req/s | current req/s | change | 95% CI |', '| --- | ---: | ---: | ---: | ---: |');
  for (const [name, ratios] of httpRatios) {
    const ratio = median(ratios);
    const [low, high] = bootstrapInterval(ratios, median, random);
    // Report-only: the load client shares the machine with both servers, so HTTP numbers are far
    // noisier than in-process ones. Flag large, clear drops for a human to look at.
    const suspicious = ratio < 1 - netWarnThreshold && high < 1;
    if (suspicious) {
      warnings.push(`http ${name}: ${formatChange(ratio)} (95% CI ${formatChange(low)} … ${formatChange(high)})`);
    }
    report.push(`| ${name} | ${Math.round(median(httpRps.base.get(name)!)).toLocaleString('en-US')} | ${Math.round(median(httpRps.current.get(name)!)).toLocaleString('en-US')} | ${formatChange(ratio)}${suspicious ? ' ⚠️' : ''} | ${formatChange(low)} … ${formatChange(high)} |`);
  }

  const startupBase = median(startups.base);
  const startupCurrent = median(startups.current);
  if (startupCurrent > startupBase + startupSlackMs && startupCurrent > startupBase * 1.25) {
    failures.push(`startup: ${startupBase.toFixed(1)}ms -> ${startupCurrent.toFixed(1)}ms`);
  }
  report.push(
    '',
    `Binary size: ${formatBytes(sizes.base)} → ${formatBytes(sizes.current)} (${formatChange(sizeRatio)}, limit +${percent(sizeThreshold)})`,
    `Startup (median): ${startupBase.toFixed(1)}ms → ${startupCurrent.toFixed(1)}ms`,
  );
}

if (warnings.length > 0) {
  report.push('', `⚠️ HTTP drops worth a look (not blocking):\n${warnings.map((warning) => `- ${warning}`).join('\n')}`);
}
report.push('', failures.length === 0 ? '**No performance regression detected.**' : `**${failures.length} regression(s):**\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
const markdown = `## kivin performance vs \`${baseRef}\` (${baseSha.slice(0, 12)})\n\n${report.join('\n')}\n`;
console.log(`\n${markdown}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
}
if (args.output) {
  await writeFile(resolve(args.output), markdown);
}
process.exit(failures.length === 0 ? 0 : 1);

// ---- helpers ------------------------------------------------------------------------------

async function prepareRunner(side: Side, tree: string): Promise<Runner> {
  const dir = join(cacheDir, `runner-${side}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // The benchmark files always come from the current tree so both sides run identical code.
  await cp(join(repoRoot, 'scripts/perf'), dir, { recursive: true, filter: (source) => !source.includes(`${join('scripts', 'perf', 'generated')}`) });
  // The app source is written against each tree's own API (e.g. legacy vs TC39 decorators), so it
  // comes from that tree when it has one; scenarios and harness always come from the current tree.
  if (tree !== repoRoot && existsSync(join(tree, 'scripts/perf/app'))) {
    await rm(join(dir, 'app'), { recursive: true, force: true });
    await cp(join(tree, 'scripts/perf/app'), join(dir, 'app'), { recursive: true });
  }
  const legacyDecorators = /"experimentalDecorators"\s*:\s*true/.test(await Bun.file(join(tree, 'tsconfig.base.json')).text());
  const paths = Object.fromEntries(
    ['core', 'decorators', 'logger', 'openapi', 'valibot'].map((name) => [`@kivin/${name}`, [join(tree, `packages/${name}/src/index.ts`)]]),
  );
  // Bun reads decorator semantics and path aliases from the tsconfig next to the entry / cwd.
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      experimentalDecorators: legacyDecorators,
      emitDecoratorMetadata: false,
      verbatimModuleSyntax: true,
      paths,
    },
  }, null, 2));
  await linkNodeModules(dir);
  // Each side builds the benchmark manifest with its own CLI, so generator changes are measured too.
  await run(
    [process.execPath, join(tree, 'packages/cli/src/bin.ts'), 'generate', '--entry', join(dir, 'app/app.ts'), '--outDir', join(dir, 'generated')],
    dir,
  );
  // Bun picks the decorator semantics per process, so each side is pre-bundled (decorators already
  // transpiled with its own settings) and the paired benchmark loads two plain JS bundles.
  await run([process.execPath, 'build', join(dir, 'bench-app.ts'), '--target', 'bun', '--outfile', join(dir, 'bench-app.bundle.js')], dir);
  return { side, tree, dir };
}

/** Links the repo's installed dependencies (root and per-workspace) into a worktree or runner dir. */
async function linkNodeModules(dir: string) {
  if (resolve(dir) === repoRoot) {
    return;
  }
  const links: Array<[string, string]> = [[join(repoRoot, 'node_modules'), join(dir, 'node_modules')]];
  if (existsSync(join(dir, 'packages'))) {
    for (const entry of await readdir(join(repoRoot, 'packages'))) {
      links.push([join(repoRoot, 'packages', entry, 'node_modules'), join(dir, 'packages', entry, 'node_modules')]);
    }
  }
  for (const [source, target] of links) {
    if (existsSync(source) && !existsSync(target) && existsSync(join(target, '..'))) {
      await symlink(source, target, 'dir');
    }
  }
}

async function startServer(binary: string) {
  const startedAt = performance.now();
  const child = Bun.spawn([binary], { env: { ...process.env, PORT: '0' }, stdout: 'pipe', stderr: 'inherit' });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`${binary} exited before becoming ready`);
    }
    buffer += decoder.decode(value);
  }
  const startupMs = performance.now() - startedAt;
  const match = /READY (\d+)/.exec(buffer);
  if (!match) {
    child.kill();
    throw new Error(`unexpected server output: ${buffer}`);
  }
  return { port: Number(match[1]), startupMs, stop: () => child.kill() };
}

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) {
    throw new Error(`${command.join(' ')} failed (${code}) in ${cwd}\n${stderr}${stdout}`);
  }
  return stdout;
}

function parseJsonLine<T>(output: string): T {
  const line = output.trim().split('\n').reverse().find((candidate) => candidate.startsWith('{'));
  if (!line) {
    throw new Error(`no JSON output:\n${output}`);
  }
  return JSON.parse(line) as T;
}

function push(map: Map<string, number[]>, key: string, value: number) {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}

function median(values: number[]) {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}


function resample(values: number[], random: () => number) {
  return values.map(() => values[Math.floor(random() * values.length)]!);
}

/** Percentile bootstrap 95% interval of `statistic` over `values`. */
function bootstrapInterval(values: number[], statistic: (values: number[]) => number, random: () => number): [number, number] {
  const samples = Array.from({ length: 2000 }, () => statistic(resample(values, random))).sort((left, right) => left - right);
  return [samples[Math.floor(samples.length * 0.025)]!, samples[Math.floor(samples.length * 0.975)]!];
}

/** Deterministic PRNG (mulberry32) so a given set of samples always yields the same verdict. */
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

function formatChange(ratio: number) {
  const change = (ratio - 1) * 100;
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

function percent(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function parseArgs(argv: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[key] = 'true';
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
