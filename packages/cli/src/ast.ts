import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

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
  localDefinitions: Map<string, ts.Declaration>;
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
const compilerOptionsCache = new Map<string, ts.CompilerOptions>();

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
  const sourceFile = await parseSource(filePath);
  const context = createImportContext(filePath, sourceFile);
  const defineApplicationCall = findCallExpression(sourceFile, 'defineApplication');
  if (!defineApplicationCall || defineApplicationCall.arguments.length === 0) {
    throw new Error(`defineApplication(...) was not found in ${filePath}`);
  }

  const config = defineApplicationCall.arguments[0];
  if (!config) {
    throw new Error(`defineApplication(...) requires a config object in ${filePath}`);
  }
  if (!ts.isObjectLiteralExpression(config)) {
    throw new Error(`defineApplication(...) requires an object literal in ${filePath}`);
  }

  const modulesProperty = config.properties.find((property) => ts.isPropertyAssignment(property) && getPropertyName(property.name) === 'modules');
  if (!modulesProperty || !ts.isPropertyAssignment(modulesProperty) || !ts.isArrayLiteralExpression(modulesProperty.initializer)) {
    throw new Error(`defineApplication({ modules: [...] }) is required in ${filePath}`);
  }

  return modulesProperty.initializer.elements.map((element) => readModuleReference(context, asExpression(element), 'application modules'));
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
  const sourceFile = await parseSource(filePath);
  const context = createImportContext(filePath, sourceFile);
  const declaration = context.localDefinitions.get(className);

  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return parseInlineModuleDefinition(context, declaration.initializer, `module ${className}`);
  }

  const classDeclaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === className,
  );

  if (!classDeclaration) {
    throw new Error(`Module class or definition ${className} was not found in ${filePath}`);
  }

  const moduleDecorator = getDecoratorByName(classDeclaration, 'Module');
  const moduleCall = moduleDecorator ? getDecoratorCallExpression(moduleDecorator) : undefined;
  if (!moduleDecorator || !moduleCall || moduleCall.arguments.length === 0) {
    throw new Error(`@Module(...) was not found on ${className}`);
  }

  const config = moduleCall.arguments[0];
  if (!config || !ts.isObjectLiteralExpression(config)) {
    throw new Error(`@Module(...) on ${className} must use an object literal`);
  }

  return parseModuleObjectLiteral(context, config, `module ${className}`);
}

async function readController(filePath: string, className: string): Promise<AstControllerNode> {
  const sourceFile = await parseSource(filePath);
  const context = createImportContext(filePath, sourceFile);
  const classDeclaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && statement.name?.text === className,
  );

  if (!classDeclaration) {
    throw new Error(`Controller class ${className} was not found in ${filePath}`);
  }

  const controllerDecorator = getDecoratorByName(classDeclaration, 'Controller');
  const controllerCall = controllerDecorator ? getDecoratorCallExpression(controllerDecorator) : undefined;
  if (!controllerDecorator || !controllerCall || controllerCall.arguments.length === 0) {
    throw new Error(`@Controller(...) was not found on ${className}`);
  }

  const basePath = readStringLiteral(controllerCall.arguments[0], filePath, '@Controller path');
  const tags = readStringDecoratorValues(classDeclaration, 'Tag');
  const guards = readExpressionListDecoratorValues(context, classDeclaration, 'UseGuards');
  const middleware = readExpressionListDecoratorValues(context, classDeclaration, 'UseMiddleware');
  const filters = readExpressionListDecoratorValues(context, classDeclaration, 'UseFilters');
  const routes = classDeclaration.members
    .filter((member): member is ts.MethodDeclaration => ts.isMethodDeclaration(member) && !!member.name)
    .flatMap((member) => readRoute(context, filePath, member));

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

