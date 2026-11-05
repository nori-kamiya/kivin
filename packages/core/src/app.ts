export { buildManifest } from './runtime/manifest';
export type { AppManifest, BunRouteDefinition, BunRouteHandler, ListenOptions, ManifestRoute } from './runtime/types';

import { Container } from './container';
import type { AppDefinition } from './metadata';
import { flattenModules } from './module';
import { readPathname } from './request-url';
import { Router } from './router';
import type { HttpMethod } from './types';
import { compileRouteExecutor } from './runtime/executor';
import { toHeadResponse } from './runtime/results';
import { createBunServeRoutes, createExactRouteLookup, createStaticAllowedMethodsLookup, getAllowedMethods, getAllowedMethodsForList, normalizeRoutePath } from './runtime/routing';
import { type AppManifest, type CompiledRoute, EMPTY_PARAMS, type ListenOptions } from './runtime/types';

export function createApp<TSchema>(definition: AppDefinition<TSchema>, manifest: AppManifest<TSchema>) {
  const container = new Container();
  const router = new Router<CompiledRoute<TSchema>>();
  const compiledRoutes: CompiledRoute<TSchema>[] = [];
  const modules = flattenModules(definition.modules);

  for (const moduleDefinition of modules) {
    for (const provider of moduleDefinition.providers) {
      container.register(provider);
    }
    for (const controller of moduleDefinition.controllers) {
      if (!container.hasLocalProvider(controller)) {
        container.register(controller);
      }
    }
  }

  for (const route of manifest.routes) {
    const compiledRoute = compileRouteExecutor({
      container,
      definition,
      globalFilterTokens: definition.globals?.filters ?? [],
      globalGuardTokens: definition.globals?.guards ?? [],
      globalMiddlewareTokens: definition.globals?.middleware ?? [],
      route,
    });

    compiledRoutes.push(compiledRoute);
    router.register(route.method, route.fullPath, compiledRoute);
  }

  const exactRoutes = createExactRouteLookup(compiledRoutes);
  const staticAllowedMethods = createStaticAllowedMethodsLookup(compiledRoutes);

  const fetch = async (request: Request): Promise<Response> => {
    const isHeadRequest = request.method === 'HEAD';
    const path = normalizeRoutePath(readPathname(request.url));
    const exactMethodMatch = exactRoutes.get(request.method as HttpMethod)?.get(path);
    const exactGetMatch = isHeadRequest ? exactRoutes.get('GET')?.get(path) : undefined;
    const exactMatch = exactMethodMatch ?? exactGetMatch;

    if (exactMatch) {
      const response = exactMatch.nativeStaticResponse
        ? exactMatch.nativeStaticResponse.clone()
        : await exactMatch.execute(request, EMPTY_PARAMS);

      return isHeadRequest ? toHeadResponse(response) : response;
    }

    const staticAllowed = staticAllowedMethods.get(path);
    if (staticAllowed && staticAllowed.length > 0) {
      const allowedMethods = getAllowedMethodsForList(staticAllowed);
      const response = request.method === 'OPTIONS'
        ? new Response(null, { status: 204, headers: { allow: allowedMethods.join(', ') } })
        : new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
            status: 405,
            headers: {
              allow: allowedMethods.join(', '),
              'content-type': 'application/json; charset=utf-8',
            },
          });

      return isHeadRequest ? toHeadResponse(response) : response;
    }

    const matched = isHeadRequest
      ? (router.match(request.method, path) ?? router.match('GET', path))
      : router.match(request.method, path);

    if (!matched) {
      const allowedMethods = getAllowedMethods(router, path);
      if (allowedMethods.length > 0) {
        const response = request.method === 'OPTIONS'
          ? new Response(null, { status: 204, headers: { allow: allowedMethods.join(', ') } })
          : new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
              status: 405,
              headers: {
                allow: allowedMethods.join(', '),
                'content-type': 'application/json; charset=utf-8',
              },
            });
        return isHeadRequest ? toHeadResponse(response) : response;
      }

      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const response = await matched.data.execute(request, matched.params);
    return isHeadRequest ? toHeadResponse(response) : response;
  };

  return {
    fetch,
    /**
     * Starts `Bun.serve` with every manifest route compiled into Bun's native `routes` table.
     * `options.routes` adds extra native routes (for example a static `/openapi.json`); a path that
     * collides with a manifest route is rejected so app routes can never be shadowed silently.
     */
    listen(options: number | ListenOptions) {
      const { routes: extraRoutes = {}, ...serveOptions } = typeof options === 'number' ? { port: options } : options;
      const routes = createBunServeRoutes(compiledRoutes);
      for (const [path, definition] of Object.entries(extraRoutes)) {
        if (path in routes) {
          throw new Error(`listen({ routes }) path ${path} collides with an application route`);
        }
        routes[path] = definition;
      }

      return Bun.serve({
        ...serveOptions,
        routes,
        fetch,
      });
    },
  };
}
