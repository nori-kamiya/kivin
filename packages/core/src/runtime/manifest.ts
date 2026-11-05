// Builds an `AppManifest` from decorator metadata (the non-CLI path).
import { type AppDefinition, getControllerMetadata, getRouteDescriptors, type RouteDescriptor } from '../metadata';
import { flattenModules } from '../module';
import type { Constructor, Token } from '../types';
import type { AppManifest, ManifestRoute } from './types';

export function joinPaths(basePath: string, routePath: string): string {
  const cleanedBase = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const cleanedRoute = routePath === '/' ? '' : routePath.replace(/^\//, '');
  const combined = `${cleanedBase}/${cleanedRoute}`.replace(/\/+/g, '/');
  return combined || '/';
}

export function buildManifest<TSchema>(definition: AppDefinition<TSchema>): AppManifest<TSchema> {
  const routes: ManifestRoute<TSchema>[] = [];
  const modules = flattenModules(definition.modules);
  const seenControllers = new Set<Constructor>();

  for (const moduleDefinition of modules) {
    for (const controller of moduleDefinition.controllers) {
      if (seenControllers.has(controller)) {
        continue;
      }
      seenControllers.add(controller);

      const controllerMetadata = getControllerMetadata(controller);
      if (!controllerMetadata) {
        throw new Error(`Controller metadata is missing for ${controller.name}`);
      }

      for (const descriptor of getRouteDescriptors(controller)) {
        routes.push(buildRoute(controller, controllerMetadata, descriptor));
      }
    }
  }

  return { routes };
}

export function buildRoute<TSchema>(
  controller: Constructor,
  controllerMetadata: { basePath: string; tags: string[]; guards: Token[]; middleware: Token[]; filters: Token[] },
  descriptor: RouteDescriptor,
): ManifestRoute<TSchema> {
  return {
    method: descriptor.route.method,
    fullPath: joinPaths(controllerMetadata.basePath, descriptor.route.path),
    controller,
    methodName: descriptor.methodName,
    // Without the CLI there is no AST to see which input fields a handler destructures, so a handler
    // that declares a parameter receives the full input object.
    parameters: descriptor.parameters.length > 0
      ? descriptor.parameters
      : ((controller.prototype as Record<string, unknown>)[descriptor.methodName] as ((...args: unknown[]) => unknown) | undefined)?.length
        ? [{ index: 0, source: 'input' }]
        : [],
    guards: [...new Set([...controllerMetadata.guards, ...descriptor.enhancers.guards])],
    middleware: [...new Set([...controllerMetadata.middleware, ...descriptor.enhancers.middleware])],
    filters: [...new Set([...controllerMetadata.filters, ...descriptor.enhancers.filters])],
    docs: {
      ...descriptor.docs,
      tags: [...new Set([...controllerMetadata.tags, ...descriptor.docs.tags])],
    } as ManifestRoute<TSchema>['docs'],
  };
}
