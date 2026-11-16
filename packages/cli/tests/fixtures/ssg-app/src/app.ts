import { defineApplication, defineModule } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { Layout, PagesController } from './pages.controller';
import { store } from './posts';

export default defineApplication({
  modules: [defineModule({ providers: [{ provide: 'posts', useValue: store }, Layout], controllers: [PagesController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
