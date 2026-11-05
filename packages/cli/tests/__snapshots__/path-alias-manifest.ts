import type { AotRouteRuntime, AppManifest, RequestContext } from '@kivin/core';
import { FeatureAController } from '../fixtures/path-alias-app/src/feature-a/controller';
import { SharedSchema } from '../fixtures/path-alias-app/src/feature-a/schemas';
import { FeatureBController } from '../fixtures/path-alias-app/src/feature-b/controller';
import { SharedSchema as __SharedSchema_0 } from '../fixtures/path-alias-app/src/feature-b/schemas';

export const manifest: AppManifest = {
  routes: [
    {
      method: "GET",
      fullPath: "/a/",
      controller: FeatureAController,
      methodName: "list",
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: { tags: [], security: [], responses: [{ status: 200, description: "Feature A response", schema: SharedSchema }] },
      aot: (rt: AotRouteRuntime<FeatureAController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                return controller["list"]();
              });
            }
            const result = controller["list"]();
            return rt.finish(rt.isThenable(result) ? await result : result, context);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    },
    {
      method: "GET",
      fullPath: "/b/",
      controller: FeatureBController,
      methodName: "list",
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: { tags: [], security: [], responses: [{ status: 200, description: "Feature B response", schema: (__SharedSchema_0) }] },
      aot: (rt: AotRouteRuntime<FeatureBController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                return controller["list"]();
              });
            }
            const result = controller["list"]();
            return rt.finish(rt.isThenable(result) ? await result : result, context);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    }
  ],
};

export default manifest;
