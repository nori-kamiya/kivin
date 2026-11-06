// Installs the .release tarballs into a throwaway project outside the repository and drives the installed
// CLI, the type checker, `bun build --compile` and `kivin dev` against a small decorated app.
// Run `bun run release:pack` first. Set KEEP_PACK_SMOKE=1 to keep the temp directory for inspection.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReleaseManifest } from './release/publish';

const root = resolve(import.meta.dir, '..');
const releaseDir = join(root, '.release');
const manifestPath = join(releaseDir, 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error('pack-smoke: .release/manifest.json not found. Run `bun run release:pack` first.');
  process.exit(1);
}
const release = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest;
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
const expectedVersion = release.packages[0]?.version ?? '';

// realpath: macOS reports /var/folders as /private/var/folders, and bun records whichever it resolves.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'kivin-pack-smoke-')));
const appDir = join(work, 'app');
const runDir = join(work, 'run-without-node_modules');
const children = new Set<Bun.Subprocess>();
let finished = false;

// Children are spawned detached, so each leads its own process group. `kivin dev` forks the app server, and a
// SIGKILL aimed at the supervisor alone would orphan that grandchild with its port still bound.
function killGroup(child: Bun.Subprocess, signal: NodeJS.Signals): void {
  for (const target of [-child.pid, child.pid]) {
    try {
      process.kill(target, signal);
    } catch {
      // already gone
    }
  }
}

function cleanup(): void {
  for (const child of children) killGroup(child, 'SIGKILL');
  children.clear();
  if (process.env.KEEP_PACK_SMOKE) {
    console.log(`pack-smoke: kept ${work}`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}

function fail(message: string): never {
  console.error(`\npack-smoke FAILED: ${message}`);
  cleanup();
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => fail(`interrupted by ${signal}`));
}
process.on('exit', () => {
  if (!finished) cleanup();
});

function step(name: string): void {
  console.log(`\n== ${name}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

async function exec(command: string[], options: { cwd: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  children.add(child);
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), options.timeoutMs ?? 180_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  children.delete(child);
  return { stdout, stderr, exitCode };
}

async function mustRun(label: string, command: string[], cwd = appDir, env?: Record<string, string>): Promise<string> {
  const result = await exec(command, { cwd, ...(env ? { env } : {}) });
  if (result.exitCode !== 0) {
    fail(`${label} exited with ${result.exitCode}\n$ ${command.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  void server.stop(true);
  return port;
}

async function waitFor(url: string, child: Bun.Subprocess, label: string): Promise<Response> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`${label} exited early with ${child.exitCode}`);
    try {
      return await fetch(url);
    } catch {
      await Bun.sleep(100);
    }
  }
  return fail(`${label} did not answer ${url} within 30s`);
}

function spawnServer(command: string[], cwd: string, port: number): Bun.Subprocess {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, PORT: String(port) }, stdout: 'ignore', stderr: 'ignore', detached: true });
  children.add(child);
  return child;
}

async function exercise(baseUrl: string, label: string): Promise<void> {
  const greeting = await fetch(`${baseUrl}/greetings/Ada`);
  assert(greeting.status === 200, `${label}: GET /greetings/Ada returned ${greeting.status}`);
  const greetingBody = (await greeting.json()) as { message?: string };
  assert(greetingBody.message === 'Hello, Ada', `${label}: unexpected greeting ${JSON.stringify(greetingBody)}`);

  const created = await fetch(`${baseUrl}/greetings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Grace' }) });
  assert(created.status === 201, `${label}: valid POST returned ${created.status}`);

  const invalid = await fetch(`${baseUrl}/greetings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '' }) });
  assert(invalid.status >= 400 && invalid.status < 500, `${label}: the valibot schema did not reject an empty name (status ${invalid.status})`);
}

