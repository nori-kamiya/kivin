// kivin decorators, written for TC39 standard decorators (TypeScript 5+ without
// `experimentalDecorators`, and Bun's default). Class-level metadata is keyed on the class;
// method-level metadata is keyed on the class's shared decorator metadata object
// (`context.metadata`, i.e. `Class[Symbol.metadata]`).
//
// Handlers take a single input object instead of parameter decorators (which TC39 does not have):
//
//   @Get('/:id')
//   @UseParamSchema(IdParams)
//   find({ params, context }: RouteInput<{ params: typeof IdParams }>) { ... }
import {
    appendControllerEnhancers,
    appendControllerTag,
    METADATA_SYMBOL,
    setControllerMetadata,
    setInjectableMetadata,
    setModuleDecoratorMetadata,
    setRouteMetadata,
    updateRouteDocs,
    updateRouteEnhancers,
    type BodyMediaType,
    type Constructor,
    type HttpMethod,
    type ModuleLike,
    type ProviderDefinition,
    type RouteDocsMetadata,
    type Token,
    type TokenValues,
} from '@kivin/core';

type ClassDecorator = (value: Function, context: ClassDecoratorContext) => void;
type MethodDecorator = (value: Function, context: ClassMethodDecoratorContext) => void;
type ClassOrMethodDecorator = (value: Function, context: ClassDecoratorContext | ClassMethodDecoratorContext) => void;

/**
 * With `experimentalDecorators: true` TypeScript / Bun call decorators with legacy arguments
 * (`target, key, descriptor`), which would silently record nothing. Fail loudly instead.
 */
function assertStandard(context: unknown, decorator: string): asserts context is DecoratorContext {
  if (typeof context !== 'object' || context === null || !('kind' in context)) {
    throw new TypeError(`@${decorator}: kivin uses TC39 standard decorators; remove "experimentalDecorators" from your tsconfig`);
  }
}

/** The per-class metadata object that method decorators key their data on. */
function metadataOf(context: DecoratorContext): object {
  if (!context.metadata) {
    // Only possible when `Symbol.metadata` was missing while the class was defined.
    throw new Error(`kivin: decorator metadata is unavailable (Symbol.metadata ${String(METADATA_SYMBOL.description)}); import @kivin/core before defining controllers`);
  }
  return context.metadata;
}

function assertMethod(context: DecoratorContext, decorator: string): asserts context is ClassMethodDecoratorContext {
  assertStandard(context, decorator);
  if (context.kind !== 'method' || context.static || context.private) {
    throw new TypeError(`@${decorator} can only decorate public instance methods`);
  }
}

function updateDocs(context: ClassMethodDecoratorContext, decorator: string, updater: (current: RouteDocsMetadata) => RouteDocsMetadata) {
  assertMethod(context, decorator);
  updateRouteDocs(metadataOf(context), context.name, updater);
}

export function Module(input: {
  providers?: ProviderDefinition[];
  controllers?: Constructor[];
  imports?: ModuleLike[];
}): ClassDecorator {
  return (value, context) => {
    assertStandard(context, 'Module');
    setModuleDecoratorMetadata(value, {
      providers: input.providers ?? [],
      controllers: input.controllers ?? [],
      imports: input.imports ?? [],
    });
  };
}

type DepsCountMismatch<TExpected, TReceived> = {
  readonly kivinError: 'The number of @Injectable deps does not match the constructor parameters';
  readonly constructorParameters: TExpected;
  readonly deps: TReceived;
};

/**
 * Declares the DI tokens passed to the constructor, in order.
 * The decorator is typed so that each token's value must be assignable to the matching
 * constructor parameter and the deps count must fit the constructor, catching drift at compile time.
 */
export function Injectable<const TDeps extends readonly Token[] = []>(input: { deps?: TDeps } = {}) {
  return function injectableDecorator<TTarget extends abstract new (...args: TokenValues<TDeps>) => unknown>(
    target: TTarget,
    context: ClassDecoratorContext<TTarget>,
  ): TDeps['length'] extends ConstructorParameters<TTarget>['length'] ? void : DepsCountMismatch<ConstructorParameters<TTarget>['length'], TDeps['length']> {
    assertStandard(context, 'Injectable');
    setInjectableMetadata(target, {
      deps: [...(input.deps ?? [])] as Token[],
    });
    return undefined as never;
  };
}

export function Controller(basePath: string): ClassDecorator {
  return (value, context) => {
    assertStandard(context, 'Controller');
    setControllerMetadata(value, {
      basePath,
      tags: [],
      guards: [],
      middleware: [],
      filters: [],
    });
  };
}

