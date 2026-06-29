#!/usr/bin/env bun
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

function readFormatFlag() {
  return readFlag('--format') ?? 'text';
}

async function main() {
  const command = process.argv[2];

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
    });

    console.log(`manifest: ${result.manifestPath}`);
    console.log(`openapi: ${result.openApiPath}`);
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

  throw new Error('supported commands: generate, openapi, inspect');
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
