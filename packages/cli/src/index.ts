import { flattenModules, getInjectableMetadata, normalizeModule, type AppDefinition, type AppManifest, type CanActivate, type ModuleLike, type ProviderDefinition, type ProviderScope, type Token } from '@kivin/core';
import { buildOpenApiDocument } from '@kivin/openapi';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildManifestSourceFromAst } from './ast';

export interface RouteInspection {
  method: string;
  fullPath: string;
  controller: string;
  controllerScope: ProviderScope;
  executionMode: 'native-static' | 'singleton-runtime' | 'request-runtime' | 'context-runtime';
  methodName: string;
  operationId?: string;
  tags: string[];
  guards: string[];
  guardScopes: ProviderScope[];
  middleware: string[];
  middlewareScopes: ProviderScope[];
  filters: string[];
  filterScopes: ProviderScope[];
}

export interface ModuleInspection {
  name: string;
  providers: string[];
  controllers: string[];
  controllerScopes: ProviderScope[];
  imports: string[];
  globalGuards?: string[];
  globalGuardScopes?: ProviderScope[];
  globalMiddleware?: string[];
  globalMiddlewareScopes?: ProviderScope[];
  globalFilters?: string[];
  globalFilterScopes?: ProviderScope[];
}

export async function loadAppDefinition(entry: string): Promise<AppDefinition<unknown>> {
  const absoluteEntry = resolve(entry);
  const moduleNamespace = await import(pathToFileURL(absoluteEntry).href);
  const candidate = moduleNamespace.default ?? moduleNamespace.appDefinition;

  if (!candidate || typeof candidate !== 'object' || !('modules' in candidate) || !('schemaAdapter' in candidate)) {
    throw new Error(`App definition was not found in ${entry}`);
  }

  return candidate as AppDefinition<unknown>;
}

export async function generateArtifacts(input: { entry: string; outDir: string; title?: string; version?: string }) {
  const outDir = resolve(input.outDir);
  const manifestPath = resolve(outDir, 'manifest.ts');

  await mkdir(outDir, { recursive: true });
  const generated = await buildManifestSourceFromAst({
    entry: input.entry,
    outFile: manifestPath,
  });
  await writeFile(manifestPath, generated.source, 'utf8');

  const appDefinition = await loadAppDefinition(input.entry);
  const manifest = await loadManifest(manifestPath);
  const openApi = buildOpenApiDocument({
    manifest,
    schemaAdapter: appDefinition.schemaAdapter,
    info: {
      title: input.title ?? 'kivin app',
      version: input.version ?? '0.1.0',
    },
    ...(appDefinition.openApi ? { config: appDefinition.openApi } : {}),
  });

  await writeFile(resolve(outDir, 'openapi.json'), JSON.stringify(openApi, null, 2), 'utf8');

  return {
    manifestPath,
    openApiPath: resolve(outDir, 'openapi.json'),
  };
}

export async function generateOpenApi(input: { entry: string; output: string; title?: string; version?: string }) {
  const appDefinition = await loadAppDefinition(input.entry);
  const manifestPath = resolve(dirname(resolve(input.output)), 'manifest.ts');
  const generated = await buildManifestSourceFromAst({
    entry: input.entry,
    outFile: manifestPath,
  });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, generated.source, 'utf8');
  const manifest = await loadManifest(manifestPath);
  const openApi = buildOpenApiDocument({
    manifest,
    schemaAdapter: appDefinition.schemaAdapter,
    info: {
      title: input.title ?? 'kivin app',
      version: input.version ?? '0.1.0',
    },
    ...(appDefinition.openApi ? { config: appDefinition.openApi } : {}),
  });

  await mkdir(dirname(resolve(input.output)), { recursive: true });
  await writeFile(resolve(input.output), JSON.stringify(openApi, null, 2), 'utf8');
  return resolve(input.output);
}

export async function inspectRoutes(input: { entry: string }) {
  const appDefinition = await loadAppDefinition(input.entry);
  const manifest = await buildManifestFromEntry(input.entry);
  const inspectionState = buildInspectionState(appDefinition);

  return manifest.routes.map((route): RouteInspection => ({
    method: route.method,
    fullPath: route.fullPath,
    controller: route.controller.name,
    controllerScope: inspectionState.providerScopes.get(route.controller) ?? 'singleton',
    executionMode: describeExecutionMode(route, inspectionState),
    methodName: route.methodName,
    tags: route.docs.tags,
    guards: route.guards.map(describeToken),
    guardScopes: route.guards.map((token) => inspectionState.providerScopes.get(token) ?? 'singleton'),
    middleware: route.middleware.map(describeToken),
    middlewareScopes: route.middleware.map((token) => inspectionState.providerScopes.get(token) ?? 'singleton'),
    filters: route.filters.map(describeToken),
    filterScopes: route.filters.map((token) => inspectionState.providerScopes.get(token) ?? 'singleton'),
    ...(route.docs.operationId ? { operationId: route.docs.operationId } : {}),
  }));
}

