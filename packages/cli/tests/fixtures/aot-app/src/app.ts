import { defineApplication } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { AotModule } from './modules';

export default defineApplication({
  modules: [AotModule],
  schemaAdapter: createValibotAdapter(),
});
