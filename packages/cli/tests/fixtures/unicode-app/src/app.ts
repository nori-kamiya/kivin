import { defineApplication, defineModule } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { UserController } from './controller';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [UserController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
