import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';
import type {
  ArrayExpressionElement,
  CallExpression,
  Class,
  Decorator,
  Expression,
  MethodDefinition,
  Node,
  ObjectExpression,
  ObjectProperty,
  ParamPattern,
  Program,
  PropertyKey,
  VariableDeclarator,
} from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';

interface AstImportBinding {
  kind: 'named' | 'default' | 'namespace';
  localName: string;
  importedName?: string;
  moduleSpecifier: string;
  resolvedFilePath?: string;
}

interface AstImportContext {
  filePath: string;
  imports: Map<string, AstImportBinding>;
  localExports: Set<string>;
  localDefinitions: Map<string, Node>;
}

interface ParsedSource {
  filePath: string;
  text: string;
  program: Program;
}

interface AstNamedModuleRef {
  kind: 'named';
  filePath: string;
  name: string;
}

interface AstInlineModuleRef {
  kind: 'inline';
  filePath: string;
  controllers: AstSymbolRef[];
  imports: AstModuleRef[];
}

type AstModuleRef = AstNamedModuleRef | AstInlineModuleRef;

interface AstModuleNode {
  controllers: AstSymbolRef[];
  imports: AstModuleRef[];
}

interface AstControllerNode {
  filePath: string;
  className: string;
  basePath: string;
  tags: string[];
  guards: AstExpressionRef[];
  middleware: AstExpressionRef[];
  filters: AstExpressionRef[];
  routes: AstRouteNode[];
}

interface AstRouteNode {
  methodName: string;
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  path: string;
  summary?: string;
  description?: string;
  operationId?: string;
  tags: string[];
  bodySchema?: AstExpressionRef;
  querySchema?: AstExpressionRef;
  paramSchema?: AstExpressionRef;
  security: Array<{ scheme: string; scopes: string[] }>;
  responses: Array<{ status: number; description: string; schema?: AstExpressionRef }>;
  parameters: Array<{ index: number; source: 'context' | 'path' | 'query' | 'body'; name?: string }>;
  guards: AstExpressionRef[];
  middleware: AstExpressionRef[];
  filters: AstExpressionRef[];
}

type RouteParameterDescriptor = { index: number; source: 'context' | 'path' | 'query' | 'body'; name?: string };

interface AstSymbolRef {
  name: string;
  filePath: string;
}

interface AstExpressionRef {
  text: string;
  bindings: AstImportBinding[];
}

interface GeneratedManifestResult {
  source: string;
}

