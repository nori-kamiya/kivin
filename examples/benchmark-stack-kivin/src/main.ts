// Stack benchmark server. Routes come from the generated manifest (`bun run bench:stack:generate`,
// with AOT executors); BENCH_VARIANT picks which of them to serve, like the Hono / Elysia apps.
import { createApp, defineApplication, type AppManifest } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import manifest from '../.kivin/generated/manifest';
import { BenchmarkModule, LoggerModule, RequestIdMiddleware } from './app';

const variant = process.env.BENCH_VARIANT ?? 'mixed';
type Route = AppManifest['routes'][number];

const CREATE_VARIANT_PATHS: Record<string, string> = {
  create: '/users',
  'create-no-request-id': '/users',
  'create-no-guard': '/variants/create-no-guard',
  'create-no-validation': '/variants/create-no-validation',
  'create-bare': '/variants/create-bare',
};

function shouldUseRequestIdMiddleware(candidate: string) {
  return candidate !== 'delete-bare'
    && candidate !== 'create-no-request-id'
    && candidate !== 'create-bare';
}

const find = (method: string, path: string): Route => {
  const route = manifest.routes.find((candidate) => candidate.method === method && candidate.fullPath === path);
  if (!route) {
    throw new Error(`benchmark route ${method} ${path} is missing from the generated manifest`);
  }
  return route;
};

function selectVariantRoutes(selectedVariant: string): Route[] {
  const health = find('GET', '/health');
  const createPath = CREATE_VARIANT_PATHS[selectedVariant];
  if (createPath) {
    return [health, { ...find('POST', createPath), fullPath: '/users' }];
  }

  switch (selectedVariant) {
    case 'health':
      return [health];
    case 'docs':
      return [health, find('GET', '/docs')];
    case 'users':
      return [health, find('GET', '/users')];
    case 'patch':
      return [health, find('PATCH', '/users/:id')];
    case 'delete':
      return [health, find('DELETE', '/users/:id')];
    case 'delete-inline':
      return [health, find('DELETE', '/users-inline/:id')];
    case 'delete-no-guard':
      return [health, find('DELETE', '/users-no-guard/:id')];
    case 'delete-bare':
      return [health, find('DELETE', '/users-bare/:id')];
    default:
      return manifest.routes.filter((route) => !route.fullPath.startsWith('/variants/'));
  }
}

const appDefinition = defineApplication({
  modules: [LoggerModule, BenchmarkModule],
  schemaAdapter: createValibotAdapter(),
  globals: {
    guards: [],
    middleware: shouldUseRequestIdMiddleware(variant) ? [RequestIdMiddleware] : [],
    filters: [],
  },
});

const port = Number(process.env.PORT ?? 3401);
createApp(appDefinition, { routes: selectVariantRoutes(variant) }).listen(port);
