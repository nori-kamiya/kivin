export { buildManifest } from './runtime/manifest';
export type { AppManifest, BunRouteDefinition, BunRouteHandler, ListenOptions, ManifestRoute } from './runtime/types';

import type { Server } from 'bun';
import { Container } from './container';
import { createCorsHandler, createCorsMiddleware, type CorsHandler } from './cors';
import type { AppDefinition } from './metadata';
import { flattenModules } from './module';
import { readPathname } from './request-url';
import { Router } from './router';
import type { Constructor, HttpMethod, Token } from './types';
import { compileRouteExecutor } from './runtime/executor';
import { toHeadResponse } from './runtime/results';
import { createBunServeRoutes, createExactRouteLookup, createStaticAllowedMethodsLookup, getAllowedMethods, getAllowedMethodsForList, normalizeRoutePath } from './runtime/routing';
import { type AppManifest, type CompiledRoute, EMPTY_PARAMS, type ListenOptions } from './runtime/types';
import { trackServer } from './client-address';
import { compileWebSocketRoutes } from './websocket';

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

  // Guard / middleware / filter classes named by the app or a route are registered automatically
  // when no module provides them, so `globals: { middleware: [createCompressMiddleware()] }` or
  // `@UseGuards(SomeGuard)` works without repeating the class in `providers`. Their `@Injectable`
  // dependencies still come from the modules.
  const enhancerTokens = [
    ...(definition.globals?.guards ?? []),
    ...(definition.globals?.middleware ?? []),
    ...(definition.globals?.filters ?? []),
    ...manifest.routes.flatMap((route) => [...route.guards, ...route.middleware, ...route.filters]),
  ];
  for (const token of enhancerTokens) {
    if (typeof token === 'function' && !container.hasLocalProvider(token)) {
      container.register(token as Constructor);
    }
  }

  // CORS runs as the outermost global middleware so every route response gets the headers;
  // preflight and 404/405 responses are handled in `fetch` below.
  const cors = definition.cors ? createCorsHandler(definition.cors) : undefined;
  const globalMiddlewareTokens = definition.globals?.middleware ?? [];
  let effectiveGlobalMiddleware = globalMiddlewareTokens;
  if (cors) {
    const CorsMiddleware = createCorsMiddleware(cors);
    container.register(CorsMiddleware);
    effectiveGlobalMiddleware = [CorsMiddleware, ...globalMiddlewareTokens];
  }

  // Two routes for the same method and path shape would be resolved differently by `fetch` (first
  // match) and Bun's native routes (last registration), so they are rejected up front.
  const routeShapes = new Map<string, (typeof manifest.routes)[number]>();
  for (const route of manifest.routes) {
    const shape = `${route.method} ${normalizeRoutePath(route.fullPath).replace(/:[^/]+/g, ':')}`;
    const existing = routeShapes.get(shape);
    if (existing) {
      const describeRoute = (candidate: typeof route) => `${candidate.method} ${candidate.fullPath} (${candidate.controller.name}.${candidate.methodName})`;
      throw new Error(`Duplicate route: ${describeRoute(route)} conflicts with ${describeRoute(existing)}`);
    }
    routeShapes.set(shape, route);
  }

  for (const route of manifest.routes) {
    const compiledRoute = compileRouteExecutor({
      container,
      definition,
      globalFilterTokens: definition.globals?.filters ?? [],
      globalGuardTokens: definition.globals?.guards ?? [],
      globalMiddlewareTokens: effectiveGlobalMiddleware,
      route,
    });

    const servedRoute = cors ? withCorsOnEveryResponse(compiledRoute, cors) : compiledRoute;
    compiledRoutes.push(servedRoute);
    router.register(route.method, route.fullPath, servedRoute);
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
      if (cors) {
        const preflight = cors.preflight(request, allowedMethods);
        if (preflight) {
          return preflight;
        }
      }
      const response = request.method === 'OPTIONS'
        ? new Response(null, { status: 204, headers: { allow: allowedMethods.join(', ') } })
        : Response.json({ message: 'Method Not Allowed' }, { status: 405, headers: { allow: allowedMethods.join(', ') } });
      cors?.apply(request, response.headers);

      return isHeadRequest ? toHeadResponse(response) : response;
    }

    const matched = isHeadRequest
      ? (router.match(request.method, path) ?? router.match('GET', path))
      : router.match(request.method, path);

    if (!matched) {
      const allowedMethods = getAllowedMethods(router, path);
      if (allowedMethods.length > 0) {
        if (cors) {
          const preflight = cors.preflight(request, allowedMethods);
          if (preflight) {
            return preflight;
          }
        }
        const response = request.method === 'OPTIONS'
          ? new Response(null, { status: 204, headers: { allow: allowedMethods.join(', ') } })
          : Response.json({ message: 'Method Not Allowed' }, { status: 405, headers: { allow: allowedMethods.join(', ') } });
        cors?.apply(request, response.headers);
        return isHeadRequest ? toHeadResponse(response) : response;
      }

      const notFoundResponse = Response.json({ message: 'Not Found' }, { status: 404 });
      cors?.apply(request, notFoundResponse.headers);
      return notFoundResponse;
    }

    const response = await matched.data.execute(request, matched.params);
    return isHeadRequest ? toHeadResponse(response) : response;
  };

  let activeServer: Server<unknown> | undefined;
  let closing: Promise<void> | undefined;
  let initializing: Promise<void> | undefined;
  let initialized = false;

  /** Distinct singleton instances (a `useValue` object may back several tokens), in creation order. */
  const lifecycleInstances = () => {
    container.resolveAllSingletons();
    return [...new Set(container.singletonInstances())];
  };
  const hookOwners = (hook: 'onModuleInit' | 'onApplicationBootstrap') =>
    lifecycleInstances().filter((instance) => typeof (instance as Record<string, unknown> | null)?.[hook] === 'function');

  const app = {
    fetch,
    /**
     * Starts `Bun.serve` with every manifest route compiled into Bun's native `routes` table.
     * `options.routes` adds extra native routes (for example a static `/openapi.json`); a path that
     * collides with a manifest route is rejected so app routes can never be shadowed silently.
     */
    listen(options: number | ListenOptions) {
      if (!initialized) {
        const owners = container.findHookOwners(['onModuleInit', 'onApplicationBootstrap']);
        if (owners.length > 0) {
          const names = owners.join(', ');
          throw new Error(`${names} define onModuleInit / onApplicationBootstrap; call \`await app.init()\` before app.listen() so they run before the first request`);
        }
      }
      const {
        routes: extraRoutes = {},
        websockets,
        shutdownSignals,
        ...serveOptions
      } = typeof options === 'number' ? ({ port: options } as ListenOptions) : options;
      const routes: Record<string, unknown> = createBunServeRoutes(compiledRoutes);
      const addRoute = (path: string, definition: unknown, source: string) => {
        if (path in routes) {
          throw new Error(`listen({ ${source} }) path ${path} collides with an application route`);
        }
        routes[path] = definition;
      };
      for (const [path, definition] of Object.entries(extraRoutes)) {
        addRoute(path, definition, 'routes');
      }
      const compiledSockets = websockets ? compileWebSocketRoutes(websockets) : undefined;
      for (const [path, handler] of Object.entries(compiledSockets?.handlers ?? {})) {
        addRoute(path, handler, 'websockets');
      }

      const server = Bun.serve({
        // Safety net for errors outside kivin's own handling (e.g. a user-supplied native route):
        // a generic 500 instead of Bun's default error page, which shows the stack in development.
        error(error: Error) {
          console.error('[kivin] Unhandled server error', error);
          return Response.json({ message: 'Internal Server Error' }, { status: 500 });
        },
        ...serveOptions,
        routes,
        fetch,
        ...(compiledSockets ? { websocket: compiledSockets.websocket } : {}),
      } as Parameters<typeof Bun.serve>[0]) as Server<unknown>;
      activeServer = server;
      trackServer(server, true);

      if (shutdownSignals) {
        const signals = shutdownSignals === true ? (['SIGINT', 'SIGTERM'] as const) : shutdownSignals;
        const onSignal = (signal: NodeJS.Signals) => {
          for (const name of signals) {
            process.off(name, onSignal);
          }
          void app.close({ signal }).finally(() => process.exit(0));
        };
        for (const signal of signals) {
          process.once(signal, onSignal);
        }
      }

      return server;
    },
    /**
     * Graceful shutdown: stops accepting connections, waits up to `timeoutMs` (default 10s) for
     * in-flight requests, then calls `onApplicationShutdown(signal)` on every singleton provider
     * that defines it, newest first. Safe to call more than once.
     */
    close(options: { signal?: string; timeoutMs?: number } = {}) {
      closing ??= (async () => {
        const server = activeServer;
        activeServer = undefined;
        if (server) {
          const drained = await Promise.race([
            server.stop(false).then(() => true),
            Bun.sleep(options.timeoutMs ?? 10_000).then(() => false),
          ]);
          if (!drained) {
            await server.stop(true);
          }
          trackServer(server, false);
        }

        const errors: unknown[] = [];
        for (const instance of [...container.singletonInstances()].reverse()) {
          const hook = (instance as { onApplicationShutdown?: (signal?: string) => unknown } | null)?.onApplicationShutdown;
          if (typeof hook === 'function') {
            try {
              await hook.call(instance, options.signal);
            } catch (error) {
              errors.push(error);
            }
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'onApplicationShutdown hooks failed');
        }
      })();
      return closing;
    },
    /**
     * Runs startup hooks: creates every singleton provider, then awaits `onModuleInit()` on each
     * (dependencies before their dependents), then `onApplicationBootstrap()` on each. Call it before
     * `listen()` (which refuses to start while hooks are pending) or before using `fetch` directly.
     * Safe to call more than once; a failing hook rejects and can be retried.
     */
    init() {
      initializing ??= (async () => {
        for (const hook of ['onModuleInit', 'onApplicationBootstrap'] as const) {
          for (const instance of hookOwners(hook)) {
            await (instance as Record<string, () => unknown>)[hook]!();
          }
        }
        initialized = true;
      })().catch((error: unknown) => {
        initializing = undefined;
        throw error;
      });
      return initializing;
    },
    /** Resolves a provider from the app's root container (handy in scripts and tests). */
    get<T>(token: Token<T>): T {
      return container.resolve(token);
    },
  };

  return app;
}

/**
 * Route-level CORS: parameter / query / body validation errors, guard rejections and errors handled by
 * filters are answered before or outside the CORS middleware, so the headers are ensured here too (a
 * browser cannot read an error response that lacks them).
 */
function withCorsOnEveryResponse<TSchema>(compiled: CompiledRoute<TSchema>, cors: CorsHandler): CompiledRoute<TSchema> {
  const execute = compiled.execute;
  return {
    ...compiled,
    execute: (request, params) => execute(request, params).then((response) => cors.ensure(request, response)),
  };
}