export async function inspectModules(input: { entry: string }) {
  const appDefinition = await loadAppDefinition(input.entry);
  const inspectionState = buildInspectionState(appDefinition);
  const state = { inlineModuleCounter: 0 };
  const modules = walkModules(appDefinition.modules, state, inspectionState);
  const rootModule = modules[0];
  if (rootModule) {
    rootModule.globalGuards = inspectionState.globalGuardTokens.map(describeToken);
    rootModule.globalGuardScopes = inspectionState.globalGuardTokens.map((token) => inspectionState.providerScopes.get(token) ?? 'singleton');
    rootModule.globalMiddleware = inspectionState.globalMiddlewareTokens.map(describeToken);
    rootModule.globalMiddlewareScopes = inspectionState.globalMiddlewareTokens.map((token) => inspectionState.providerScopes.get(token) ?? 'singleton');
    rootModule.globalFilters = inspectionState.globalFilterTokens.map(describeToken);
    rootModule.globalFilterScopes = inspectionState.globalFilterTokens.map((token) => inspectionState.providerScopes.get(token) ?? 'singleton');
  }

  return modules;
}

async function loadManifest(manifestPath: string): Promise<AppManifest<unknown>> {
  const moduleNamespace = await import(`${pathToFileURL(manifestPath).href}?t=${Date.now()}`);
  const candidate = moduleNamespace.default ?? moduleNamespace.manifest;
  if (!candidate || typeof candidate !== 'object' || !('routes' in candidate)) {
    throw new Error(`Generated manifest was not found in ${manifestPath}`);
  }
  return candidate as AppManifest<unknown>;
}