function readRoute(context: AstImportContext, filePath: string, method: ts.MethodDeclaration): AstRouteNode[] {
  const routeDecorator = ['Get', 'Head', 'Post', 'Put', 'Patch', 'Delete', 'Options']
    .map((name) => ({ name, decorator: getDecoratorByName(method, name) }))
    .find((candidate) => candidate.decorator);

  const routeCall = routeDecorator?.decorator ? getDecoratorCallExpression(routeDecorator.decorator) : undefined;
  if (!routeDecorator?.decorator || !routeCall || routeCall.arguments.length === 0) {
    return [];
  }

  const routePath = readStringLiteral(routeCall.arguments[0], filePath, `${routeDecorator.name} path`);
  const summaryDecorator = getDecoratorByName(method, 'Summary');
  const summaryCall = summaryDecorator ? getDecoratorCallExpression(summaryDecorator) : undefined;
  const summary = summaryCall?.arguments[0]
    ? readStringLiteral(summaryCall.arguments[0], filePath, 'Summary value')
    : undefined;
  const description = readStringDecoratorArgument(method, 'Description', filePath);
  const operationId = readStringDecoratorArgument(method, 'OperationId', filePath);
  const bodySchema = readSingleExpressionDecoratorValue(context, method, 'UseBodySchema');
  const querySchema = readSingleExpressionDecoratorValue(context, method, 'UseQuerySchema');
  const paramSchema = readSingleExpressionDecoratorValue(context, method, 'UseParamSchema');
  const security = readSecurityDecorators(method, filePath);
  const tags = readStringDecoratorValues(method, 'Tag');
  const guards = readExpressionListDecoratorValues(context, method, 'UseGuards');
  const middleware = readExpressionListDecoratorValues(context, method, 'UseMiddleware');
  const filters = readExpressionListDecoratorValues(context, method, 'UseFilters');
  const responses = readResponseDecorators(context, method, filePath);
  const parameters = method.parameters.flatMap((parameter, index) => readParameter(parameter, filePath, index));

  return [{
    methodName: method.name.getText(),
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

function readParameter(parameter: ts.ParameterDeclaration, filePath: string, index: number): RouteParameterDescriptor[] {
  const decorators = ts.getDecorators(parameter) ?? [];
  const result: RouteParameterDescriptor[] = [];

  for (const decorator of decorators) {
    const expression = getDecoratorCallExpression(decorator);
    if (!expression || !ts.isIdentifier(expression.expression)) {
      continue;
    }

    const decoratorName = expression.expression.text;
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

function readResponseDecorators(context: AstImportContext, method: ts.MethodDeclaration, filePath: string) {
  return (ts.getDecorators(method) ?? [])
    .map((decorator) => getDecoratorCallExpression(decorator))
    .filter((expression): expression is ts.CallExpression => !!expression && ts.isIdentifier(expression.expression) && ['Response', 'ApiResponse'].includes(expression.expression.text))
    .map((decorator) => {
      const status = readNumberLiteral(decorator.arguments[0], filePath, 'Response status');
      const secondArgument = decorator.arguments[1];
      const schema = secondArgument && !(ts.isStringLiteral(secondArgument) || ts.isNoSubstitutionTemplateLiteral(secondArgument))
        ? readExpressionRef(context, secondArgument)
        : undefined;
      const description = decorator.arguments[2]
        ? readStringLiteral(decorator.arguments[2], filePath, 'Response description')
        : secondArgument && (ts.isStringLiteral(secondArgument) || ts.isNoSubstitutionTemplateLiteral(secondArgument))
        ? readStringLiteral(secondArgument, filePath, 'Response description')
        : '';
      return schema ? { status, description, schema } : { status, description };
    });
}

function readSecurityDecorators(method: ts.MethodDeclaration, filePath: string) {
  return (ts.getDecorators(method) ?? [])
    .map((decorator) => getDecoratorCallExpression(decorator))
    .filter((expression): expression is ts.CallExpression => !!expression && ts.isIdentifier(expression.expression) && expression.expression.text === 'Security')
    .map((expression) => ({
      scheme: readStringLiteral(expression.arguments[0], filePath, 'Security scheme'),
      scopes: expression.arguments[1] && ts.isArrayLiteralExpression(expression.arguments[1])
        ? expression.arguments[1].elements.map((element) => readStringLiteral(asExpression(element), filePath, 'Security scope'))
        : [],
    }));
}

function readSymbolArrayProperty(context: AstImportContext, objectLiteral: ts.ObjectLiteralExpression, key: string): AstSymbolRef[] {
  const property = objectLiteral.properties.find((candidate) => ts.isPropertyAssignment(candidate) && getPropertyName(candidate.name) === key);
  if (!property || !ts.isPropertyAssignment(property)) {
    return [];
  }
  if (!ts.isArrayLiteralExpression(property.initializer)) {
    throw new Error(`${key} must be an array in ${context.filePath}`);
  }

  return property.initializer.elements.map((element) => resolveSymbolReference(context, element));
}

function readModuleArrayProperty(context: AstImportContext, objectLiteral: ts.ObjectLiteralExpression, key: string): AstModuleRef[] {
  const property = objectLiteral.properties.find((candidate) => ts.isPropertyAssignment(candidate) && getPropertyName(candidate.name) === key);
  if (!property || !ts.isPropertyAssignment(property)) {
    return [];
  }
  if (!ts.isArrayLiteralExpression(property.initializer)) {
    throw new Error(`${key} must be an array in ${context.filePath}`);
  }

  return property.initializer.elements.map((element) => readModuleReference(context, asExpression(element), key));
}

function readModuleReference(context: AstImportContext, expression: ts.Expression | undefined, label: string): AstModuleRef {
  if (!expression) {
    throw new Error(`Unsupported ${label} expression in ${context.filePath}`);
  }

  if (ts.isIdentifier(expression)) {
    const importBinding = context.imports.get(expression.text);
    if (importBinding) {
      return {
        kind: 'named',
        name: expression.text,
        filePath: importBinding.resolvedFilePath ?? resolveImportPath(context.filePath, importBinding.moduleSpecifier),
      };
    }

    const localDefinition = context.localDefinitions.get(expression.text);
    if (localDefinition && ts.isVariableDeclaration(localDefinition) && localDefinition.initializer) {
      return {
        kind: 'inline',
        filePath: context.filePath,
        ...parseInlineModuleDefinition(context, localDefinition.initializer, `${label} ${expression.text}`),
      };
    }

    if (context.localDefinitions.has(expression.text) || context.localExports.has(expression.text)) {
      return {
        kind: 'named',
        name: expression.text,
        filePath: context.filePath,
      };
    }
  }

  if (ts.isCallExpression(expression) || ts.isObjectLiteralExpression(expression)) {
    return {
      kind: 'inline',
      filePath: context.filePath,
      ...parseInlineModuleDefinition(context, expression, label),
    };
  }

  throw new Error(`Unsupported ${label} expression in ${context.filePath}: ${expression.getText()}`);
}

function parseInlineModuleDefinition(context: AstImportContext, expression: ts.Expression, label: string): AstModuleNode {
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'defineModule') {
    const argument = expression.arguments[0];
    if (!argument || !ts.isObjectLiteralExpression(argument)) {
      throw new Error(`${label} defineModule(...) must use an object literal in ${context.filePath}`);
    }
    return parseModuleObjectLiteral(context, argument, label);
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return parseModuleObjectLiteral(context, expression, label);
  }

  throw new Error(`${label} must be a @Module class, defineModule(...) call, or object literal in ${context.filePath}`);
}

function parseModuleObjectLiteral(context: AstImportContext, objectLiteral: ts.ObjectLiteralExpression, label: string): AstModuleNode {
  return {
    controllers: readSymbolArrayProperty(context, objectLiteral, 'controllers'),
    imports: readModuleArrayProperty(context, objectLiteral, 'imports'),
  };
}

function resolveSymbolReference(context: AstImportContext, node: ts.Expression): AstSymbolRef {
  if (!ts.isIdentifier(node)) {
    throw new Error(`Only identifier references are supported in ${context.filePath}: ${node.getText()}`);
  }

  const importBinding = context.imports.get(node.text);
  if (!importBinding) {
    if (context.localExports.has(node.text)) {
      return { name: node.text, filePath: context.filePath };
    }
    throw new Error(`Unable to resolve symbol ${node.text} in ${context.filePath}`);
  }

  return {
    name: node.text,
    filePath: importBinding.resolvedFilePath ?? resolveImportPath(context.filePath, importBinding.moduleSpecifier),
  };
}

function readSingleExpressionDecoratorValue(context: AstImportContext, node: ts.Node, decoratorName: string) {
  const decorator = getDecoratorByName(node, decoratorName);
  const expression = decorator ? getDecoratorCallExpression(decorator)?.arguments[0] : undefined;
  return expression ? readExpressionRef(context, expression) : undefined;
}

function readExpressionListDecoratorValues(context: AstImportContext, node: ts.Node, decoratorName: string) {
  const decorator = getDecoratorByName(node, decoratorName);
  const expression = decorator ? getDecoratorCallExpression(decorator) : undefined;
  if (!expression) {
    return [];
  }

  return expression.arguments.map((argument) => readExpressionRef(context, argument));
}

function readExpressionRef(context: AstImportContext, expression: ts.Expression): AstExpressionRef {
  const bindings = collectExpressionBindings(context, expression);
  return {
    text: expression.getText(),
    bindings,
  };
}

function collectExpressionBindings(context: AstImportContext, expression: ts.Expression): AstImportBinding[] {
  const seen = new Map<string, AstImportBinding>();

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        return;
      }
      const imported = context.imports.get(node.text);
      if (imported) {
        seen.set(`${imported.kind}:${imported.localName}:${imported.moduleSpecifier}`, imported);
        return;
      }
      if (context.localExports.has(node.text)) {
        seen.set(`named:${node.text}:${context.filePath}`, {
          kind: 'named',
          localName: node.text,
          importedName: node.text,
          moduleSpecifier: relative(dirname(context.filePath), context.filePath),
          resolvedFilePath: context.filePath,
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(expression);
  return [...seen.values()];
}

function createImportContext(filePath: string, sourceFile: ts.SourceFile): AstImportContext {
  const imports = new Map<string, AstImportBinding>();
  const localExports = new Set<string>();
  const localDefinitions = new Map<string, ts.Declaration>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
      const moduleSpecifier = statement.moduleSpecifier.text;
      if (statement.importClause.name) {
        const resolvedFilePath = resolveImportPathOrUndefined(filePath, moduleSpecifier);
        imports.set(statement.importClause.name.text, {
          kind: 'default',
          localName: statement.importClause.name.text,
          moduleSpecifier,
          ...(resolvedFilePath ? { resolvedFilePath } : {}),
        });
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        const resolvedFilePath = resolveImportPathOrUndefined(filePath, moduleSpecifier);
        imports.set(bindings.name.text, {
          kind: 'namespace',
          localName: bindings.name.text,
          moduleSpecifier,
          ...(resolvedFilePath ? { resolvedFilePath } : {}),
        });
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const resolvedFilePath = resolveImportPathOrUndefined(filePath, moduleSpecifier);
          imports.set(element.name.text, {
            kind: 'named',
            localName: element.name.text,
            importedName: element.propertyName?.text ?? element.name.text,
            moduleSpecifier,
            ...(resolvedFilePath ? { resolvedFilePath } : {}),
          });
        }
      }
    }

    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name && hasExportModifier(statement)) {
      localExports.add(statement.name.text);
    }
    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      localDefinitions.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          localExports.add(declaration.name.text);
        }
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          localDefinitions.set(declaration.name.text, declaration);
        }
      }
    }
  }

  return { filePath, imports, localExports, localDefinitions };
}

