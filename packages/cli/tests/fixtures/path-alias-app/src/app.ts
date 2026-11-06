import { FeatureAModule } from '@feature/feature-a/module';
import { FeatureBModule } from '@feature/feature-b/module';
import { defineApplication } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';

const appDefinition = defineApplication({
  modules: [FeatureAModule, FeatureBModule],
  schemaAdapter: createValibotAdapter(),
});

export default appDefinition;
