import {
    appendControllerEnhancers,
    appendControllerTag,
    appendRouteParameter,
    setControllerMetadata,
    setInjectableMetadata,
    setModuleDecoratorMetadata,
    setRouteMetadata,
    updateRouteDocs,
    updateRouteEnhancers,
    type Constructor,
    type HttpMethod,
    type ModuleLike,
    type ProviderDefinition,
    type Token,
} from '@kivin/core';

export function Module(input: {
  providers?: ProviderDefinition[];
  controllers?: Constructor[];
  imports?: ModuleLike[];
}) {
  return function moduleDecorator(target: Function) {
    setModuleDecoratorMetadata(target, {
      providers: input.providers ?? [],
      controllers: input.controllers ?? [],
      imports: input.imports ?? [],
    });
  };
}

export function Injectable(input: { deps?: unknown[] } = {}) {
  return function injectableDecorator(target: Function) {
    setInjectableMetadata(target, {
      deps: (input.deps ?? []) as never[],
    });
  };
}

export function Controller(basePath: string) {
  return function controllerDecorator(target: Function) {
    setControllerMetadata(target, {
      basePath,
      tags: [],
      guards: [],
      middleware: [],
      filters: [],
    });
  };
}

function createRouteDecorator(method: HttpMethod) {
  return function routeDecorator(path: string) {
    return function applyRouteDecorator(target: object, propertyKey: string | symbol) {
      setRouteMetadata(target, propertyKey, {
        method,
        path,
      });
    };
  };
}

export const Get = createRouteDecorator('GET');
export const Head = createRouteDecorator('HEAD');
export const Post = createRouteDecorator('POST');
export const Put = createRouteDecorator('PUT');
export const Patch = createRouteDecorator('PATCH');
export const Delete = createRouteDecorator('DELETE');
export const Options = createRouteDecorator('OPTIONS');

export function Tag(tag: string) {
  return function tagDecorator(target: object | Function, propertyKey?: string | symbol) {
    if (propertyKey === undefined && typeof target === 'function') {
      appendControllerTag(target, tag);
      return;
    }

    updateRouteDocs(target as object, propertyKey as string | symbol, (current) => ({
      ...current,
      tags: [...new Set([...current.tags, tag])],
    }));
  };
}

function createEnhancerDecorator(kind: 'guards' | 'middleware' | 'filters') {
  return function enhancerDecorator(...tokens: Token[]) {
    return function applyEnhancerDecorator(target: object | Function, propertyKey?: string | symbol) {
      if (propertyKey === undefined && typeof target === 'function') {
        appendControllerEnhancers(target, kind, tokens);
        return;
      }

      updateRouteEnhancers(target as object, propertyKey as string | symbol, (current) => ({
        ...current,
        [kind]: [...current[kind], ...tokens],
      }));
    };
  };
}

export const UseGuards = createEnhancerDecorator('guards');
export const UseMiddleware = createEnhancerDecorator('middleware');
export const UseFilters = createEnhancerDecorator('filters');

export function Summary(summary: string) {
  return function summaryDecorator(target: object, propertyKey: string | symbol) {
    updateRouteDocs(target, propertyKey, (current) => ({
      ...current,
      summary,
    }));
  };
}

export function Description(description: string) {
  return function descriptionDecorator(target: object, propertyKey: string | symbol) {
    updateRouteDocs(target, propertyKey, (current) => ({
      ...current,
      description,
    }));
  };
}

export function OperationId(operationId: string) {
  return function operationIdDecorator(target: object, propertyKey: string | symbol) {
    updateRouteDocs(target, propertyKey, (current) => ({
      ...current,
      operationId,
    }));
  };
}

export function Security(scheme: string, scopes: string[] = []) {
  return function securityDecorator(target: object, propertyKey: string | symbol) {
    updateRouteDocs(target, propertyKey, (current) => ({
      ...current,
      security: [...current.security, { scheme, scopes }],
    }));
  };
}

export function Response(status: number, schemaOrDescription?: unknown, description = '') {
  return function responseDecorator(target: object, propertyKey: string | symbol) {
    const schema = typeof schemaOrDescription === 'string' && description === '' ? undefined : schemaOrDescription;
    const actualDescription = typeof schemaOrDescription === 'string' && description === '' ? schemaOrDescription : description;
    updateRouteDocs(target, propertyKey, (current) => ({
      ...current,
      responses: [...current.responses, { status, description: actualDescription, schema }],
    }));
  };
}

export const ApiResponse = Response;

export function UseBodySchema(schema: unknown) {
  return function bodySchemaDecorator(target: object, propertyKey: string | symbol) {
    updateRouteDocs(target, propertyKey, (current) => ({
      ...current,
      bodySchema: schema,
    }));
  };
}

export function UseQuerySchema(schema: unknown) {
  return function querySchemaDecorator(target: object, propertyKey: string | symbol) {
    updateRouteDocs(target, propertyKey, (current) => ({
      ...current,
      querySchema: schema,
    }));
  };
}

export function UseParamSchema(schema: unknown) {
  return function paramSchemaDecorator(target: object, propertyKey: string | symbol) {
    updateRouteDocs(target, propertyKey, (current) => ({
      ...current,
      paramSchema: schema,
    }));
  };
}

export function Context() {
  return function contextDecorator(target: object, propertyKey: string | symbol, parameterIndex: number) {
    appendRouteParameter(target, propertyKey, {
      index: parameterIndex,
      source: 'context',
    });
  };
}

export function PathParam(name: string) {
  return function pathDecorator(target: object, propertyKey: string | symbol, parameterIndex: number) {
    appendRouteParameter(target, propertyKey, {
      index: parameterIndex,
      source: 'path',
      name,
    });
  };
}

export function QueryParam(name?: string) {
  return function queryDecorator(target: object, propertyKey: string | symbol, parameterIndex: number) {
    appendRouteParameter(
      target,
      propertyKey,
      name === undefined
        ? {
            index: parameterIndex,
            source: 'query',
          }
        : {
            index: parameterIndex,
            source: 'query',
            name,
          },
    );
  };
}

export function Body() {
  return function bodyDecorator(target: object, propertyKey: string | symbol, parameterIndex: number) {
    appendRouteParameter(target, propertyKey, {
      index: parameterIndex,
      source: 'body',
    });
  };
}
