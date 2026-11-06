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

function cleanup(): void {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
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
  });
  children.add(child);
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 180_000);
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
  const child = Bun.spawn(command, { cwd, env: { ...process.env, PORT: String(port) }, stdout: 'ignore', stderr: 'ignore' });
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
  'src/greeting.service.ts': `import { Injectable } from '@kivin/decorators';
import { LOGGER, type Logger } from '@kivin/logger';

@Injectable({ deps: [LOGGER] })
export class GreetingService {
  constructor(private readonly logger: Logger) {}

  greet(name: string) {
    this.logger.info('greeting.created', { name });
    return { message: \`Hello, \${name}\` };
  }
}
`,
  'src/greeting.controller.ts': `import type { RouteInput } from '@kivin/core';
import { ApiResponse, Controller, Get, Injectable, OperationId, Post, UseBodySchema, UseParamSchema } from '@kivin/decorators';
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
  'src/greeting.module.ts': `import { Module } from '@kivin/decorators';
import { GreetingController } from './greeting.controller';
import { GreetingService } from './greeting.service';

@Module({ providers: [GreetingService], controllers: [GreetingController] })
export class GreetingModule {}
`,
  'src/app.ts': `import { defineApplication } from '@kivin/core';
import { createLoggerModule, RequestLoggerMiddleware } from '@kivin/logger';
import { createValibotAdapter } from '@kivin/valibot';
import { GreetingModule } from './greeting.module';

export default defineApplication({
  modules: [createLoggerModule({ serviceName: 'pack-smoke' }), GreetingModule],
  schemaAdapter: createValibotAdapter(),
  globals: { guards: [], middleware: [RequestLoggerMiddleware], filters: [] },
});
`,
  'src/main.ts': `import { createApp } from '@kivin/core';
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
  // overrides: the tarballs' own @kivin/* ranges (for example ^0.0.1) would otherwise resolve against the registry.
  const packageJson = {
    name: 'kivin-pack-smoke-app',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(['@kivin/core', '@kivin/decorators', '@kivin/logger', '@kivin/valibot'].map((name) => [name, tarballs[name]])),
    devDependencies: { '@kivin/cli': tarballs['@kivin/cli'] },
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

  step('exactly one copy of @kivin/core is installed');
  const cores = [...new Bun.Glob('**/@kivin/core/package.json').scanSync({ cwd: join(appDir, 'node_modules'), dot: true, followSymlinks: false })];
  assert(cores.length === 1, `expected exactly one @kivin/core, found ${cores.length}: ${cores.join(', ')}`);

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

  finished = true;
  cleanup();
  console.log('\npack-smoke passed');
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
