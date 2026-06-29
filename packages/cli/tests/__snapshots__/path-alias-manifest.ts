import type { AppManifest } from '@kivin/core';
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
    }
  ],
};

export default manifest;
