import { FeatureAModule } from '@feature/feature-a/module';
import { FeatureBModule } from '@feature/feature-b/module';
import { defineApplication } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';

const appDefinition = defineApplication({
  modules: [FeatureAModule, FeatureBModule],
  schemaAdapter: createValibotAdapter(),
});

export default appDefinition;