interface RenderImportEntry {
  moduleSpecifier: string;
  kind: 'named' | 'default' | 'namespace';
  localName: string;
  importedName?: string;
  isType: boolean;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'];
const TYPESCRIPT_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const resolver = new ResolverFactory({
  tsconfig: 'auto',
  conditionNames: ['types', 'import', 'default'],
  mainFields: ['types', 'typings', 'module', 'main'],
  extensions: ['.ts', '.tsx', '.d.ts', '.mts', '.d.mts', '.cts', '.d.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
  extensionAlias: {
    '.js': ['.ts', '.tsx', '.d.ts', '.js'],
    '.jsx': ['.tsx', '.d.ts', '.jsx'],
    '.mjs': ['.mts', '.d.mts', '.mjs'],
    '.cjs': ['.cts', '.d.cts', '.cjs'],
  },
});

export async function buildManifestSourceFromAst(input: { entry: string; outFile: string }): Promise<GeneratedManifestResult> {
  const entryFile = resolve(input.entry);
  const moduleRefs = await readAppModules(entryFile);
  const controllerRefs = await collectControllerRefs(moduleRefs);
  const controllers = await Promise.all(controllerRefs.map((controllerRef) => readController(controllerRef.filePath, controllerRef.name)));
  const renderer = new ImportRenderer(resolve(input.outFile));
  renderer.addTypeImport('@kivin/core', 'AppManifest');
  const routeEntries = controllers.flatMap((controller) => controller.routes.map((route) => renderRoute(controller, route, renderer)));
  const imports = renderer.render();

  return {
    source: `${imports}\nexport const manifest: AppManifest = {\n  routes: [\n${routeEntries.join(',\n')}\n  ],\n};\n\nexport default manifest;\n`,
  };
}

async function readAppModules(filePath: string): Promise<AstModuleRef[]> {
  const source = await parseSource(filePath);
  const context = createImportContext(filePath, source);
  const defineApplicationCall = findCallExpression(source.program, 'defineApplication');
  if (!defineApplicationCall || defineApplicationCall.arguments.length === 0) {
    throw new Error(`defineApplication(...) was not found in ${filePath}`);
  }

  const config = defineApplicationCall.arguments[0];
  if (!config) {
    throw new Error(`defineApplication(...) requires a config object in ${filePath}`);
  }
  if (config.type !== 'ObjectExpression') {
    throw new Error(`defineApplication(...) requires an object literal in ${filePath}`);
  }

  const modulesProperty = findPropertyAssignment(source, config, 'modules');
  if (!modulesProperty || modulesProperty.value.type !== 'ArrayExpression') {
    throw new Error(`defineApplication({ modules: [...] }) is required in ${filePath}`);
  }

  return modulesProperty.value.elements.map((element) => readModuleReference(context, source, asExpression(element), 'application modules'));
}

async function collectControllerRefs(moduleRefs: AstModuleRef[]): Promise<AstSymbolRef[]> {
  const result = new Map<string, AstSymbolRef>();

  for (const moduleRef of moduleRefs) {
    await walkModule(moduleRef, result);
  }

  return [...result.values()];
}

async function walkModule(moduleRef: AstModuleRef, controllerRefs: Map<string, AstSymbolRef>) {
  const moduleNode = moduleRef.kind === 'inline'
    ? { controllers: moduleRef.controllers, imports: moduleRef.imports }
    : await readModule(moduleRef.filePath, moduleRef.name);
  for (const controller of moduleNode.controllers) {
    controllerRefs.set(`${controller.filePath}:${controller.name}`, controller);
  }

  for (const importedModule of moduleNode.imports) {
    await walkModule(importedModule, controllerRefs);
  }
}

async function readModule(filePath: string, className: string): Promise<AstModuleNode> {
  const source = await parseSource(filePath);
  const context = createImportContext(filePath, source);
  const declaration = context.localDefinitions.get(className);

  if (declaration && declaration.type === 'VariableDeclarator' && declaration.init) {
    return parseInlineModuleDefinition(context, source, declaration.init, `module ${className}`);
  }

  const classDeclaration = findClassDeclaration(source.program, className);

  if (!classDeclaration) {
    throw new Error(`Module class or definition ${className} was not found in ${filePath}`);
  }

  const moduleDecorator = getDecoratorByName(classDeclaration.decorators, 'Module');
  const moduleCall = moduleDecorator ? getDecoratorCallExpression(moduleDecorator) : undefined;
  if (!moduleDecorator || !moduleCall || moduleCall.arguments.length === 0) {
    throw new Error(`@Module(...) was not found on ${className}`);
  }

  const config = moduleCall.arguments[0];
  if (!config || config.type !== 'ObjectExpression') {
    throw new Error(`@Module(...) on ${className} must use an object literal`);
  }

  return parseModuleObjectLiteral(context, source, config, `module ${className}`);
}

async function readController(filePath: string, className: string): Promise<AstControllerNode> {
  const source = await parseSource(filePath);
  const context = createImportContext(filePath, source);
  const classDeclaration = findClassDeclaration(source.program, className);

  if (!classDeclaration) {
    throw new Error(`Controller class ${className} was not found in ${filePath}`);
  }

  const controllerDecorator = getDecoratorByName(classDeclaration.decorators, 'Controller');
  const controllerCall = controllerDecorator ? getDecoratorCallExpression(controllerDecorator) : undefined;
  if (!controllerDecorator || !controllerCall || controllerCall.arguments.length === 0) {
    throw new Error(`@Controller(...) was not found on ${className}`);
  }

  const basePath = readStringLiteral(controllerCall.arguments[0], filePath, '@Controller path');
  const tags = readStringDecoratorValues(classDeclaration.decorators, 'Tag', filePath);
  const guards = readExpressionListDecoratorValues(context, source, classDeclaration.decorators, 'UseGuards');
  const middleware = readExpressionListDecoratorValues(context, source, classDeclaration.decorators, 'UseMiddleware');
  const filters = readExpressionListDecoratorValues(context, source, classDeclaration.decorators, 'UseFilters');
  const routes = classDeclaration.body.body
    .filter((member): member is MethodDefinition => (member.type === 'MethodDefinition' || member.type === 'TSAbstractMethodDefinition') && member.kind === 'method')
    .flatMap((member) => readRoute(context, source, member));

  return {
    filePath,
    className,
    basePath,
    tags,
    guards,
    middleware,
    filters,
    routes,
  };
}

function readRoute(context: AstImportContext, source: ParsedSource, method: MethodDefinition): AstRouteNode[] {
  const filePath = source.filePath;
  const decorators = method.decorators;
  const routeDecorator = ['Get', 'Head', 'Post', 'Put', 'Patch', 'Delete', 'Options']
    .map((name) => ({ name, decorator: getDecoratorByName(decorators, name) }))
    .find((candidate) => candidate.decorator);

  const routeCall = routeDecorator?.decorator ? getDecoratorCallExpression(routeDecorator.decorator) : undefined;
  if (!routeDecorator?.decorator || !routeCall || routeCall.arguments.length === 0) {
    return [];
  }

  const routePath = readStringLiteral(routeCall.arguments[0], filePath, `${routeDecorator.name} path`);
  const summaryDecorator = getDecoratorByName(decorators, 'Summary');
  const summaryCall = summaryDecorator ? getDecoratorCallExpression(summaryDecorator) : undefined;
  const summary = summaryCall?.arguments[0]
    ? readStringLiteral(summaryCall.arguments[0], filePath, 'Summary value')
    : undefined;
  const description = readStringDecoratorArgument(decorators, 'Description', filePath);
  const operationId = readStringDecoratorArgument(decorators, 'OperationId', filePath);
  const bodySchema = readSingleExpressionDecoratorValue(context, source, decorators, 'UseBodySchema');
  const querySchema = readSingleExpressionDecoratorValue(context, source, decorators, 'UseQuerySchema');
  const paramSchema = readSingleExpressionDecoratorValue(context, source, decorators, 'UseParamSchema');
  const security = readSecurityDecorators(decorators, filePath);
  const tags = readStringDecoratorValues(decorators, 'Tag', filePath);
  const guards = readExpressionListDecoratorValues(context, source, decorators, 'UseGuards');
  const middleware = readExpressionListDecoratorValues(context, source, decorators, 'UseMiddleware');
  const filters = readExpressionListDecoratorValues(context, source, decorators, 'UseFilters');
  const responses = readResponseDecorators(context, source, decorators);
  const parameters = method.value.params.flatMap((parameter, index) => readParameter(parameter, filePath, index));

  return [{
    methodName: getPropertyKeyText(source, method.key, method.computed),
    method: routeDecorator.name.toUpperCase() as AstRouteNode['method'],
    path: routePath,
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    ...(operationId ? { operationId } : {}),
    tags,
    ...(bodySchema ? { bodySchema } : {}),
    ...(querySchema ? { querySchema } : {}),
    ...(paramSchema ? { paramSchema } : {}),
    security,
    responses,
    parameters,
    guards,
    middleware,
    filters,
  }];
}

function readParameter(parameter: ParamPattern, filePath: string, index: number): RouteParameterDescriptor[] {
  const decorators = parameter.decorators ?? [];
  const result: RouteParameterDescriptor[] = [];

  for (const decorator of decorators) {
    const expression = getDecoratorCallExpression(decorator);
    if (!expression || expression.callee.type !== 'Identifier') {
      continue;
    }

    const decoratorName = expression.callee.name;
    if (decoratorName === 'Context') {
      result.push({ index, source: 'context' });
      continue;
    }
    if (decoratorName === 'Body') {
      result.push({ index, source: 'body' });
      continue;
    }
    if (decoratorName === 'PathParam') {
      result.push({ index, source: 'path', name: readStringLiteral(expression.arguments[0], filePath, 'PathParam value') });
      continue;
    }
    if (decoratorName === 'QueryParam') {
      const name = expression.arguments[0] ? readStringLiteral(expression.arguments[0], filePath, 'QueryParam value') : undefined;
      result.push(name ? { index, source: 'query', name } : { index, source: 'query' });
    }

  }

  return result;
}

function readResponseDecorators(context: AstImportContext, source: ParsedSource, decorators: Decorator[]) {
  const filePath = source.filePath;
  return getDecoratorCalls(decorators, ['Response', 'ApiResponse'])
    .map((decorator) => {
      const status = readNumberLiteral(decorator.arguments[0], filePath, 'Response status');
      const secondArgument = decorator.arguments[1];
      const schema = secondArgument && !isStringLiteralLike(secondArgument)
        ? readExpressionRef(context, source, secondArgument)
        : undefined;
      const description = decorator.arguments[2]
        ? readStringLiteral(decorator.arguments[2], filePath, 'Response description')
        : secondArgument && isStringLiteralLike(secondArgument)
        ? readStringLiteral(secondArgument, filePath, 'Response description')
        : '';
      return schema ? { status, description, schema } : { status, description };
    });
}

function readSecurityDecorators(decorators: Decorator[], filePath: string) {
  return getDecoratorCalls(decorators, ['Security'])
    .map((expression) => {
      const scopes = expression.arguments[1];
      return {
        scheme: readStringLiteral(expression.arguments[0], filePath, 'Security scheme'),
        scopes: scopes && scopes.type === 'ArrayExpression'
          ? scopes.elements.map((element) => readStringLiteral(asExpression(element), filePath, 'Security scope'))
          : [],
      };
    });
}

function readSymbolArrayProperty(context: AstImportContext, source: ParsedSource, objectLiteral: ObjectExpression, key: string): AstSymbolRef[] {
  const property = findPropertyAssignment(source, objectLiteral, key);
  if (!property) {
    return [];
  }
  if (property.value.type !== 'ArrayExpression') {
    throw new Error(`${key} must be an array in ${context.filePath}`);
  }

  return property.value.elements.map((element) => resolveSymbolReference(context, source, element));
}

function readModuleArrayProperty(context: AstImportContext, source: ParsedSource, objectLiteral: ObjectExpression, key: string): AstModuleRef[] {
  const property = findPropertyAssignment(source, objectLiteral, key);
  if (!property) {
    return [];
  }
  if (property.value.type !== 'ArrayExpression') {
    throw new Error(`${key} must be an array in ${context.filePath}`);
  }

  return property.value.elements.map((element) => readModuleReference(context, source, asExpression(element), key));
}

function readModuleReference(context: AstImportContext, source: ParsedSource, expression: Expression | undefined, label: string): AstModuleRef {
  if (!expression) {
    throw new Error(`Unsupported ${label} expression in ${context.filePath}`);
  }

  if (expression.type === 'Identifier') {
    const importBinding = context.imports.get(expression.name);
    if (importBinding) {
      return {
        kind: 'named',
        name: expression.name,
        filePath: importBinding.resolvedFilePath ?? resolveImportPath(context.filePath, importBinding.moduleSpecifier),
      };
    }

    const localDefinition = context.localDefinitions.get(expression.name);
    if (localDefinition && localDefinition.type === 'VariableDeclarator' && localDefinition.init) {
      return {
        kind: 'inline',
        filePath: context.filePath,
        ...parseInlineModuleDefinition(context, source, localDefinition.init, `${label} ${expression.name}`),
      };
    }

    if (context.localDefinitions.has(expression.name) || context.localExports.has(expression.name)) {
      return {
        kind: 'named',
        name: expression.name,
        filePath: context.filePath,
      };
    }
  }

  if (expression.type === 'CallExpression' || expression.type === 'ObjectExpression') {
    return {
      kind: 'inline',
      filePath: context.filePath,
      ...parseInlineModuleDefinition(context, source, expression, label),
    };
  }

  throw new Error(`Unsupported ${label} expression in ${context.filePath}: ${getText(source, expression)}`);
}

function parseInlineModuleDefinition(context: AstImportContext, source: ParsedSource, expression: Expression, label: string): AstModuleNode {
  if (expression.type === 'CallExpression' && expression.callee.type === 'Identifier' && expression.callee.name === 'defineModule') {
    const argument = expression.arguments[0];
    if (!argument || argument.type !== 'ObjectExpression') {
      throw new Error(`${label} defineModule(...) must use an object literal in ${context.filePath}`);
    }
    return parseModuleObjectLiteral(context, source, argument, label);
  }

  if (expression.type === 'ObjectExpression') {
    return parseModuleObjectLiteral(context, source, expression, label);
  }

  throw new Error(`${label} must be a @Module class, defineModule(...) call, or object literal in ${context.filePath}`);
}

function parseModuleObjectLiteral(context: AstImportContext, source: ParsedSource, objectLiteral: ObjectExpression, label: string): AstModuleNode {
  return {
    controllers: readSymbolArrayProperty(context, source, objectLiteral, 'controllers'),
    imports: readModuleArrayProperty(context, source, objectLiteral, 'imports'),
  };
}

function resolveSymbolReference(context: AstImportContext, source: ParsedSource, node: ArrayExpressionElement): AstSymbolRef {
  if (!node || node.type !== 'Identifier') {
    throw new Error(`Only identifier references are supported in ${context.filePath}: ${node ? getText(source, node) : ''}`);
  }

  const importBinding = context.imports.get(node.name);
  if (!importBinding) {
    if (context.localExports.has(node.name)) {
      return { name: node.name, filePath: context.filePath };
    }
    throw new Error(`Unable to resolve symbol ${node.name} in ${context.filePath}`);
  }

  return {
    name: node.name,
    filePath: importBinding.resolvedFilePath ?? resolveImportPath(context.filePath, importBinding.moduleSpecifier),
  };
}

function readSingleExpressionDecoratorValue(context: AstImportContext, source: ParsedSource, decorators: Decorator[], decoratorName: string) {
  const decorator = getDecoratorByName(decorators, decoratorName);
  const expression = decorator ? getDecoratorCallExpression(decorator)?.arguments[0] : undefined;
  return expression ? readExpressionRef(context, source, expression) : undefined;
}

function readExpressionListDecoratorValues(context: AstImportContext, source: ParsedSource, decorators: Decorator[], decoratorName: string) {
  const decorator = getDecoratorByName(decorators, decoratorName);
  const expression = decorator ? getDecoratorCallExpression(decorator) : undefined;
  if (!expression) {
    return [];
  }

  return expression.arguments.map((argument) => readExpressionRef(context, source, argument));
}

function readExpressionRef(context: AstImportContext, source: ParsedSource, expression: Node): AstExpressionRef {
  const bindings = collectExpressionBindings(context, expression);
  return {
    text: getText(source, expression),
    bindings,
  };
}

function collectExpressionBindings(context: AstImportContext, expression: Node): AstImportBinding[] {
  const seen = new Map<string, AstImportBinding>();

  forEachReferenceIdentifier(expression, (identifier) => {
    const imported = context.imports.get(identifier.name);
    if (imported) {
      seen.set(`${imported.kind}:${imported.localName}:${imported.moduleSpecifier}`, imported);
      return;
    }
    if (context.localExports.has(identifier.name)) {
      seen.set(`named:${identifier.name}:${context.filePath}`, {
        kind: 'named',
        localName: identifier.name,
        importedName: identifier.name,
        moduleSpecifier: relative(dirname(context.filePath), context.filePath),
        resolvedFilePath: context.filePath,
      });
    }
  });

  return [...seen.values()];
}

function createImportContext(filePath: string, source: ParsedSource): AstImportContext {
  const imports = new Map<string, AstImportBinding>();
  const localExports = new Set<string>();
  const localDefinitions = new Map<string, Node>();

  for (const statement of source.program.body) {
    if (statement.type === 'ImportDeclaration' && statement.specifiers.length > 0) {
      const moduleSpecifier = statement.source.value;
      const resolvedFilePath = resolveImportPathOrUndefined(filePath, moduleSpecifier);
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportDefaultSpecifier') {
          imports.set(specifier.local.name, {
            kind: 'default',
            localName: specifier.local.name,
            moduleSpecifier,
            ...(resolvedFilePath ? { resolvedFilePath } : {}),
          });
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          imports.set(specifier.local.name, {
            kind: 'namespace',
            localName: specifier.local.name,
            moduleSpecifier,
            ...(resolvedFilePath ? { resolvedFilePath } : {}),
          });
        } else {
          imports.set(specifier.local.name, {
            kind: 'named',
            localName: specifier.local.name,
            importedName: specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value,
            moduleSpecifier,
            ...(resolvedFilePath ? { resolvedFilePath } : {}),
          });
        }
      }
    }

    const { declaration, exported } = unwrapExport(statement);
    if (!declaration) {
      continue;
    }
    if (
      (declaration.type === 'ClassDeclaration' || declaration.type === 'FunctionDeclaration' || declaration.type === 'TSDeclareFunction' || declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSTypeAliasDeclaration' || declaration.type === 'TSEnumDeclaration')
      && declaration.id
    ) {
      if (exported) {
        localExports.add(declaration.id.name);
      }
      localDefinitions.set(declaration.id.name, declaration);
    }
    if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier') {
          if (exported) {
            localExports.add(declarator.id.name);
          }
          localDefinitions.set(declarator.id.name, declarator);
        }
      }
    }
  }

  return { filePath, imports, localExports, localDefinitions };
}

