import { HttpError, type RequestContext } from '@kivin/core';
import { ApiResponse, Body, Context, Controller, Delete, Get, Injectable, Patch, PathParam, Post, Put, QueryParam, UseBodySchema, UseFilters, UseGuards, UseMiddleware, UseParamSchema, UseQuerySchema } from '@kivin/decorators';
import { HeaderMiddleware, ItemMissing, MissingFilter, RawKeyGuard, REQUEST_ID, RoleGuard, Store, TraceMiddleware } from './providers';
import { ErrorBody, IdParams, Item, ItemInput, ItemPatch, SearchQuery } from './schemas';

@Controller('/aot')
@Injectable({ deps: [Store] })
export class AotController {
  constructor(private readonly store: Store) {}

  @Get('/context')
  context(@Context() context: RequestContext) {
    return context.json({ role: context.get('role') ?? null, path: new URL(context.request.url).pathname });
  }

  @Get('/search')
  @UseQuerySchema(SearchQuery)
  search(@QueryParam('q') q: string | undefined, @QueryParam() all: unknown, @Context() context: RequestContext) {
    context.setResponseHeader('x-search', q ?? '-');
    return { q: q ?? null, all };
  }

  @Get('/raw-query')
  rawQuery(@QueryParam('name') name: string | undefined, @Context() context: RequestContext) {
    return context.json({ name: name ?? null });
  }

  @Get('/items/:id')
  @UseParamSchema(IdParams)
  @UseFilters(MissingFilter)
  @ApiResponse(200, Item, 'item')
  @ApiResponse(404, ErrorBody, 'missing')
  find(@PathParam('id') id: number, @Context() context: RequestContext) {
    const item = this.store.items.get(id);
    if (!item) {
      throw new ItemMissing();
    }
    context.setResponseHeader('x-found', String(id));
    return item;
  }

  @Post('/items')
  @UseGuards(RoleGuard)
  @UseBodySchema(ItemInput)
  @ApiResponse(201, Item, 'created')
  async create(@Body() input: { name: string; price: number }, @Context() context: RequestContext) {
    const fromContext = await context.jsonBody<{ name: string }>();
    return { id: 99, name: `${input.name}/${fromContext.name}`, price: input.price };
  }

  @Put('/items/:id')
  @UseGuards(RawKeyGuard)
  @UseMiddleware(HeaderMiddleware)
  @UseParamSchema(IdParams)
  @UseBodySchema(ItemInput)
  replace(@PathParam('id') id: number, @Body() input: { name: string; price: number }) {
    if (input.price < 0) {
      throw new HttpError(422, 'Negative price');
    }
    return { id, ...input };
  }

  @Patch('/items/:id')
  @UseMiddleware(HeaderMiddleware, TraceMiddleware)
  @UseFilters(MissingFilter)
  @UseParamSchema(IdParams)
  @UseBodySchema(ItemPatch)
  patch(@PathParam('id') id: number, @Body() input: { name?: string; price?: number }, @Context() context: RequestContext) {
    const item = this.store.items.get(id);
    if (!item) {
      throw new ItemMissing();
    }
    context.setResponseHeader('x-patched', '1');
    return { ...item, ...input };
  }

  @Delete('/items/:id')
  @UseGuards(RawKeyGuard, RoleGuard)
  @ApiResponse(204, 'deleted')
  remove(@PathParam('id') id: string) {
    if (id === '0') {
      throw new Response('teapot', { status: 418 });
    }
    return undefined;
  }

  @Get('/boom/:kind')
  boom(@PathParam('kind') kind: string, @Context() context: RequestContext) {
    context.setCookie('boom', kind);
    if (kind === 'http') {
      throw new HttpError(409, 'Conflict here');
    }
    if (kind === 'response') {
      throw Response.json({ thrown: true }, { status: 400 });
    }
    if (kind === 'error') {
      throw new Error('kaboom');
    }
    return { kind };
  }

  @Get('/scoped')
  scoped(@Context() context: RequestContext) {
    const first = context.inject<{ id: number }>(REQUEST_ID);
    const second = context.inject<{ id: number }>(REQUEST_ID);
    return { same: first === second, positive: first.id > 0 };
  }

  @Post('/echo')
  echo(@Body() body: unknown, @Context() context: RequestContext) {
    context.setCookie('a', '1');
    context.setCookie('b', '2');
    return { body };
  }

  @Get('/invalid-response')
  @ApiResponse(200, Item, 'item')
  invalidResponse(@Context() context: RequestContext) {
    void context;
    return { id: 'not-a-number' };
  }

  @Get('/no-content')
  noContent(@Context() context: RequestContext) {
    context.setResponseStatus(204);
    return undefined;
  }
}
