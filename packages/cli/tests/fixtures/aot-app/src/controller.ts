import { HttpError, type RouteInput } from '@kivin/core';
import { ApiResponse, BodyLimit, Consumes, Controller, Delete, Get, Injectable, Patch, Post, Put, UseBodySchema, UseFilters, UseHeaderSchema, UseGuards, UseMiddleware, UseParamSchema, UseQuerySchema } from '@kivin/decorators';
import { HeaderMiddleware, ItemMissing, MissingFilter, RawKeyGuard, REQUEST_ID, RoleGuard, Store, TraceMiddleware } from './providers';
import { ErrorBody, IdParams, Item, ItemInput, ItemPatch, SearchQuery, UploadForm, VersionHeaders } from './schemas';

@Controller('/aot')
@Injectable({ deps: [Store] })
export class AotController {
  constructor(private readonly store: Store) {}

  @Get('/context')
  context({ context }: RouteInput) {
    return context.json({ role: context.get('role') ?? null, path: new URL(context.request.url).pathname });
  }

  @Get('/search')
  @UseQuerySchema(SearchQuery)
  search({ query, context }: RouteInput<{ query: typeof SearchQuery }>) {
    context.setResponseHeader('x-search', query.q ?? '-');
    return { q: query.q ?? null, all: query };
  }

  @Get('/raw-query')
  rawQuery({ query, context }: RouteInput) {
    return context.json({ name: query.name ?? null });
  }

  @Get('/whole-input')
  wholeInput(input: RouteInput) {
    return { params: input.params, query: input.query, hasContext: Boolean(input.context) };
  }

  @Get('/items/:id')
  @UseParamSchema(IdParams)
  @UseFilters(MissingFilter)
  @ApiResponse(200, Item, 'item')
  @ApiResponse(404, ErrorBody, 'missing')
  find({ params, context }: RouteInput<{ params: typeof IdParams }>) {
    const item = this.store.items.get(params.id);
    if (!item) {
      throw new ItemMissing();
    }
    context.setResponseHeader('x-found', String(params.id));
    return item;
  }

  @Post('/items')
  @UseGuards(RoleGuard)
  @UseBodySchema(ItemInput)
  @ApiResponse(201, Item, 'created')
  async create({ body, context }: RouteInput<{ body: typeof ItemInput }>) {
    const fromContext = await context.jsonBody<{ name: string }>();
    return { id: 99, name: `${body.name}/${fromContext.name}`, price: body.price };
  }

  @Put('/items/:id')
  @UseGuards(RawKeyGuard)
  @UseMiddleware(HeaderMiddleware)
  @UseParamSchema(IdParams)
  @UseBodySchema(ItemInput)
  replace({ params, body }: RouteInput<{ params: typeof IdParams; body: typeof ItemInput }>) {
    if (body.price < 0) {
      throw new HttpError(422, 'Negative price');
    }
    return { id: params.id, ...body };
  }

  @Patch('/items/:id')
  @UseMiddleware(HeaderMiddleware, TraceMiddleware)
  @UseFilters(MissingFilter)
  @UseParamSchema(IdParams)
  @UseBodySchema(ItemPatch)
  patch({ params, body, context }: RouteInput<{ params: typeof IdParams; body: typeof ItemPatch }>) {
    const item = this.store.items.get(params.id);
    if (!item) {
      throw new ItemMissing();
    }
    context.setResponseHeader('x-patched', '1');
    return { ...item, ...body };
  }

  @Delete('/items/:id')
  @UseGuards(RawKeyGuard, RoleGuard)
  @ApiResponse(204, 'deleted')
  remove({ params }: RouteInput) {
    if (params.id === '0') {
      throw new Response('teapot', { status: 418 });
    }
    return undefined;
  }

  @Get('/boom/:kind')
  boom({ params, context }: RouteInput) {
    context.setCookie('boom', params.kind!);
    if (params.kind === 'http') {
      throw new HttpError(409, 'Conflict here');
    }
    if (params.kind === 'response') {
      throw Response.json({ thrown: true }, { status: 400 });
    }
    if (params.kind === 'error') {
      throw new Error('kaboom');
    }
    return { kind: params.kind };
  }

  @Get('/scoped')
  scoped({ context }: RouteInput) {
    const first = context.inject<{ id: number }>(REQUEST_ID);
    const second = context.inject<{ id: number }>(REQUEST_ID);
    return { same: first === second, positive: first.id > 0 };
  }

  @Post('/echo')
  echo({ body, context }: RouteInput) {
    context.setCookie('a', '1');
    context.setCookie('b', '2');
    return { body };
  }

  @Post('/upload')
  @Consumes('multipart/form-data')
  @UseBodySchema(UploadForm)
  async upload({ body }: RouteInput<{ body: typeof UploadForm }>) {
    return { title: body.title, file: body.file.name, text: await body.file.text() };
  }

  @Get('/versioned/:id')
  @UseHeaderSchema(VersionHeaders)
  @UseParamSchema(IdParams)
  versioned({ headers, params }: RouteInput<{ headers: typeof VersionHeaders; params: typeof IdParams }>) {
    return { version: headers['x-api-version'], id: params.id };
  }

  @Post('/limited')
  @BodyLimit(2 * 32)
  limited({ body }: RouteInput) {
    return { body };
  }

  @Get('/invalid-response')
  @ApiResponse(200, Item, 'item')
  invalidResponse() {
    return { id: 'not-a-number' };
  }

  @Get('/no-content')
  noContent({ context }: RouteInput) {
    context.setResponseStatus(204);
    return undefined;
  }
}
