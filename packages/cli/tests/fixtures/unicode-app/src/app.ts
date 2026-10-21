import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { UserController } from './controller';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [UserController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
