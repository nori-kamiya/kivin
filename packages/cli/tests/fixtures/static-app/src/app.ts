import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { StaticController } from './controllers';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [StaticController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
