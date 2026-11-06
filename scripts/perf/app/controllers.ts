import type { RouteInput } from '@kivinjs/core';
import { ApiResponse, Controller, Delete, Get, Injectable, Patch, Post, UseBodySchema, UseFilters, UseGuards, UseMiddleware, UseParamSchema, UseQuerySchema } from '@kivinjs/decorators';
import { ApiKeyGuard, REQUEST_STAMP, RequestIdMiddleware, UserNotFoundFilter, UserStore } from './providers';
import { CreateUserSchema, IdParamSchema, PatchUserSchema, SearchQuerySchema, UserSchema } from './schemas';

@Controller('/')
export class HealthController {
  @Get('/health')
  health() {
    return { ok: true };
  }

  @Get('/context')
  contextJson({ context }: RouteInput) {
    return context.json({ ok: true, path: '/context' });
  }
}

@Controller('/users')
@Injectable({ deps: [UserStore] })
export class UsersController {
  constructor(private readonly store: UserStore) {}

  @Get('/')
  @UseQuerySchema(SearchQuerySchema)
  list({ query }: RouteInput<{ query: typeof SearchQuerySchema }>) {
    return this.store.list(query.search);
  }

  @Get('/:id')
  @UseParamSchema(IdParamSchema)
  @UseFilters(UserNotFoundFilter)
  @ApiResponse(200, UserSchema, 'user')
  find({ params }: RouteInput<{ params: typeof IdParamSchema }>) {
    return this.store.find(params.id);
  }

  @Post('/')
  @UseGuards(ApiKeyGuard)
  @UseMiddleware(RequestIdMiddleware)
  @UseBodySchema(CreateUserSchema)
  create({ body, context }: RouteInput<{ body: typeof CreateUserSchema }>) {
    return context.json({ id: '999', ...body }, { status: 201 });
  }

  @Patch('/:id')
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @UseParamSchema(IdParamSchema)
  @UseBodySchema(PatchUserSchema)
  patch({ params, body }: RouteInput<{ params: typeof IdParamSchema; body: typeof PatchUserSchema }>) {
    const user = this.store.find(params.id);
    return { ...user, ...body };
  }

  @Delete('/:id')
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @UseParamSchema(IdParamSchema)
  remove({ params, context }: RouteInput<{ params: typeof IdParamSchema }>) {
    this.store.find(params.id);
    return context.noContent();
  }
}

@Controller('/scoped')
export class ScopedController {
  @Get('/')
  scoped({ context }: RouteInput) {
    return { stamp: context.inject<{ value: number }>(REQUEST_STAMP).value };
  }
}