function unwrapExport(statement: Program['body'][number]): { declaration: Node | null | undefined; exported: boolean } {
  if (statement.type === 'ExportNamedDeclaration') {
    return { declaration: statement.declaration, exported: true };
  }
  if (statement.type === 'ExportDefaultDeclaration') {
    return { declaration: statement.declaration, exported: true };
  }
  return { declaration: statement, exported: false };
}

function findClassDeclaration(program: Program, className: string): Class | undefined {
  for (const statement of program.body) {
    const { declaration } = unwrapExport(statement);
    if (declaration?.type === 'ClassDeclaration' && declaration.id?.name === className) {
      return declaration;
    }
  }
  return undefined;
}

function getDecoratorByName(decorators: Decorator[] | undefined, decoratorName: string) {
  return (decorators ?? []).find((decorator) => {
    const expression = getDecoratorCallExpression(decorator);
    return !!expression && expression.callee.type === 'Identifier' && expression.callee.name === decoratorName;
  });
}

function getDecoratorCalls(decorators: Decorator[] | undefined, decoratorNames: string[]) {
  return (decorators ?? [])
    .map((decorator) => getDecoratorCallExpression(decorator))
    .filter((expression): expression is CallExpression => !!expression && expression.callee.type === 'Identifier' && decoratorNames.includes(expression.callee.name));
}