function hasExportModifier(node: ts.Node) {
  return (ts.getModifiers(node as ts.HasModifiers)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) ?? false;
}

function getDecoratorByName(node: ts.Node, decoratorName: string) {
  return (getDecorators(node) ?? []).find((decorator) => {
    const expression = getDecoratorCallExpression(decorator);
    if (!expression) {
      return false;
    }
    return ts.isIdentifier(expression.expression) && expression.expression.text === decoratorName;
  }) as ts.Decorator | undefined;
}

function readStringDecoratorValues(node: ts.Node, decoratorName: string) {
  return (getDecorators(node) ?? [])
    .map((decorator) => getDecoratorCallExpression(decorator))
    .filter((expression): expression is ts.CallExpression => !!expression && ts.isIdentifier(expression.expression) && expression.expression.text === decoratorName)
    .map((expression) => readStringLiteral(expression.arguments[0], node.getSourceFile().fileName, decoratorName));
}

function readStringDecoratorArgument(node: ts.Node, decoratorName: string, filePath: string) {
  const decorator = getDecoratorByName(node, decoratorName);
  const expression = decorator ? getDecoratorCallExpression(decorator) : undefined;
  const argument = expression?.arguments[0];
  return argument ? readStringLiteral(argument, filePath, decoratorName) : undefined;
}