const files: Record<string, string> = {
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ESNext'],
        types: ['bun'],
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
        noEmit: true,
      },
      include: ['src/**/*.ts', '.kivin/generated/**/*.ts'],
    },
    null,
    2,
  ),
  'src/greeting.schemas.ts': `import * as v from 'valibot';

export const NameParamSchema = v.object({ name: v.string() });
export const CreateGreetingSchema = v.object({ name: v.pipe(v.string(), v.minLength(1)) });
export const GreetingSchema = v.object({ message: v.string() });
`,
  'src/greeting.service.ts': `import { Injectable } from '@kivinjs/decorators';
import { LOGGER, type Logger } from '@kivinjs/logger';

@Injectable({ deps: [LOGGER] })
export class GreetingService {
  constructor(private readonly logger: Logger) {}

  greet(name: string) {
    this.logger.info('greeting.created', { name });
    return { message: \`Hello, \${name}\` };
  }
}
`,
  'src/greeting.controller.ts': `import type { RouteInput } from '@kivinjs/core';
import { ApiResponse, Controller, Get, Injectable, OperationId, Post, UseBodySchema, UseParamSchema } from '@kivinjs/decorators';
import { CreateGreetingSchema, GreetingSchema, NameParamSchema } from './greeting.schemas';
import { GreetingService } from './greeting.service';

@Controller('/greetings')
@Injectable({ deps: [GreetingService] })
export class GreetingController {
  constructor(private readonly greetings: GreetingService) {}

  @Get('/:name')
  @OperationId('greetings.greet')
  @UseParamSchema(NameParamSchema)
  @ApiResponse(200, GreetingSchema, 'A greeting')
  greet({ params }: RouteInput<{ params: typeof NameParamSchema }>) {
    return this.greetings.greet(params.name);
  }

  @Post('/')
  @OperationId('greetings.create')
  @UseBodySchema(CreateGreetingSchema)
  @ApiResponse(201, GreetingSchema, 'A stored greeting')
  create({ body, context }: RouteInput<{ body: typeof CreateGreetingSchema }>) {
    return context.json(this.greetings.greet(body.name), { status: 201 });
  }
}
`,
  'src/greeting.module.ts': `import { Module } from '@kivinjs/decorators';
import { GreetingController } from './greeting.controller';
import { GreetingService } from './greeting.service';

@Module({ providers: [GreetingService], controllers: [GreetingController] })
export class GreetingModule {}
`,
  'src/app.ts': `import { defineApplication } from '@kivinjs/core';
import { createLoggerModule, RequestLoggerMiddleware } from '@kivinjs/logger';
import { createValibotAdapter } from '@kivinjs/valibot';
import { GreetingModule } from './greeting.module';

export default defineApplication({
  modules: [createLoggerModule({ serviceName: 'pack-smoke' }), GreetingModule],
  schemaAdapter: createValibotAdapter(),
  globals: { guards: [], middleware: [RequestLoggerMiddleware], filters: [] },
});
`,
  'src/main.ts': `import { createApp } from '@kivinjs/core';
import manifest from '../.kivin/generated/manifest';
import appDefinition from './app';

createApp(appDefinition, manifest).listen({ port: Number(process.env.PORT ?? 3000) });
`,
  'src/client-check.ts': `import { createClient } from '../.kivin/generated/client';

const client = createClient({ baseUrl: 'http://localhost' });

export async function typedClientUsage() {
  const greeting = await client.greetings.greet({ params: { name: 'Ada' } });
  const message: string = greeting.message;
  await client.greetings.create({ body: { name: 'Grace' } });
  return message;
}
`,
};