function readStringDecoratorValues(decorators: Decorator[] | undefined, decoratorName: string, filePath: string) {
  return getDecoratorCalls(decorators, [decoratorName])
    .map((expression) => readStringLiteral(expression.arguments[0], filePath, decoratorName));
}

function readStringDecoratorArgument(decorators: Decorator[] | undefined, decoratorName: string, filePath: string) {
  const decorator = getDecoratorByName(decorators, decoratorName);
  const expression = decorator ? getDecoratorCallExpression(decorator) : undefined;
  const argument = expression?.arguments[0];
  return argument ? readStringLiteral(argument, filePath, decoratorName) : undefined;
}

function getDecoratorCallExpression(decorator: Decorator) {
  return decorator.expression.type === 'CallExpression' ? decorator.expression : undefined;
}

function isStringLiteralLike(node: Node) {
  return (node.type === 'Literal' && typeof node.value === 'string')
    || (node.type === 'TemplateLiteral' && node.expressions.length === 0);
}

function readStringLiteral(node: Node | null | undefined, filePath: string, label: string) {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? '';
  }
  throw new Error(`${label} must be a string literal in ${filePath}`);
}

function readNumberLiteral(node: Node | undefined, filePath: string, label: string) {
  if (node?.type !== 'Literal' || typeof node.value !== 'number') {
    throw new Error(`${label} must be a numeric literal in ${filePath}`);
  }
  return node.value;
}

