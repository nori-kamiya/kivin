import { defineApplication, defineModule } from '@kivinjs/core';
import { Controller, Get } from '@kivinjs/decorators';
import { createValibotAdapter } from '@kivinjs/valibot';

@Controller('/users')
export class UsersController {
  @Get('/')
  list() {
    return [];
  }

  @Get('/:id')
  find({ params }: { params: Record<string, string> }) {
    return { id: params.id };
  }
}

@Controller('/')
export class RootController {
  @Get('/')
  index() {
    return 'root';
  }
}

export default defineApplication({
  basePath: '/api/v1',
  modules: [defineModule({ providers: [], controllers: [UsersController, RootController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
