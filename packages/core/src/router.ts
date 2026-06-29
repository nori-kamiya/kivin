import type { HttpMethod } from './types';

export interface RouteMatch<TData> {
  data: TData;
  params: Record<string, string>;
}

interface RegisteredRoute<TData> {
  method: HttpMethod;
  originalPath: string;
  matcher: RegExp;
  fastParam: FastParamRoute | undefined;
  paramNames: string[];
  data: TData;
}

interface StaticRoute<TData> {
  method: HttpMethod;
  originalPath: string;
  data: TData;
}

interface FastParamRoute {
  name: string;
  prefix: string;
  suffix: string;
}

function decodePathParam(value: string) {
  return value.includes('%') ? decodeURIComponent(value) : value;
}

function normalizePath(path: string): string {
  if (!path.startsWith('/')) {
    return `/${path}`;
  }
  return path;
}

function normalizeMatchPath(path: string) {
  return normalizePath(path).replace(/\/$/, '') || '/';
}

function compilePath(path: string) {
  const normalized = normalizePath(path).replace(/\/$/, '') || '/';
  const segments = normalized.split('/').filter(Boolean);
  const paramNames: string[] = [];
  const pattern = segments
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const matcher = new RegExp(`^/${pattern}${normalized === '/' ? '' : '/?'}$`);
  return { matcher, paramNames };
}

function compileFastParamRoute(path: string): FastParamRoute | undefined {
  const normalized = normalizeMatchPath(path);
  const matches = [...normalized.matchAll(/\/:[^/]+/g)];
  if (matches.length !== 1) {
    return undefined;
  }

  const match = matches[0];
  if (!match || match.index === undefined) {
    return undefined;
  }

  const token = match[0];
  const name = token.slice(2);
  if (!name) {
    return undefined;
  }

  const prefix = normalized.slice(0, match.index + 1);
  const suffix = normalized.slice(match.index + token.length);
  if (suffix.includes('/:')) {
    return undefined;
  }

  return {
    name,
    prefix,
    suffix,
  };
}

function matchFastParamRoute(route: FastParamRoute, path: string): Record<string, string> | undefined {
  if (!path.startsWith(route.prefix)) {
    return undefined;
  }

  if (route.suffix) {
    if (!path.endsWith(route.suffix)) {
      return undefined;
    }
  }

  const valueStart = route.prefix.length;
  const valueEnd = route.suffix ? path.length - route.suffix.length : path.length;
  const value = path.slice(valueStart, valueEnd);
  if (!value || value.includes('/')) {
    return undefined;
  }

  return {
    [route.name]: decodePathParam(value),
  };
}

export class Router<TData> {
  private readonly dynamicRoutes: RegisteredRoute<TData>[] = [];
  private readonly routes: RegisteredRoute<TData>[] = [];
  private readonly staticRoutes = new Map<HttpMethod, Map<string, StaticRoute<TData>>>();

  register(method: HttpMethod, path: string, data: TData) {
    const originalPath = normalizeMatchPath(path);
    const isStaticRoute = !originalPath.includes(':');

    if (isStaticRoute) {
      let methodRoutes = this.staticRoutes.get(method);
      if (!methodRoutes) {
        methodRoutes = new Map<string, StaticRoute<TData>>();
        this.staticRoutes.set(method, methodRoutes);
      }

      methodRoutes.set(originalPath, {
        method,
        originalPath,
        data,
      });
      return;
    }

    const { matcher, paramNames } = compilePath(originalPath);
    const route = {
      method,
      originalPath,
      fastParam: compileFastParamRoute(originalPath),
      matcher,
      paramNames,
      data,
    };

    this.routes.push(route);
    this.dynamicRoutes.push(route);
  }

  match(method: string, path: string): RouteMatch<TData> | undefined {
    const normalizedPath = normalizeMatchPath(path);
    const staticMatch = this.staticRoutes.get(method as HttpMethod)?.get(normalizedPath);
    if (staticMatch) {
      return {
        data: staticMatch.data,
        params: {},
      };
    }

    for (const route of this.dynamicRoutes) {
      if (route.method !== method) {
        continue;
      }

      if (route.fastParam) {
        const params = matchFastParamRoute(route.fastParam, normalizedPath);
        if (params) {
          return {
            data: route.data,
            params,
          };
        }
      }

      const matches = route.matcher.exec(normalizedPath);
      if (!matches) {
        continue;
      }

      const params = route.paramNames.reduce<Record<string, string>>((accumulator, name, index) => {
        const value = matches[index + 1];
        if (value) {
          accumulator[name] = decodePathParam(value);
        }
        return accumulator;
      }, {});

      return {
        data: route.data,
        params,
      };
    }

    return undefined;
  }

  allowedMethods(path: string): HttpMethod[] {
    const normalizedPath = normalizeMatchPath(path);
    const methods = new Set<HttpMethod>();

    for (const [method, routes] of this.staticRoutes) {
      if (routes.has(normalizedPath)) {
        methods.add(method);
      }
    }

    for (const route of this.dynamicRoutes) {
      if (!route.matcher.exec(normalizedPath)) {
        continue;
      }

      methods.add(route.method);
    }

    return [...methods];
  }
}
