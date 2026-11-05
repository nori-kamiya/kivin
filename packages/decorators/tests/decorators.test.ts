import { getControllerMetadata, getInjectableMetadata, getModuleDecoratorMetadata, getRouteDescriptors } from '@kivin/core';
import { describe, expect, test } from 'bun:test';
import {
    ApiResponse,
    Body,
    Context,
    Controller,
    Delete,
    Description,
    Get,
    Injectable,
    Module,
    OperationId,
    PathParam,
    Post,
    QueryParam,
    Security,
    Summary,
    Tag,
    UseBodySchema,
    UseFilters,
    UseGuards,
    UseMiddleware,
    UseParamSchema,
    UseQuerySchema,
} from '../src/index';

const TOKEN = Symbol.for('decorators.test.token');
const BODY_SCHEMA = { kind: 'body' };
const QUERY_SCHEMA = { kind: 'query' };
const PARAM_SCHEMA = { kind: 'param' };
const RESPONSE_SCHEMA = { kind: 'response' };

class Service {}
class Guard {}
class RouteGuard {}
class Middleware {}
class Filter {}

@Controller('/items')
@Tag('Items')
@UseGuards(Guard)
@UseMiddleware(Middleware)
@Injectable({ deps: [Service, TOKEN] })
class ItemsController {
  constructor(readonly service: Service, readonly token: unknown) {}

  @Get('/')
  @Summary('List items')
  @Description('Lists every item')
  @OperationId('items.list')
  @UseQuerySchema(QUERY_SCHEMA)
  @ApiResponse(200, RESPONSE_SCHEMA, 'Item list')
  list(@QueryParam('search') search?: string) {
    return search;
  }

  @Post('/:id')
  @Tag('Mutations')
  @Security('apiKey', ['write'])
  @UseParamSchema(PARAM_SCHEMA)
  @UseBodySchema(BODY_SCHEMA)
  @UseGuards(RouteGuard)
  @UseFilters(Filter)
  @ApiResponse(201, 'Created')
  create(@PathParam('id') id: string, @Body() body: unknown, @Context() context: unknown) {
    return { id, body, context };
  }

  @Delete('/:id')
  remove(@QueryParam() query: unknown) {
    return query;
  }

  helper() {
    return 'not a route';
  }
}

@Module({ providers: [Service], controllers: [ItemsController] })
class ItemsModule {}

describe('decorators', () => {
  test('@Injectable records deps in order', () => {
    expect(getInjectableMetadata(ItemsController).deps).toEqual([Service, TOKEN]);
  });

  test('@Module records providers, controllers and imports', () => {
    expect(getModuleDecoratorMetadata(ItemsModule)).toEqual({ providers: [Service], controllers: [ItemsController], imports: [] });
  });

  test('@Controller keeps class-level tags and enhancers', () => {
    const metadata = getControllerMetadata(ItemsController);
    expect(metadata?.basePath).toBe('/items');
    expect(metadata?.tags).toEqual(['Items']);
    expect(metadata?.guards).toEqual([Guard]);
    expect(metadata?.middleware).toEqual([Middleware]);
    expect(metadata?.filters).toEqual([]);
  });

  test('route decorators only register decorated methods', () => {
    const routes = getRouteDescriptors(ItemsController);
    expect(routes.map((route) => [route.methodName, route.route.method, route.route.path])).toEqual([
      ['list', 'GET', '/'],
      ['create', 'POST', '/:id'],
      ['remove', 'DELETE', '/:id'],
    ]);
  });

  test('docs decorators fill route documentation', () => {
    const list = getRouteDescriptors(ItemsController).find((route) => route.methodName === 'list')!;
    expect(list.docs).toMatchObject({
      summary: 'List items',
      description: 'Lists every item',
      operationId: 'items.list',
      querySchema: QUERY_SCHEMA,
      responses: [{ status: 200, description: 'Item list', schema: RESPONSE_SCHEMA }],
    });

    const create = getRouteDescriptors(ItemsController).find((route) => route.methodName === 'create')!;
    expect(create.docs).toMatchObject({
      tags: ['Mutations'],
      security: [{ scheme: 'apiKey', scopes: ['write'] }],
      bodySchema: BODY_SCHEMA,
      paramSchema: PARAM_SCHEMA,
      responses: [{ status: 201, description: 'Created' }],
    });
    expect(create.docs.responses[0]?.schema).toBeUndefined();
  });

  test('parameter decorators record sources sorted by index', () => {
    const routes = getRouteDescriptors(ItemsController);
    expect(routes.find((route) => route.methodName === 'list')!.parameters).toEqual([{ index: 0, source: 'query', name: 'search' }]);
    expect(routes.find((route) => route.methodName === 'create')!.parameters).toEqual([
      { index: 0, source: 'path', name: 'id' },
      { index: 1, source: 'body' },
      { index: 2, source: 'context' },
    ]);
    expect(routes.find((route) => route.methodName === 'remove')!.parameters).toEqual([{ index: 0, source: 'query' }]);
  });

  test('method-level enhancers are kept separate from controller-level ones', () => {
    const create = getRouteDescriptors(ItemsController).find((route) => route.methodName === 'create')!;
    expect(create.enhancers).toEqual({ guards: [RouteGuard], middleware: [], filters: [Filter] });
  });
});
