import type { AstRouteNode } from './ast';

/**
 * Renders the `aot` factory for one manifest route: a straight-line executor specialised on the
 * route's parameters (literal argument list, direct method call, no per-request closures except the
 * middleware `next`). Validation, guards, middleware, filters and response finalisation are delegated
 * to `AotRouteRuntime` so behaviour stays identical to the runtime-compiled executor.
 */
export function renderAotFactory(route: AstRouteNode, controllerType: string, runtimeType: string, contextType: string): string | undefined {
  if (route.methodName.startsWith('[')) {
    return undefined;
  }

  const parameters = [...route.parameters].sort((left, right) => left.index - right.index);
  const inputFields = (parameter: AstRouteNode['parameters'][number]) => parameter.fields ?? ['params', 'query', 'body', 'context', 'headers'];
  const inputReads = (field: string) => parameters.some((parameter) => parameter.source === 'input' && inputFields(parameter).includes(field as never));
  const hasContextParameter = parameters.some((parameter) => parameter.source === 'context') || inputReads('context');
  const hasBodyParameter = parameters.some((parameter) => parameter.source === 'body') || inputReads('body');
  const needsParamPayload = Boolean(route.paramSchema) || inputReads('params') || parameters.some((parameter) => parameter.source === 'path' && !parameter.name);
  const needsQueryPayload = Boolean(route.querySchema) || inputReads('query') || parameters.some((parameter) => parameter.source === 'query' && !parameter.name);
  const readsBody = (hasBodyParameter || Boolean(route.bodySchema)) && route.method !== 'GET' && route.method !== 'HEAD';
  const method = JSON.stringify(route.methodName);

  const argumentList = (contextExpression: string) => {
    const maxIndex = parameters.reduce((max, parameter) => Math.max(max, parameter.index), -1);
    const values: string[] = [];
    for (let index = 0; index <= maxIndex; index += 1) {
      const parameter = parameters.find((candidate) => candidate.index === index);
      values.push(`${parameter ? argumentExpression(parameter, contextExpression) : 'undefined'} as never`);
    }
    return values.join(', ');
  };

  const argumentExpression = (parameter: AstRouteNode['parameters'][number], contextExpression: string) => {
    switch (parameter.source) {
      case 'input': {
        const values: Record<string, string> = { params: 'paramValue ?? {}', query: 'queryValue ?? {}', body: readsBody ? 'body' : 'undefined', context: contextExpression, headers: 'rt.headers(params)' };
        return `{ ${inputFields(parameter).map((field) => `${field}: ${values[field]}`).join(', ')} }`;
      }
      case 'context':
        return contextExpression;
      case 'body':
        return 'body';
      case 'query': {
        if (!parameter.name) {
          return 'queryValue';
        }
        const name = JSON.stringify(parameter.name);
        return needsQueryPayload
          ? `(typeof queryValue === 'object' && queryValue ? (queryValue as Record<string, unknown>)[${name}] : rt.readQueryParam(request.url, ${name}))`
          : `rt.readQueryParam(request.url, ${name})`;
      }
      case 'path': {
        if (!parameter.name) {
          return 'paramValue';
        }
        const name = JSON.stringify(parameter.name);
        return needsParamPayload
          ? `(typeof paramValue === 'object' && paramValue ? (paramValue as Record<string, unknown>)[${name}] : params[${name}])`
          : `params[${name}]`;
      }
    }
  };

  const bodyLine = (contextExpression: string) => (readsBody ? `const body = await rt.readBody(request, ${contextExpression});` : '');
  const indent = (text: string, spaces: number) => text.split('\n').filter((line) => line.trim() !== '').map((line) => `${' '.repeat(spaces)}${line}`).join('\n');

  const middlewareBranch = [
    'if (hasMiddleware) {',
    '  const ctx = (context ??= rt.createContext(request, params));',
    '  return await rt.runMiddleware(ctx, async () => {',
    `    ${bodyLine('ctx')}`,
    `    return controller[${method}](${argumentList('ctx')});`,
    '  });',
    '}',
  ].join('\n');

  const directBranch = hasContextParameter
    ? [
        'const ctx = (context ??= rt.createContext(request, params));',
        bodyLine('ctx'),
        `const result = controller[${method}](${argumentList('ctx')});`,
        'return rt.finish(rt.isThenable(result) ? await result : result, ctx);',
      ].join('\n')
    : [
        bodyLine('context'),
        `const result = controller[${method}](${argumentList('context')});`,
        'return rt.finish(rt.isThenable(result) ? await result : result, context);',
      ].join('\n');

  const body = [
    needsParamPayload ? 'const paramValue = rt.resolveParamPayload(params);' : '',
    needsQueryPayload ? 'const queryValue = rt.resolveQueryPayload(request.url);' : '',
    'if (hasGuards) {',
    '  const guarded = rt.runGuards(request, params, context);',
    '  context = rt.isThenable(guarded) ? await guarded : guarded;',
    '}',
    middlewareBranch,
    directBranch,
  ].join('\n');

  return [
    `(rt: ${runtimeType}<${controllerType}>) => {`,
    '        const controller = rt.controller;',
    '        const hasGuards = rt.hasGuards;',
    '        const hasMiddleware = rt.hasMiddleware;',
    '        return async (request: Request, params: Record<string, string>) => {',
    `          let context: ${contextType} | undefined;`,
    '          try {',
    indent(body, 12),
    '          } catch (error) {',
    '            return rt.handleError(error, context, request, params);',
    '          }',
    '        };',
    '      }',
  ].join('\n');
}
