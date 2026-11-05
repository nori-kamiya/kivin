// Maps route parameter metadata onto handler arguments and invokes handlers.
import type { ParameterMetadata } from '../metadata';
import { readNamedQueryParam } from '../request-url';
import type { CompiledArgumentInput, CompiledArgumentResolver, CompiledHandlerArgumentGetter, CompiledHandlerExecutor, CompiledHandlerInvoker } from './types';

export function createArgumentResolver(parameters: ParameterMetadata[]): CompiledArgumentResolver {
  if (parameters.length === 0) {
    return () => [];
  }

  const length = Math.max(...parameters.map((parameter) => parameter.index)) + 1;

  return (input) => {
    const resolved = new Array<unknown>(length);

    for (const parameter of parameters) {
      resolved[parameter.index] = resolveParameterValue(parameter, input);
    }

    return resolved;
  };
}

export function resolveParameterValue(parameter: ParameterMetadata, input: CompiledArgumentInput) {
  switch (parameter.source) {
    case 'context':
      return input.context;
    case 'body':
      return input.bodyValue;
    case 'query':
      if (parameter.name) {
        if (typeof input.queryValue === 'object' && input.queryValue) {
          return (input.queryValue as Record<string, unknown>)[parameter.name];
        }

        return input.queryParam(parameter.name);
      }

      return input.queryValue;
    case 'path':
      if (parameter.name) {
        if (typeof input.paramValue === 'object' && input.paramValue) {
          return (input.paramValue as Record<string, unknown>)[parameter.name];
        }

        return input.params[parameter.name];
      }

      return input.paramValue;
  }
}

export function createCompiledArgumentGetter(parameter: ParameterMetadata): CompiledHandlerArgumentGetter {
  switch (parameter.source) {
    case 'context':
      return (_bodyValue, context) => context;
    case 'body':
      return (bodyValue) => bodyValue;
    case 'query':
      if (parameter.name) {
        return (_bodyValue, _context, _paramValue, _params, queryValue, requestUrl) => {
          if (typeof queryValue === 'object' && queryValue) {
            return (queryValue as Record<string, unknown>)[parameter.name!];
          }

          return readNamedQueryParam(requestUrl, parameter.name!);
        };
      }

      return (_bodyValue, _context, _paramValue, _params, queryValue) => queryValue;
    case 'path':
      if (parameter.name) {
        return (_bodyValue, _context, paramValue, params) => {
          if (typeof paramValue === 'object' && paramValue) {
            return (paramValue as Record<string, unknown>)[parameter.name!];
          }

          return params[parameter.name!];
        };
      }

      return (_bodyValue, _context, paramValue) => paramValue;
  }
}

export function createHandlerInvoker(parameters: ParameterMetadata[]): CompiledHandlerInvoker | undefined {
  if (parameters.length === 0 || parameters.length > 4) {
    return undefined;
  }

  const sortedParameters = [...parameters].sort((left, right) => left.index - right.index);
  if (!sortedParameters.every((parameter, index) => parameter.index === index)) {
    return undefined;
  }

  if (sortedParameters.length === 1) {
    return (controller, handler, input) => handler.call(controller, resolveParameterValue(sortedParameters[0]!, input));
  }

  if (sortedParameters.length === 2) {
    return (controller, handler, input) => handler.call(
      controller,
      resolveParameterValue(sortedParameters[0]!, input),
      resolveParameterValue(sortedParameters[1]!, input),
    );
  }

  if (sortedParameters.length === 3) {
    return (controller, handler, input) => handler.call(
      controller,
      resolveParameterValue(sortedParameters[0]!, input),
      resolveParameterValue(sortedParameters[1]!, input),
      resolveParameterValue(sortedParameters[2]!, input),
    );
  }

  return (controller, handler, input) => handler.call(
    controller,
    resolveParameterValue(sortedParameters[0]!, input),
    resolveParameterValue(sortedParameters[1]!, input),
    resolveParameterValue(sortedParameters[2]!, input),
    resolveParameterValue(sortedParameters[3]!, input),
  );
}

export function createCompiledHandlerExecutor(input: {
  controller: Record<string, unknown>;
  handler: (...args: unknown[]) => unknown;
  invokeHandler: CompiledHandlerInvoker | undefined;
  parameterCount: number;
  resolveArguments: CompiledArgumentResolver;
  parameters: ParameterMetadata[];
}): CompiledHandlerExecutor {
  const { controller, handler, invokeHandler, parameterCount, resolveArguments } = input;
  const sortedParameters = input.parameters
    .slice()
    .sort((left, right) => left.index - right.index);

  if (
    parameterCount === 1
    && sortedParameters[0]?.index === 0
    && sortedParameters[0]?.source === 'body'
  ) {
    return (bodyValue) => handler.call(controller, bodyValue);
  }

  if (
    parameterCount === 2
    && sortedParameters[0]?.index === 0
    && sortedParameters[0]?.source === 'path'
    && sortedParameters[0]?.name
    && sortedParameters[1]?.index === 1
    && sortedParameters[1]?.source === 'body'
  ) {
    const pathName = sortedParameters[0].name;
    return (bodyValue, _context, paramValue, params) => handler.call(
      controller,
      typeof paramValue === 'object' && paramValue
        ? (paramValue as Record<string, unknown>)[pathName]
        : params[pathName],
      bodyValue,
    );
  }

  const getters = sortedParameters.map((parameter) => createCompiledArgumentGetter(parameter));

  return (bodyValue, context, paramValue, params, queryValue, requestUrl) => {
    if (parameterCount === 0) {
      return handler.call(controller);
    }

    if (parameterCount === 1) {
      return handler.call(controller, getters[0]!(bodyValue, context, paramValue, params, queryValue, requestUrl));
    }

    if (parameterCount === 2) {
      return handler.call(
        controller,
        getters[0]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[1]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
      );
    }

    if (parameterCount === 3) {
      return handler.call(
        controller,
        getters[0]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[1]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[2]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
      );
    }

    if (parameterCount === 4) {
      return handler.call(
        controller,
        getters[0]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[1]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[2]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
        getters[3]!(bodyValue, context, paramValue, params, queryValue, requestUrl),
      );
    }

    if (invokeHandler) {
      return invokeHandler(controller, handler, {
        bodyValue,
        context,
        paramValue,
        params,
        queryParam: (name) => readNamedQueryParam(requestUrl, name),
        queryValue,
      });
    }

    return handler.apply(controller, resolveArguments({
      bodyValue,
      context,
      paramValue,
      params,
      queryParam: (name) => readNamedQueryParam(requestUrl, name),
      queryValue,
    }));
  };
}