function getDecorators(node: ts.Node) {
  return ts.getDecorators(node as ts.HasDecorators);
}

function getDecoratorCallExpression(decorator: ts.Decorator) {
  return ts.isCallExpression(decorator.expression) ? decorator.expression : undefined;
}

function readStringLiteral(node: ts.Expression | undefined, filePath: string, label: string) {
  if (!node || !ts.isStringLiteralLike(node)) {
    throw new Error(`${label} must be a string literal in ${filePath}`);
  }
  return node.text;
}

function readNumberLiteral(node: ts.Expression | undefined, filePath: string, label: string) {
  if (!node || !ts.isNumericLiteral(node)) {
    throw new Error(`${label} must be a numeric literal in ${filePath}`);
  }
  return Number(node.text);
}

function getPropertyName(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

function findCallExpression(sourceFile: ts.SourceFile, functionName: string): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === functionName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

async function parseSource(filePath: string) {
  const content = await readFile(filePath, 'utf8');
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, getScriptKind(filePath));
}

function getScriptKind(filePath: string) {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  return ts.ScriptKind.TS;
}

function resolveImportPath(fromFile: string, moduleSpecifier: string) {
  const resolved = resolveImportPathOrUndefined(fromFile, moduleSpecifier);
  if (!resolved) {
    throw new Error(`Unable to resolve import ${moduleSpecifier} from ${fromFile}`);
  }
  return resolved;
}