function findPropertyAssignment(source: ParsedSource, objectLiteral: ObjectExpression, key: string): ObjectProperty | undefined {
  return objectLiteral.properties.find((property): property is ObjectProperty =>
    property.type === 'Property'
    && property.kind === 'init'
    && !property.method
    && !property.shorthand
    && getPropertyKeyText(source, property.key, property.computed) === key);
}

function getPropertyKeyText(source: ParsedSource, key: PropertyKey, computed: boolean) {
  if (computed) {
    return `[${getText(source, key)}]`;
  }
  if (key.type === 'Identifier') {
    return key.name;
  }
  if (key.type === 'Literal' && typeof key.value === 'string') {
    return key.value;
  }
  return getText(source, key);
}

function getText(source: ParsedSource, node: Node) {
  return source.text.slice(node.start, node.end);
}

function findCallExpression(program: Program, functionName: string): CallExpression | undefined {
  let found: CallExpression | undefined;
  walk(program, (node) => {
    if (found) {
      return false;
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === functionName) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

function walk(root: Node, visit: (node: Node, parent: Node | undefined, key: string | undefined) => boolean) {
  const visitNode = (node: Node, parent: Node | undefined, key: string | undefined) => {
    if (!visit(node, parent, key)) {
      return;
    }
    const children: Array<{ node: Node; key: string }> = [];
    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === 'parent') {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) {
            children.push({ node: item, key: childKey });
          }
        }
      } else if (isNode(value)) {
        children.push({ node: value, key: childKey });
      }
    }
    children.sort((left, right) => left.node.start - right.node.start);
    for (const child of children) {
      visitNode(child.node, node, child.key);
    }
  };
  visitNode(root, undefined, undefined);
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string' && typeof (value as { start?: unknown }).start === 'number';
}

