import { defineApplication, defineModule } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { StaticController } from './controllers';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [StaticController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
