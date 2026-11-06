import { defineApplication } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { AotModule } from './modules';

export default defineApplication({
  modules: [AotModule],
  schemaAdapter: createValibotAdapter(),
});
