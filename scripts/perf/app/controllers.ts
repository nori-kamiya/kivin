import type { RequestContext } from '@kivin/core';
import { ApiResponse, Body, Context, Controller, Delete, Get, Injectable, Patch, PathParam, Post, QueryParam, UseBodySchema, UseFilters, UseGuards, UseMiddleware, UseParamSchema, UseQuerySchema } from '@kivin/decorators';
import { ApiKeyGuard, REQUEST_STAMP, RequestIdMiddleware, UserNotFoundFilter, UserStore } from './providers';
import { CreateUserSchema, IdParamSchema, PatchUserSchema, SearchQuerySchema, UserSchema } from './schemas';

@Controller('/')
export class HealthController {
  @Get('/health')
  health() {
    return { ok: true };
  }

  @Get('/context')
  contextJson(@Context() context: RequestContext) {
    return context.json({ ok: true, path: '/context' });
  }
}

@Controller('/users')
@Injectable({ deps: [UserStore] })
export class UsersController {
  constructor(private readonly store: UserStore) {}

  @Get('/')
  @UseQuerySchema(SearchQuerySchema)
  list(@QueryParam('search') search?: string) {
    return this.store.list(search);
  }

  @Get('/:id')
  @UseParamSchema(IdParamSchema)
  @UseFilters(UserNotFoundFilter)
  @ApiResponse(200, UserSchema, 'user')
  find(@PathParam('id') id: string) {
    return this.store.find(id);
  }

  @Post('/')
  @UseGuards(ApiKeyGuard)
  @UseMiddleware(RequestIdMiddleware)
  @UseBodySchema(CreateUserSchema)
  create(@Body() input: { name: string; email: string }, @Context() context: RequestContext) {
    return context.json({ id: '999', ...input }, { status: 201 });
  }

  @Patch('/:id')
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @UseParamSchema(IdParamSchema)
  @UseBodySchema(PatchUserSchema)
  patch(@PathParam('id') id: string, @Body() input: { name?: string; email?: string }) {
    const user = this.store.find(id);
    return { ...user, ...input };
  }

  @Delete('/:id')
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @UseParamSchema(IdParamSchema)
  remove(@PathParam('id') id: string, @Context() context: RequestContext) {
    this.store.find(id);
    return context.noContent();
  }
}

@Controller('/scoped')
export class ScopedController {
  @Get('/')
  scoped(@Context() context: RequestContext) {
    return { stamp: context.inject<{ value: number }>(REQUEST_STAMP).value };
  }
}