async function buildManifestFromEntry(entry: string) {
  const absoluteEntry = resolve(entry);
  const outDir = await mkdtemp(resolve(dirname(absoluteEntry), '.kivin-inspect-'));
  const manifestPath = resolve(outDir, 'manifest.ts');

  try {
    const generated = await buildManifestSourceFromAst({
      entry,
      outFile: manifestPath,
    });
    await writeFile(manifestPath, generated.source, 'utf8');
    return await loadManifest(manifestPath);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function walkModules(
  modules: ModuleLike[],
  state: { inlineModuleCounter: number },
  inspectionState: { providerScopes: Map<Token, ProviderScope> },
) {
  return modules.flatMap((moduleLike): ModuleInspection[] => {
    const normalized = normalizeModule(moduleLike);
    const name = typeof moduleLike === 'function' ? moduleLike.name : `inline-module-${state.inlineModuleCounter++}`;
    const current: ModuleInspection = {
      name,
      providers: normalized.providers.map(describeProvider),
      controllers: normalized.controllers.map((controller) => controller.name),
      controllerScopes: normalized.controllers.map((controller) => inspectionState.providerScopes.get(controller) ?? 'singleton'),
      imports: normalized.imports.map((importedModule) => typeof importedModule === 'function' ? importedModule.name : 'inline-module'),
    };

    return [current, ...walkModules(normalized.imports, state, inspectionState)];
  });
}

function buildInspectionState(appDefinition: AppDefinition<unknown>) {
  const providerScopes = new Map<Token, ProviderScope>();
  const rawGuardTokens = new Set<Token>();
  const checkedRawGuardTokens = new Set<Token>();
  const globalGuardTokens = appDefinition.globals?.guards ?? [];
  const globalMiddlewareTokens = appDefinition.globals?.middleware ?? [];
  const globalFilterTokens = appDefinition.globals?.filters ?? [];

  for (const moduleDefinition of flattenModules(appDefinition.modules)) {
    for (const provider of moduleDefinition.providers) {
      const token = typeof provider === 'function' ? provider : provider.provide;
      const scope = typeof provider === 'function' ? 'singleton' : (provider.scope ?? 'singleton');
      providerScopes.set(token, scope);
    }

    for (const controller of moduleDefinition.controllers) {
      if (!providerScopes.has(controller)) {
        providerScopes.set(controller, 'singleton');
      }
    }
  }

  return {
    appDefinition,
    checkedRawGuardTokens,
    globalFilterTokens,
    globalGuardTokens,
    globalMiddlewareTokens,
    providerScopes,
    rawGuardTokens,
  };
}

function resolveSingletonToken<T>(appDefinition: AppDefinition<unknown>, token: Token): T | undefined {
  const providerMap = new Map<Token, ProviderDefinition>();
  const singletonCache = new Map<Token, unknown>();

  for (const moduleDefinition of flattenModules(appDefinition.modules)) {
    for (const provider of moduleDefinition.providers) {
      if (typeof provider === 'function') {
        providerMap.set(provider, { provide: provider, useClass: provider });
        continue;
      }

      providerMap.set(provider.provide, provider);
    }

    for (const controller of moduleDefinition.controllers) {
      if (!providerMap.has(controller)) {
        providerMap.set(controller, { provide: controller, useClass: controller });
      }
    }
  }

  const resolveToken = (currentToken: Token): unknown => {
    if (singletonCache.has(currentToken)) {
      return singletonCache.get(currentToken);
    }

    const provider = providerMap.get(currentToken);
    if (!provider) {
      return undefined;
    }

    let instance: unknown;
    if (typeof provider === 'function') {
      instance = instantiateClass(provider, resolveToken);
    } else if ('useValue' in provider) {
      instance = provider.useValue;
    } else if ('useFactory' in provider) {
      instance = provider.useFactory({
        resolve: <TResolved>(nestedToken: Token<TResolved>) => resolveToken(nestedToken) as TResolved,
      });
    } else {
      instance = instantiateClass(provider.useClass, resolveToken);
    }

    singletonCache.set(currentToken, instance);
    return instance;
  };

  return resolveToken(token) as T | undefined;
}

function instantiateClass<T>(constructor: new (...args: never[]) => T, resolveToken: (token: Token) => unknown): T {
  const deps = getInjectableMetadata(constructor).deps.map((token) => resolveToken(token));
  return new constructor(...(deps as never[]));
}

function describeExecutionMode(
  route: AppManifest<unknown>['routes'][number],
  state: {
    appDefinition: AppDefinition<unknown>;
    checkedRawGuardTokens: Set<Token>;
    globalFilterTokens: Token[];
    globalGuardTokens: Token[];
    globalMiddlewareTokens: Token[];
    providerScopes: Map<Token, ProviderScope>;
    rawGuardTokens: Set<Token>;
  },
): RouteInspection['executionMode'] {
  const controllerScope = state.providerScopes.get(route.controller) ?? 'singleton';
  const guardTokens = [...state.globalGuardTokens, ...route.guards];
  const middlewareTokens = [...state.globalMiddlewareTokens, ...route.middleware];
  const filterTokens = [...state.globalFilterTokens, ...route.filters];
  const hasRequestScopedDependency = controllerScope === 'request'
    || guardTokens.some((token) => (state.providerScopes.get(token) ?? 'singleton') === 'request')
    || middlewareTokens.some((token) => (state.providerScopes.get(token) ?? 'singleton') === 'request')
    || filterTokens.some((token) => (state.providerScopes.get(token) ?? 'singleton') === 'request');

  if (hasRequestScopedDependency) {
    return 'request-runtime';
  }

  const canBeNativeStatic = route.method === 'GET'
    && route.parameters.length === 0
    && route.guards.length === 0
    && route.middleware.length === 0
    && route.filters.length === 0
    && state.globalGuardTokens.length === 0
    && state.globalMiddlewareTokens.length === 0
    && state.globalFilterTokens.length === 0
    && !route.docs.bodySchema
    && !route.docs.querySchema
    && !route.docs.paramSchema
    && !route.docs.responses.some((response) => response.schema);

  if (canBeNativeStatic) {
    return 'native-static';
  }

  const requiresContextParameter = route.parameters.some((parameter) => parameter.source === 'context');
  const requiresContextGuards = guardTokens.some((token) => !tokenSupportsRawGuard(token, state));
  if (requiresContextParameter || middlewareTokens.length > 0 || filterTokens.length > 0 || requiresContextGuards) {
    return 'context-runtime';
  }

  return 'singleton-runtime';
}

function tokenSupportsRawGuard(
  token: Token,
  state: {
    appDefinition: AppDefinition<unknown>;
    checkedRawGuardTokens: Set<Token>;
    providerScopes: Map<Token, ProviderScope>;
    rawGuardTokens: Set<Token>;
  },
) {
  if (state.rawGuardTokens.has(token)) {
    return true;
  }

  if (state.checkedRawGuardTokens.has(token)) {
    return false;
  }

  state.checkedRawGuardTokens.add(token);
  if ((state.providerScopes.get(token) ?? 'singleton') !== 'singleton') {
    return false;
  }

  const instance = resolveSingletonToken<CanActivate>(state.appDefinition, token);
  if (typeof instance?.canActivateRaw === 'function') {
    state.rawGuardTokens.add(token);
    return true;
  }

  return false;
}

function describeProvider(provider: ProviderDefinition) {
  if (typeof provider === 'function') {
    return provider.name;
  }

  const scopeSuffix = provider.scope === 'request' ? ' [request]' : '';

  if ('useClass' in provider) {
    return `${describeToken(provider.provide)} -> ${provider.useClass.name}${scopeSuffix}`;
  }

  if ('useFactory' in provider) {
    return `${describeToken(provider.provide)} -> factory${scopeSuffix}`;
  }

  return `${describeToken(provider.provide)} -> value${scopeSuffix}`;
}

function describeToken(token: unknown) {
  if (typeof token === 'function') {
    return token.name;
  }

  if (typeof token === 'symbol') {
    return token.description ?? token.toString();
  }

  return String(token);
}