try {
  step(`install ${release.packages.length} tarballs into ${appDir}`);
  const tarballs = Object.fromEntries(release.packages.map((entry) => [entry.name, `file:${join(releaseDir, entry.tarball)}`]));
  // overrides: the tarballs' own @kivinjs/* ranges (for example ^0.0.1) would otherwise resolve against the registry.
  const packageJson = {
    name: 'kivin-pack-smoke-app',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(Object.entries(tarballs).filter(([name]) => name !== '@kivinjs/cli')),
    devDependencies: { '@kivinjs/cli': tarballs['@kivinjs/cli'] },
    overrides: tarballs,
  };
  mkdirSync(join(appDir, 'src'), { recursive: true });
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(appDir, path), content);
  await mustRun('bun install', ['bun', 'install'], appDir);
  const typescript = rootManifest.devDependencies.typescript ?? 'latest';
  const valibot = rootManifest.devDependencies.valibot ?? 'latest';
  await mustRun('bun add valibot', ['bun', 'add', `valibot@${valibot}`], appDir);
  await mustRun('bun add typescript @types/bun', ['bun', 'add', '-d', `typescript@${typescript}`, '@types/bun'], appDir);

  step('exactly one copy of @kivinjs/core is installed');
  const cores = [...new Bun.Glob('**/@kivinjs/core/package.json').scanSync({ cwd: join(appDir, 'node_modules'), dot: true, followSymlinks: false })];
  assert(cores.length === 1, `expected exactly one @kivinjs/core, found ${cores.length}: ${cores.join(', ')}`);

  step('every installed package imports from the installed artifact');
  const importAll = `import { readdirSync, readFileSync } from 'node:fs';
const failures = [];
let count = 0;
for (const dir of readdirSync('node_modules/@kivinjs')) {
  const manifest = JSON.parse(readFileSync(\`node_modules/@kivinjs/\${dir}/package.json\`, 'utf8'));
  for (const key of Object.keys(manifest.exports ?? {})) {
    if (key === './package.json' || key.includes('*')) continue;
    const specifier = \`@kivinjs/\${dir}\${key.slice(1)}\`;
    try {
      await import(specifier);
      count += 1;
    } catch (error) {
      failures.push(\`\${specifier}: \${error instanceof Error ? error.message : String(error)}\`);
    }
  }
}
if (failures.length > 0) {
  console.error(failures.join('\\n'));
  process.exit(1);
}
console.log(\`imported \${count} entry points\`);
`;
  writeFileSync(join(appDir, 'import-all.mjs'), importAll);
  const imported = await mustRun('import every package', ['bun', 'import-all.mjs']);
  assert(imported.includes(`imported ${release.packages.length} entry points`), `expected one entry point per package (${release.packages.length}), got: ${imported.trim()}`);

  const kivin = join(appDir, 'node_modules/.bin/kivin');
  step('kivin --version prints the package version');
  const version = (await mustRun('kivin --version', [kivin, '--version'])).trim();
  assert(version === expectedVersion, `kivin --version printed "${version}", expected "${expectedVersion}"`);

  step('kivin generate');
  await mustRun('kivin generate', [kivin, 'generate', '--entry', 'src/app.ts', '--outDir', '.kivin/generated']);
  for (const generated of ['manifest.ts', 'client.ts', 'openapi.json']) {
    assert(existsSync(join(appDir, '.kivin/generated', generated)), `kivin generate did not write ${generated}`);
  }

  step('kivin inspect routes');
  const routes = await mustRun('kivin inspect routes', [kivin, 'inspect', 'routes', '--entry', 'src/app.ts']);
  assert(routes.includes('/greetings/:name'), `inspect routes did not list /greetings/:name:\n${routes}`);

  step('tsc --noEmit (strict, lib ESNext, skipLibCheck false, types bun)');
  await mustRun('tsc', [join(appDir, 'node_modules/.bin/tsc'), '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false']);

  step('bun build --compile, then run from a directory without node_modules');
  const binary = join(work, 'compiled-app');
  await mustRun('bun build --compile', ['bun', 'build', 'src/main.ts', '--compile', '--outfile', binary]);
  mkdirSync(runDir);
  cpSync(binary, join(runDir, 'app'));
  assert(!existsSync(join(runDir, 'node_modules')), 'run directory unexpectedly has node_modules');
  const compiledPort = freePort();
  const compiled = spawnServer([join(runDir, 'app')], runDir, compiledPort);
  await waitFor(`http://127.0.0.1:${compiledPort}/greetings/Ada`, compiled, 'compiled binary');
  await exercise(`http://127.0.0.1:${compiledPort}`, 'compiled binary');
  compiled.kill('SIGTERM');
  await compiled.exited;
  children.delete(compiled);

  step('kivin dev answers HTTP and stops cleanly');
  const devPort = freePort();
  const dev = spawnServer([kivin, 'dev', '--entry', 'src/app.ts', '--outDir', '.kivin/generated', '--main', 'src/main.ts', '--watch', 'src'], appDir, devPort);
  await waitFor(`http://127.0.0.1:${devPort}/greetings/Ada`, dev, 'kivin dev');
  await exercise(`http://127.0.0.1:${devPort}`, 'kivin dev');
  dev.kill('SIGTERM');
  const stopped = await Promise.race([dev.exited, Bun.sleep(10_000).then(() => 'timeout' as const)]);
  assert(stopped !== 'timeout', 'kivin dev did not exit within 10s of SIGTERM');
  assert(stopped === 0, `kivin dev exited with ${stopped} after SIGTERM`);
  children.delete(dev);
  let stillListening = true;
  try {
    await fetch(`http://127.0.0.1:${devPort}/greetings/Ada`);
  } catch {
    stillListening = false;
  }
  assert(!stillListening, 'kivin dev left its server child running after SIGTERM');

  step('kivin --help lists init');
  const help = await mustRun('kivin --help', [kivin, '--help']);
  assert(/^\s+init\b/m.test(help), `kivin --help does not list init:\n${help}`);

  step('kivin init scaffolds a project and installs nothing');
  const scaffoldName = 'scaffold-app';
  const scaffoldDir = join(work, scaffoldName);
  const initOutput = await mustRun('kivin init', [kivin, 'init', scaffoldName], work);
  for (const next of [`cd ${scaffoldName}`, 'bun install', 'bun run dev']) {
    assert(initOutput.includes(next), `kivin init did not print the next step "${next}":\n${initOutput}`);
  }
  for (const generated of ['package.json', 'tsconfig.json', '.gitignore', 'README.md', 'src/app.ts', 'src/main.ts', 'src/greeting.test.ts']) {
    assert(existsSync(join(scaffoldDir, generated)), `kivin init did not write ${generated}`);
  }
  assert(!existsSync(join(scaffoldDir, 'node_modules')) && !existsSync(join(scaffoldDir, 'bun.lock')), 'kivin init installed dependencies');
  assert(!existsSync(join(scaffoldDir, '.kivin')), 'kivin init generated .kivin output');

  const scaffoldManifest = JSON.parse(readFileSync(join(scaffoldDir, 'package.json'), 'utf8')) as {
    name: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert(scaffoldManifest.name === scaffoldName, `scaffold package name is ${scaffoldManifest.name}`);
  assert(['dev', 'generate', 'build', 'typecheck', 'test'].every((script) => scaffoldManifest.scripts[script]), 'scaffold is missing one of dev, generate, build, typecheck, test');
  for (const name of ['@kivinjs/core', '@kivinjs/decorators', '@kivinjs/valibot']) {
    assert(scaffoldManifest.dependencies[name] === `^${expectedVersion}`, `scaffold ${name} is ${scaffoldManifest.dependencies[name]}, expected ^${expectedVersion}`);
  }
  assert(scaffoldManifest.devDependencies['@kivinjs/cli'] === `^${expectedVersion}`, 'scaffold @kivinjs/cli does not track the CLI version');
  const scaffoldTsconfig = JSON.parse(readFileSync(join(scaffoldDir, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
  assert(!('experimentalDecorators' in scaffoldTsconfig.compilerOptions), 'scaffold tsconfig sets experimentalDecorators');
  assert(JSON.stringify(scaffoldTsconfig.compilerOptions.types) === '["bun"]' && JSON.stringify(scaffoldTsconfig.compilerOptions.lib) === '["ESNext"]' && scaffoldTsconfig.compilerOptions.strict === true, 'scaffold tsconfig lacks types bun, lib ESNext or strict');
  const scaffoldIgnore = readFileSync(join(scaffoldDir, '.gitignore'), 'utf8');
  for (const ignored of ['node_modules', '.kivin']) assert(scaffoldIgnore.includes(ignored), `scaffold .gitignore does not cover ${ignored}`);

  step('kivin init refuses a non-empty directory and overwrites nothing');
  const packageBefore = readFileSync(join(scaffoldDir, 'package.json'), 'utf8');
  const refused = await exec([kivin, 'init', scaffoldName], { cwd: work });
  assert(refused.exitCode !== 0, 'kivin init succeeded on a non-empty directory');
  assert(refused.stderr.includes('not empty'), `kivin init gave no clear refusal:\n${refused.stderr}`);
  assert(readFileSync(join(scaffoldDir, 'package.json'), 'utf8') === packageBefore, 'kivin init modified an existing file');

  step('scaffold: bun install with the tarball overrides, then bun test before anything is generated');
  writeFileSync(join(scaffoldDir, 'package.json'), `${JSON.stringify({ ...scaffoldManifest, overrides: tarballs }, null, 2)}\n`);
  await mustRun('scaffold bun install', ['bun', 'install'], scaffoldDir);
  assert(!existsSync(join(scaffoldDir, '.kivin')), 'bun install created .kivin');
  // bun test reports on stderr.
  const scaffoldTestRun = await exec(['bun', 'test'], { cwd: scaffoldDir });
  assert(scaffoldTestRun.exitCode === 0, `scaffold bun test exited with ${scaffoldTestRun.exitCode}\n${scaffoldTestRun.stdout}\n${scaffoldTestRun.stderr}`);
  const scaffoldTests = scaffoldTestRun.stdout + scaffoldTestRun.stderr;
  assert(!existsSync(join(scaffoldDir, '.kivin')), 'bun test created .kivin');
  assert(/\b3 pass\b/.test(scaffoldTests), 'scaffold bun test did not report 3 passing tests');

  step('scaffold: bun run dev answers HTTP straight after bun install and bun test, before generate');
  assert(!existsSync(join(scaffoldDir, '.kivin')), 'scaffold .kivin exists before the dev step');
  const scaffoldDevPort = freePort();
  const scaffoldDev = spawnServer(['bun', 'run', 'dev'], scaffoldDir, scaffoldDevPort);
  await waitFor(`http://127.0.0.1:${scaffoldDevPort}/greetings/Ada`, scaffoldDev, 'scaffold bun run dev');
  await exercise(`http://127.0.0.1:${scaffoldDevPort}`, 'scaffold bun run dev');
  killGroup(scaffoldDev, 'SIGTERM');
  const scaffoldDevStopped = await Promise.race([scaffoldDev.exited, Bun.sleep(10_000).then(() => 'timeout' as const)]);
  assert(scaffoldDevStopped !== 'timeout', 'scaffold bun run dev did not exit within 10s of SIGTERM');
  children.delete(scaffoldDev);

  step('scaffold: bun run generate, strict tsc --noEmit');
  await mustRun('scaffold bun run generate', ['bun', 'run', 'generate'], scaffoldDir);
  assert(existsSync(join(scaffoldDir, '.kivin/generated/manifest.ts')), 'scaffold generate did not write manifest.ts');
  assert(scaffoldManifest.scripts.typecheck === 'tsc', `scaffold typecheck script is ${scaffoldManifest.scripts.typecheck}, expected tsc`);
  await mustRun('scaffold bun run typecheck', ['bun', 'run', 'typecheck'], scaffoldDir);

  step('scaffold: bun run build, then run the built binary');
  await mustRun('scaffold bun run build', ['bun', 'run', 'build'], scaffoldDir);
  const scaffoldBinary = join(scaffoldDir, 'bin', scaffoldName);
  assert(existsSync(scaffoldBinary), `scaffold build did not write bin/${scaffoldName}`);
  const scaffoldPort = freePort();
  const scaffoldServer = spawnServer([scaffoldBinary], scaffoldDir, scaffoldPort);
  await waitFor(`http://127.0.0.1:${scaffoldPort}/greetings/Ada`, scaffoldServer, 'scaffold binary');
  await exercise(`http://127.0.0.1:${scaffoldPort}`, 'scaffold binary');
  scaffoldServer.kill('SIGTERM');
  await scaffoldServer.exited;
  children.delete(scaffoldServer);

  finished = true;
  cleanup();
  console.log('\npack-smoke passed');
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
