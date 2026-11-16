#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { assertSupportedBun } from './bun-version';
import { startDev } from './dev';
import { initProject } from './init';
import { generateArtifacts, generateOpenApi, inspectModules, inspectRoutes, type ModuleInspection, type RouteInspection } from './index';

function readFlag(name: string): string | undefined {
  const indexes = process.argv.reduce<number[]>((matches, arg, index) => {
    if (arg === name) {
      matches.push(index);
    }
    return matches;
  }, []);
  const index = indexes.at(-1);
  if (index === undefined) {
    return undefined;
  }
  return process.argv[index + 1];
}

function readFlags(name: string): string[] {
  return process.argv.flatMap((arg, index) => (arg === name && process.argv[index + 1] ? [process.argv[index + 1]!] : []));
}

function readFormatFlag() {
  return readFlag('--format') ?? 'text';
}

const USAGE = `Usage: kivin <command> [options]

Commands:
  init      <dir>   Scaffold a new project (installs nothing)
  generate  --entry <file> --outDir <dir> [--title <t>] [--version <v>] [--no-aot]
  dev       --entry <file> --outDir <dir> --main <file> [--watch <dir>]...
  openapi   --entry <file> --output <file> [--title <t>] [--version <v>]
  inspect   routes|modules --entry <file> [--format text|json]

Options:
  -h, --help     Show this help
  -v, --version  Show the CLI version`;

// package.json sits one level above both src/ and dist/, so the same URL works compiled and from source.
function readCliVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

// The target is echoed for copy-paste; only the last segment is validated as a package name, so parents may hold anything.
function shellQuote(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

async function main() {
  assertSupportedBun();
  const command = process.argv[2];

  // Only argv[2] counts: `generate --version <v>` is the OpenAPI document version, not a request for ours.
  if (command === '--version' || command === '-v') {
    console.log(readCliVersion());
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help' || process.argv.slice(3).some((arg) => arg === '--help' || arg === '-h')) {
    console.log(USAGE);
    return;
  }

  if (command === 'init') {
    const dir = process.argv[3];
    if (!dir || dir.startsWith('-')) {
      throw new Error('init requires a target directory: kivin init <dir>');
    }
    const result = initProject({ dir, version: readCliVersion() });
    console.log(`Created ${result.name} in ${result.root}\n`);
    console.log(`Next steps:\n  cd ${shellQuote(dir)}\n  bun install\n  bun run dev`);
    return;
  }

  if (command === 'generate') {
    const entry = readFlag('--entry');
    const outDir = readFlag('--outDir');
    if (!entry || !outDir) {
      throw new Error('generate requires --entry and --outDir');
    }

    const title = readFlag('--title');
    const version = readFlag('--version');
    const result = await generateArtifacts({
      entry,
      outDir,
      ...(title ? { title } : {}),
      ...(version ? { version } : {}),
      ...(process.argv.includes('--no-aot') ? { aot: false } : {}),
    });

    for (const warning of result.warnings) {
      console.error(`warning: ${warning}`);
    }
    console.log(`manifest: ${result.manifestPath}`);
    console.log(`contracts: ${result.contractsPath}`);
    console.log(`client: ${result.clientPath}`);
    console.log(`openapi: ${result.openApiPath}`);
    return;
  }

  if (command === 'dev') {
    const entry = readFlag('--entry');
    const outDir = readFlag('--outDir');
    const main = readFlag('--main');
    if (!entry || !outDir || !main) {
      throw new Error('dev requires --entry, --outDir and --main');
    }

    const dev = startDev({ entry, outDir, main, watch: readFlags('--watch') });
    const shutdown = async () => {
      await dev.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await dev.ready;
    // Keep the process alive; the watchers drive everything from here.
    await new Promise(() => undefined);
    return;
  }

  if (command === 'openapi') {
    const entry = readFlag('--entry');
    const output = readFlag('--output');
    if (!entry || !output) {
      throw new Error('openapi requires --entry and --output');
    }

    const title = readFlag('--title');
    const version = readFlag('--version');
    const filePath = await generateOpenApi({
      entry,
      output,
      ...(title ? { title } : {}),
      ...(version ? { version } : {}),
    });

    console.log(`openapi: ${filePath}`);
    return;
  }

  if (command === 'inspect') {
    const target = process.argv[3];
    const entry = readFlag('--entry');
    if (!entry) {
      throw new Error('inspect requires --entry');
    }

    const format = readFormatFlag();
    if (format !== 'text' && format !== 'json') {
      throw new Error('inspect --format must be text or json');
    }

    if (target === 'routes') {
      const routes = await inspectRoutes({ entry });
      console.log(format === 'json' ? JSON.stringify(routes, null, 2) : renderRoutes(routes));
      return;
    }

    if (target === 'modules') {
      const modules = await inspectModules({ entry });
      console.log(format === 'json' ? JSON.stringify(modules, null, 2) : renderModules(modules));
      return;
    }

    throw new Error('inspect supports: routes, modules');
  }

  console.error(`${command ? `Unknown command: ${command}` : 'Missing command'}\n\n${USAGE}`);
  process.exitCode = 1;
}

function renderRoutes(routes: RouteInspection[]) {
  return routes.map((route) => [
    `${route.method.padEnd(7)} ${route.fullPath}`,
    `  handler: ${route.controller}.${route.methodName} [${route.controllerScope}]`,
    `  executor: ${route.executionMode}`,
    `  operationId: ${route.operationId ?? '-'}`,
    `  tags: ${route.tags.join(', ') || '-'}`,
    `  guards: ${renderScopedTokens(route.guards, route.guardScopes)}`,
    `  middleware: ${renderScopedTokens(route.middleware, route.middlewareScopes)}`,
    `  filters: ${renderScopedTokens(route.filters, route.filterScopes)}`,
  ].join('\n')).join('\n\n');
}

function renderScopedTokens(tokens: string[], scopes: string[]) {
  if (tokens.length === 0) {
    return '-';
  }

  return tokens.map((token, index) => `${token} [${scopes[index] ?? 'singleton'}]`).join(', ');
}

function renderModules(modules: ModuleInspection[]) {
  return modules.map((module) => [
    module.name,
    `  providers: ${module.providers.join(', ') || '-'}`,
    `  controllers: ${renderScopedTokens(module.controllers, module.controllerScopes)}`,
    `  imports: ${module.imports.join(', ') || '-'}`,
    `  global guards: ${renderScopedTokens(module.globalGuards ?? [], module.globalGuardScopes ?? [])}`,
    `  global middleware: ${renderScopedTokens(module.globalMiddleware ?? [], module.globalMiddlewareScopes ?? [])}`,
    `  global filters: ${renderScopedTokens(module.globalFilters ?? [], module.globalFilterScopes ?? [])}`,
  ].join('\n')).join('\n\n');
}

// One-shot commands exit once they are done. `generate` / `openapi` / `inspect` import the entry, and a
// module that opens a handle at its top level (a DB pool, a client with a keep-alive timer) would
// otherwise keep the process — and a CI or Docker build — waiting forever after the files are written.
// `dev` never resolves, so it keeps running.
main().then(
  () => process.exit(),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