function createRouteDecorator(method: HttpMethod, name: string) {
  return function routeDecorator(path: string): MethodDecorator {
    return (_value, context) => {
      assertMethod(context, name);
      setRouteMetadata(metadataOf(context), context.name, { method, path });
    };
  };
}

export const Get = createRouteDecorator('GET', 'Get');
export const Head = createRouteDecorator('HEAD', 'Head');
export const Post = createRouteDecorator('POST', 'Post');
export const Put = createRouteDecorator('PUT', 'Put');
export const Patch = createRouteDecorator('PATCH', 'Patch');
export const Delete = createRouteDecorator('DELETE', 'Delete');
export const Options = createRouteDecorator('OPTIONS', 'Options');

export function Tag(tag: string): ClassOrMethodDecorator {
  return (value, context) => {
    assertStandard(context, 'Tag');
    if (context.kind === 'class') {
      appendControllerTag(value, tag);
      return;
    }
    updateDocs(context, 'Tag', (current) => ({ ...current, tags: [...new Set([...current.tags, tag])] }));
  };
}

function createEnhancerDecorator(kind: 'guards' | 'middleware' | 'filters', name: string) {
  return function enhancerDecorator(...tokens: Token[]): ClassOrMethodDecorator {
    return (value, context) => {
      assertStandard(context, name);
      if (context.kind === 'class') {
        appendControllerEnhancers(value, kind, tokens);
        return;
      }
      assertMethod(context, name);
      updateRouteEnhancers(metadataOf(context), context.name, (current) => ({
        ...current,
        [kind]: [...current[kind], ...tokens],
      }));
    };
  };
}

export const UseGuards = createEnhancerDecorator('guards', 'UseGuards');
export const UseMiddleware = createEnhancerDecorator('middleware', 'UseMiddleware');
export const UseFilters = createEnhancerDecorator('filters', 'UseFilters');

export function Summary(summary: string): MethodDecorator {
  return (_value, context) => updateDocs(context, 'Summary', (current) => ({ ...current, summary }));
}

export function Description(description: string): MethodDecorator {
  return (_value, context) => updateDocs(context, 'Description', (current) => ({ ...current, description }));
}

export function OperationId(operationId: string): MethodDecorator {
  return (_value, context) => updateDocs(context, 'OperationId', (current) => ({ ...current, operationId }));
}

export function Security(scheme: string, scopes: string[] = []): MethodDecorator {
  return (_value, context) => updateDocs(context, 'Security', (current) => ({ ...current, security: [...current.security, { scheme, scopes }] }));
}

export function Response(status: number, schemaOrDescription?: unknown, description = ''): MethodDecorator {
  const schema = typeof schemaOrDescription === 'string' && description === '' ? undefined : schemaOrDescription;
  const actualDescription = typeof schemaOrDescription === 'string' && description === '' ? schemaOrDescription : description;
  return (_value, context) => updateDocs(context, 'Response', (current) => ({
    ...current,
    responses: [...current.responses, { status, description: actualDescription, schema }],
  }));
}

export const ApiResponse = Response;

/**
 * Request body media type. `'multipart/form-data'` / `'application/x-www-form-urlencoded'` make the
 * route parse the body as a form (fields become strings or `File`s, repeated fields arrays), validate
 * it with `@UseBodySchema` and hand it to the handler as `body`; other content types get 415.
 */
export function Consumes(mediaType: BodyMediaType): MethodDecorator {
  return (_value, context) => updateDocs(context, 'Consumes', (current) => ({ ...current, consumes: mediaType }));
}

/** Maximum request body size in bytes for this route (413 above it); overrides the app's `bodyLimit`. */
export function BodyLimit(bytes: number): MethodDecorator {
  return (_value, context) => updateDocs(context, 'BodyLimit', (current) => ({ ...current, bodyLimit: bytes }));
}

/** Validates the request headers (lower-case names, e.g. `'x-api-version'`) passed as the input's `headers`. */
export function UseHeaderSchema(schema: unknown): MethodDecorator {
  return (_value, context) => updateDocs(context, 'UseHeaderSchema', (current) => ({ ...current, headerSchema: schema }));
}

export function UseBodySchema(schema: unknown): MethodDecorator {
  return (_value, context) => updateDocs(context, 'UseBodySchema', (current) => ({ ...current, bodySchema: schema }));
}

export function UseQuerySchema(schema: unknown): MethodDecorator {
  return (_value, context) => updateDocs(context, 'UseQuerySchema', (current) => ({ ...current, querySchema: schema }));
}

export function UseParamSchema(schema: unknown): MethodDecorator {
  return (_value, context) => updateDocs(context, 'UseParamSchema', (current) => ({ ...current, paramSchema: schema }));
}
