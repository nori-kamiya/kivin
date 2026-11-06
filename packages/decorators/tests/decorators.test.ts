import { buildManifest, defineApplication, getControllerMetadata, getInjectableMetadata, getModuleDecoratorMetadata, getRouteDescriptors, getRouteMetadataOwner, METADATA_SYMBOL } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { describe, expect, test } from 'bun:test';
import {
    ApiResponse,
    Controller,
    Delete,
    Description,
    Get,
    Injectable,
    Module,
    OperationId,
    Post,
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
  list(input: { query: { search?: string } }) {
    return input.query.search;
  }

  @Post('/:id')
  @Tag('Mutations')
  @Security('apiKey', ['write'])
  @UseParamSchema(PARAM_SCHEMA)
  @UseBodySchema(BODY_SCHEMA)
  @UseGuards(RouteGuard)
  @UseFilters(Filter)
  @ApiResponse(201, 'Created')
  create({ params, body, context }: { params: { id: string }; body: unknown; context: unknown }) {
    return { id: params.id, body, context };
  }

  @Delete('/:id')
  remove() {
    return undefined;
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

  test('records metadata on the class decorator metadata object (TC39)', () => {
    const owner = (ItemsController as unknown as Record<symbol, unknown>)[METADATA_SYMBOL];
    expect(owner).toBeDefined();
    expect(getRouteMetadataOwner(ItemsController)).toBe(owner as object);
  });

  test('handlers without parameter decorators expose no positional parameters', () => {
    for (const route of getRouteDescriptors(ItemsController)) {
      expect(route.parameters).toEqual([]);
    }
  });

  test('rejects decorating static methods', () => {
    expect(() => {
      class Invalid {
        @Get('/x')
        static handler() {
          return undefined;
        }
      }
      return Invalid;
    }).toThrow('@Get can only decorate public instance methods');
  });

  test('method-level enhancers are kept separate from controller-level ones', () => {
    const create = getRouteDescriptors(ItemsController).find((route) => route.methodName === 'create')!;
    expect(create.enhancers).toEqual({ guards: [RouteGuard], middleware: [], filters: [Filter] });
  });

  test('buildManifest gives handlers that declare a parameter the full input object', () => {
    const manifest = buildManifest(defineApplication({ modules: [ItemsModule], schemaAdapter: createValibotAdapter() }));
    const byMethod = Object.fromEntries(manifest.routes.map((route) => [route.methodName, route.parameters]));
    expect(byMethod.list).toEqual([{ index: 0, source: 'input' }]);
    expect(byMethod.remove).toEqual([]);
  });

  test('fails loudly when called with legacy (experimentalDecorators) arguments', () => {
    class Legacy {
      handler() {
        return undefined;
      }
    }
    const legacyCall = Get('/x') as unknown as (target: object, key: string, descriptor: PropertyDescriptor) => void;
    expect(() => legacyCall(Legacy.prototype, 'handler', Object.getOwnPropertyDescriptor(Legacy.prototype, 'handler')!)).toThrow('kivin uses TC39 standard decorators');
    expect(() => legacyCall(Legacy.prototype, 'handler', Object.getOwnPropertyDescriptor(Legacy.prototype, 'handler')!)).toThrow('Bun is at least 1.4.0');
    const legacyClassCall = Controller('/x') as unknown as (target: Function) => void;
    expect(() => legacyClassCall(Legacy)).toThrow('kivin uses TC39 standard decorators');
  });
});