function forEachReferenceIdentifier(root: Node, visit: (identifier: { name: string; start: number; end: number }, shorthand: boolean) => void) {
  const visited = new Set<number>();
  walk(root, (node, parent, key) => {
    if (node.type !== 'Identifier') {
      return true;
    }
    if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) {
      return false;
    }
    if (visited.has(node.start)) {
      return false;
    }
    visited.add(node.start);
    visit(node, parent?.type === 'Property' && parent.shorthand);
    return false;
  });
}

async function parseSource(filePath: string): Promise<ParsedSource> {
  const text = await readFile(filePath, 'utf8');
  const { program } = parseSync(filePath, text, { lang: filePath.endsWith('.tsx') ? 'tsx' : 'ts', sourceType: 'module' });
  return { filePath, text, program };
}

function resolveImportPath(fromFile: string, moduleSpecifier: string) {
  const resolved = resolveImportPathOrUndefined(fromFile, moduleSpecifier);
  if (!resolved) {
    throw new Error(`Unable to resolve import ${moduleSpecifier} from ${fromFile}`);
  }
  return resolved;
}

function resolveImportPathOrUndefined(fromFile: string, moduleSpecifier: string) {
  const isRelative = moduleSpecifier.startsWith('.');
  if (!isRelative && !hasTsconfig(dirname(fromFile))) {
    // Without a tsconfig, bare specifiers are tried relative to the importing file first (baseUrl-like).
    const local = probeFile(resolve(dirname(fromFile), moduleSpecifier), TYPESCRIPT_SOURCE_EXTENSIONS);
    if (local) {
      return local;
    }
  }

  const resolvedPath = resolver.resolveFileSync(fromFile, moduleSpecifier).path;
  if (resolvedPath && isTypeScriptSource(resolvedPath)) {
    return resolvedPath;
  }

  if (isRelative) {
    const basePath = resolve(dirname(fromFile), moduleSpecifier);
    return probeFile(basePath, SOURCE_EXTENSIONS);
  }

  return undefined;
}

function isTypeScriptSource(filePath: string) {
  return TYPESCRIPT_SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension)) && !/\.d\.[mc]?ts$/.test(filePath);
}

const tsconfigLookupCache = new Map<string, boolean>();

function hasTsconfig(directory: string): boolean {
  const cached = tsconfigLookupCache.get(directory);
  if (cached !== undefined) {
    return cached;
  }
  const parent = dirname(directory);
  const found = fileExists(resolve(directory, 'tsconfig.json')) || (parent !== directory && hasTsconfig(parent));
  tsconfigLookupCache.set(directory, found);
  return found;
}