function resolveImportPathOrUndefined(fromFile: string, moduleSpecifier: string) {
  const compilerOptions = loadCompilerOptions(fromFile);
  const resolvedModule = ts.resolveModuleName(moduleSpecifier, fromFile, compilerOptions, ts.sys).resolvedModule;
  if (resolvedModule?.resolvedFileName && !resolvedModule.resolvedFileName.endsWith('.d.ts')) {
    return resolvedModule.resolvedFileName;
  }

  if (moduleSpecifier.startsWith('.')) {
    const basePath = resolve(dirname(fromFile), moduleSpecifier);
    return probeFile(basePath);
  }

  return undefined;
}

function loadCompilerOptions(fromFile: string) {
  const configPath = ts.findConfigFile(dirname(fromFile), ts.sys.fileExists, 'tsconfig.json');
  const cacheKey = configPath ?? '__default__';
  const cached = compilerOptionsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const compilerOptions = configPath
    ? parseTsConfig(configPath)
    : { moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: dirname(fromFile) };
  compilerOptionsCache.set(cacheKey, compilerOptions);
  return compilerOptions;
}

function parseTsConfig(configPath: string) {
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) {
    throw new Error(`Unable to read tsconfig: ${configPath}`);
  }

  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath)).options;
}

function probeFile(basePath: string) {
  for (const extension of SOURCE_EXTENSIONS) {
    const direct = `${basePath}${extension}`;
    if (ts.sys.fileExists(direct)) {
      return direct;
    }
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const nested = resolve(basePath, `index${extension}`);
    if (ts.sys.fileExists(nested)) {
      return nested;
    }
  }
  if (ts.sys.fileExists(basePath)) {
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
  const sourceFile = ts.createSourceFile('expression.ts', `const __value = (${expressionText});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) {
    return expressionText;
  }
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) {
    return expressionText;
  }

  const transformed = ts.transform<ts.Expression>(initializer, [
    (context) => (root) => ts.visitNode(root, function visit(node: ts.Node): ts.Node {
      if (ts.isIdentifier(node)) {
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
          return node;
        }
        const replacement = replacements.get(node.text);
        if (replacement) {
          return ts.factory.createIdentifier(replacement);
        }
      }
      return ts.visitEachChild(node, visit, context);
    }) as ts.Expression,
  ]);

  const printer = ts.createPrinter();
  const result = printer.printNode(ts.EmitHint.Expression, transformed.transformed[0] ?? initializer, sourceFile);
  transformed.dispose();
  return result;
}

function asExpression(node: ts.Node): ts.Expression | undefined {
  return ts.isExpression(node) ? node : undefined;
}
