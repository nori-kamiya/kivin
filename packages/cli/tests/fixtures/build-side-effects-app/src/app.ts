import { defineApplication, defineModule } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { createDatabase, DATABASE, DatabaseLifecycle } from './db';
import { ItemsController } from './items.controller';

export default defineApplication({
  modules: [defineModule({
    providers: [{ provide: DATABASE, useFactory: createDatabase }, DatabaseLifecycle],
    controllers: [ItemsController],
    imports: [],
  })],
  schemaAdapter: createValibotAdapter(),
});