function fileExists(filePath: string) {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function probeFile(basePath: string, extensions: string[]) {
  for (const extension of extensions) {
    const direct = `${basePath}${extension}`;
    if (fileExists(direct)) {
      return direct;
    }
  }
  for (const extension of extensions) {
    const nested = resolve(basePath, `index${extension}`);
    if (fileExists(nested)) {
      return nested;
    }
  }
  if (extensions === SOURCE_EXTENSIONS && fileExists(basePath)) {
    return basePath;
  }
  return undefined;
}

class ImportRenderer {
  private readonly imports = new Map<string, RenderImportEntry>();
  private readonly localNames = new Map<string, string>();
  private counter = 0;

  constructor(private readonly outFile: string) {}

  addNamedImport(filePath: string, importedName: string, localName = importedName) {
    const moduleSpecifier = toModuleSpecifier(this.outFile, filePath);
    const actualLocalName = this.claimLocalName(localName, `${moduleSpecifier}:${importedName}`);
    const key = `named:${moduleSpecifier}:${importedName}:${actualLocalName}`;
    this.imports.set(key, {
      moduleSpecifier,
      kind: 'named',
      localName: actualLocalName,
      importedName,
      isType: false,
    });
    return actualLocalName;
  }

  addTypeImport(moduleSpecifier: string, importedName: string, localName = importedName) {
    const actualLocalName = this.claimLocalName(localName, `type:${moduleSpecifier}:${importedName}`);
    const key = `type:named:${moduleSpecifier}:${importedName}:${actualLocalName}`;
    this.imports.set(key, {
      moduleSpecifier,
      kind: 'named',
      localName: actualLocalName,
      importedName,
      isType: true,
    });
    return actualLocalName;
  }

  addBinding(fromFile: string, binding: AstImportBinding) {
    const moduleSpecifier = binding.resolvedFilePath
      ? toModuleSpecifier(this.outFile, binding.resolvedFilePath)
      : binding.moduleSpecifier.startsWith('.')
      ? toModuleSpecifier(this.outFile, resolve(dirname(fromFile), binding.moduleSpecifier))
      : binding.moduleSpecifier;
    const actualLocalName = this.claimLocalName(binding.localName, `${binding.kind}:${moduleSpecifier}:${binding.importedName ?? binding.localName}`);
    const key = `${binding.kind}:${moduleSpecifier}:${actualLocalName}:${binding.importedName ?? ''}`;
    if (!this.imports.has(key)) {
      const entry: RenderImportEntry = {
        moduleSpecifier,
        kind: binding.kind,
        localName: actualLocalName,
        isType: false,
      };
      if (binding.importedName) {
        entry.importedName = binding.importedName;
      }
      this.imports.set(key, entry);
    }
    return actualLocalName;
  }

  uniqueLocalName(baseName: string) {
    const localName = `__${sanitizeIdentifier(baseName)}_${this.counter++}`;
    return localName;
  }

  private claimLocalName(requestedName: string, identity: string) {
    const existingIdentity = this.localNames.get(requestedName);
    if (!existingIdentity || existingIdentity === identity) {
      this.localNames.set(requestedName, identity);
      return requestedName;
    }

    let candidate = this.uniqueLocalName(requestedName);
    while (this.localNames.has(candidate)) {
      candidate = this.uniqueLocalName(requestedName);
    }
    this.localNames.set(candidate, identity);
    return candidate;
  }

  render() {
    const groups = new Map<string, RenderImportEntry[]>();

    for (const entry of this.imports.values()) {
      const groupKey = `${entry.moduleSpecifier}:${entry.isType ? 'type' : 'value'}:${entry.kind}`;
      const group = groups.get(groupKey);
      if (group) {
        group.push(entry);
      } else {
        groups.set(groupKey, [entry]);
      }
    }

    const lines = [...groups.values()]
      .sort((left, right) => compareImportEntries(left[0]!, right[0]!))
      .map((entries) => renderImportGroup(entries));

    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }
}

function compareImportEntries(left: RenderImportEntry, right: RenderImportEntry) {
  const leftIsBareModule = !left.moduleSpecifier.startsWith('.');
  const rightIsBareModule = !right.moduleSpecifier.startsWith('.');
  if (leftIsBareModule !== rightIsBareModule) {
    return leftIsBareModule ? -1 : 1;
  }

  const moduleComparison = left.moduleSpecifier.localeCompare(right.moduleSpecifier);
  if (moduleComparison !== 0) {
    return moduleComparison;
  }

  if (left.isType !== right.isType) {
    return left.isType ? -1 : 1;
  }

  return importKindOrder(left.kind) - importKindOrder(right.kind);
}

function importKindOrder(kind: RenderImportEntry['kind']) {
  switch (kind) {
    case 'default':
      return 0;
    case 'named':
      return 1;
    case 'namespace':
      return 2;
  }
}

function renderImportGroup(entries: RenderImportEntry[]) {
  const first = entries[0];
  if (!first) {
    return '';
  }

  if (first.kind === 'default') {
    return `import ${first.localName} from '${first.moduleSpecifier}';`;
  }

  if (first.kind === 'namespace') {
    return `import * as ${first.localName} from '${first.moduleSpecifier}';`;
  }

  const specifiers = [...entries]
    .sort((left, right) => {
      const importedNameComparison = (left.importedName ?? '').localeCompare(right.importedName ?? '');
      if (importedNameComparison !== 0) {
        return importedNameComparison;
      }

      return left.localName.localeCompare(right.localName);
    })
    .map((entry) => entry.importedName === entry.localName ? entry.importedName : `${entry.importedName} as ${entry.localName}`);

  return `import${first.isType ? ' type' : ''} { ${specifiers.join(', ')} } from '${first.moduleSpecifier}';`;
}

function renderRoute(controller: AstControllerNode, route: AstRouteNode, renderer: ImportRenderer) {
  const controllerLocalName = renderer.addNamedImport(controller.filePath, controller.className);
  const docsEntries = [
    route.summary ? `summary: ${JSON.stringify(route.summary)}` : undefined,
    route.description ? `description: ${JSON.stringify(route.description)}` : undefined,
    route.operationId ? `operationId: ${JSON.stringify(route.operationId)}` : undefined,
    `tags: ${renderStringArray([...new Set([...controller.tags, ...route.tags])])}`,
    route.bodySchema ? `bodySchema: ${renderExpression(controller.filePath, route.bodySchema, renderer)}` : undefined,
    route.querySchema ? `querySchema: ${renderExpression(controller.filePath, route.querySchema, renderer)}` : undefined,
    route.paramSchema ? `paramSchema: ${renderExpression(controller.filePath, route.paramSchema, renderer)}` : undefined,
    `security: ${renderSecurity(route.security)}`,
    `responses: [${route.responses.map((response) => `{ status: ${response.status}, description: ${JSON.stringify(response.description)}${response.schema ? `, schema: ${renderExpression(controller.filePath, response.schema, renderer)}` : ''} }`).join(', ')}]`,
  ].filter(Boolean);

  const routeGuards = renderExpressionList(controller.filePath, [...controller.guards, ...route.guards], renderer);
  const routeMiddleware = renderExpressionList(controller.filePath, [...controller.middleware, ...route.middleware], renderer);
  const routeFilters = renderExpressionList(controller.filePath, [...controller.filters, ...route.filters], renderer);

  return `    {\n      method: ${JSON.stringify(route.method)},\n      fullPath: ${JSON.stringify(joinPaths(controller.basePath, route.path))},\n      controller: ${controllerLocalName},\n      methodName: ${JSON.stringify(route.methodName)},\n      parameters: ${renderParameters(route.parameters)},\n      guards: ${routeGuards},\n      middleware: ${routeMiddleware},\n      filters: ${routeFilters},\n      docs: { ${docsEntries.join(', ')} },\n    }`;
}

function renderExpression(fromFile: string, expression: AstExpressionRef, renderer: ImportRenderer) {
  const replacements = new Map<string, string>();
  for (const binding of expression.bindings) {
    const actualLocalName = binding.resolvedFilePath === fromFile
      ? renderer.addNamedImport(fromFile, binding.importedName ?? binding.localName, binding.localName)
      : renderer.addBinding(fromFile, binding);
    if (actualLocalName !== binding.localName) {
      replacements.set(binding.localName, actualLocalName);
    }
  }
  return replacements.size > 0 ? rewriteExpressionIdentifiers(expression.text, replacements) : expression.text;
}

function renderExpressionList(fromFile: string, expressions: AstExpressionRef[], renderer: ImportRenderer) {
  return `[${expressions.map((expression) => renderExpression(fromFile, expression, renderer)).join(', ')}]`;
}

function renderStringArray(values: string[]) {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function renderParameters(parameters: AstRouteNode['parameters']) {
  return `[${parameters.map((parameter) => parameter.name ? `{ index: ${parameter.index}, source: ${JSON.stringify(parameter.source)}, name: ${JSON.stringify(parameter.name)} }` : `{ index: ${parameter.index}, source: ${JSON.stringify(parameter.source)} }`).join(', ')}]`;
}

function renderSecurity(security: AstRouteNode['security']) {
  return `[${security.map((entry) => `{ scheme: ${JSON.stringify(entry.scheme)}, scopes: ${renderStringArray(entry.scopes)} }`).join(', ')}]`;
}

function joinPaths(basePath: string, routePath: string) {
  const cleanedBase = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const cleanedRoute = routePath === '/' ? '' : routePath.replace(/^\//, '');
  const combined = `${cleanedBase}/${cleanedRoute}`.replace(/\/+/g, '/');
  return combined || '/';
}

function toModuleSpecifier(fromFile: string, targetFile: string) {
  const relativePath = relative(dirname(fromFile), targetFile).replace(/\\/g, '/').replace(/\.(ts|tsx|mts|cts|js|mjs)$/, '');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function sanitizeIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function rewriteExpressionIdentifiers(expressionText: string, replacements: Map<string, string>) {
  const prefix = 'const __value = ';
  const text = `${prefix}(${expressionText});`;
  const { program } = parseSync('expression.ts', text, { lang: 'ts', sourceType: 'module' });
  const statement = program.body[0];
  const initializer = statement?.type === 'VariableDeclaration' ? statement.declarations[0]?.init : undefined;
  if (!initializer) {
    return expressionText;
  }

  const edits: Array<{ start: number; end: number; text: string }> = [];
  forEachReferenceIdentifier(initializer, (identifier, shorthand) => {
    const replacement = replacements.get(identifier.name);
    if (replacement) {
      edits.push({ start: identifier.start, end: identifier.end, text: shorthand ? `${identifier.name}: ${replacement}` : replacement });
    }
  });

  let result = text.slice(initializer.start, initializer.end);
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, edit.start - initializer.start)}${edit.text}${result.slice(edit.end - initializer.start)}`;
  }
  return result;
}

function asExpression(node: ArrayExpressionElement): Expression | undefined {
  return node && node.type !== 'SpreadElement' ? node : undefined;
}
