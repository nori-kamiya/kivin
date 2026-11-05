// Path lookup, allowed-method tables and the Bun native `routes` table.
import type { Router } from '../router';
import type { HttpMethod } from '../types';
import { toHeadResponse } from './results';
import { type BunRouteDefinition, type BunRouteHandler, type CompiledRoute, HTTP_METHOD_ORDER } from './types';

export function normalizeRoutePath(path: string) {
  // Hot path for every in-process fetch: already-normal paths skip the string rebuild and regex.
  if (path.charCodeAt(0) === 47 /* / */ && (path.length === 1 || path.charCodeAt(path.length - 1) !== 47)) {
    return path;
  }

  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  return path.replace(/\/$/, '') || '/';
}

export function createExactRouteLookup<TSchema>(compiledRoutes: CompiledRoute<TSchema>[]) {
  const lookup = new Map<HttpMethod, Map<string, CompiledRoute<TSchema>>>();

  for (const compiledRoute of compiledRoutes) {
    if (compiledRoute.route.fullPath.includes(':')) {
      continue;
    }

    let methodRoutes = lookup.get(compiledRoute.route.method);
    if (!methodRoutes) {
      methodRoutes = new Map<string, CompiledRoute<TSchema>>();
      lookup.set(compiledRoute.route.method, methodRoutes);
    }

    methodRoutes.set(normalizeRoutePath(compiledRoute.route.fullPath), compiledRoute);
  }

  return lookup;
}

export function createStaticAllowedMethodsLookup<TSchema>(compiledRoutes: CompiledRoute<TSchema>[]) {
  const lookup = new Map<string, HttpMethod[]>();

  for (const compiledRoute of compiledRoutes) {
    if (compiledRoute.route.fullPath.includes(':')) {
      continue;
    }

    const path = normalizeRoutePath(compiledRoute.route.fullPath);
    const methods = lookup.get(path);
    if (methods) {
      methods.push(compiledRoute.route.method);
      continue;
    }

    lookup.set(path, [compiledRoute.route.method]);
  }

  return lookup;
}

export function createBunServeRoutes<TSchema>(compiledRoutes: CompiledRoute<TSchema>[]): Record<string, BunRouteDefinition> {
  const routes: Record<string, BunRouteDefinition> = {};
  const routeMethods = new Map<string, Set<HttpMethod>>();

  for (const compiledRoute of compiledRoutes) {
    const { fullPath, method } = compiledRoute.route;
    let methods = routeMethods.get(fullPath);
    if (!methods) {
      methods = new Set<HttpMethod>();
      routeMethods.set(fullPath, methods);
    }
    methods.add(method);

    const handler: BunRouteHandler = (request) => compiledRoute.execute(request, request.params ?? {});
    const current = routes[fullPath];
    const routeValue = compiledRoute.nativeStaticResponse ? compiledRoute.nativeStaticResponse.clone() : handler;

    if (!current) {
      routes[fullPath] = { [method]: routeValue };
      continue;
    }

    if (current instanceof Response || typeof current === 'function') {
      routes[fullPath] = { [method]: routeValue };
      continue;
    }

    current[method] = routeValue;
  }

  for (const compiledRoute of compiledRoutes) {
    if (compiledRoute.route.method !== 'GET') {
      continue;
    }

    const methods = routeMethods.get(compiledRoute.route.fullPath);
    if (!methods || methods.has('HEAD')) {
      continue;
    }

    const current = routes[compiledRoute.route.fullPath];
    if (!current || current instanceof Response || typeof current === 'function') {
      continue;
    }

    current.HEAD = compiledRoute.nativeStaticResponse
      ? toHeadResponse(compiledRoute.nativeStaticResponse.clone())
      : async (request) => toHeadResponse(await compiledRoute.execute(request, request.params ?? {}));
  }

  return routes;
}

export function getAllowedMethods<TSchema>(router: Router<CompiledRoute<TSchema>>, path: string) {
  return getAllowedMethodsForList(router.allowedMethods(path));
}

export function getAllowedMethodsForList(methodList: HttpMethod[]) {
  const methods = new Set<HttpMethod | 'HEAD' | 'OPTIONS'>(methodList);
  if (methods.size === 0) {
    return [];
  }

  if (methods.has('GET')) {
    methods.add('HEAD');
  }

  methods.add('OPTIONS');

  return HTTP_METHOD_ORDER.filter((method) => methods.has(method));
}
