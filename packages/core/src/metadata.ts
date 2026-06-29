import type { Constructor, HttpMethod, Token } from './types';

export interface InjectableMetadata {
  deps: Token[];
}

export interface ModuleDecoratorMetadata {
  providers?: ProviderDefinition[];
  controllers?: Constructor[];
  imports?: ModuleLike[];
}

export interface ControllerMetadata {
  basePath: string;
  tags: string[];
  guards: Token[];
  middleware: Token[];
  filters: Token[];
}

export interface RouteResponseMetadata {
  status: number;
  description: string;
  schema?: unknown;
}

export interface RouteDocsMetadata {
  summary?: string;
  description?: string;
  operationId?: string;
  tags: string[];
  bodySchema?: unknown;
  querySchema?: unknown;
  paramSchema?: unknown;
  security: RouteSecurityRequirement[];
  responses: RouteResponseMetadata[];
}

export interface RouteSecurityRequirement {
  scheme: string;
  scopes: string[];
}

export interface RouteMetadata {
  method: HttpMethod;
  path: string;
}

export interface RouteEnhancerMetadata {
  guards: Token[];
  middleware: Token[];
  filters: Token[];
}

export type ParameterSource = 'context' | 'path' | 'query' | 'body';

export interface ParameterMetadata {
  index: number;
  source: ParameterSource;
  name?: string;
}

export type ProviderScope = 'singleton' | 'request';

export interface ClassProvider<T = unknown> {
  provide: Token<T>;
  scope?: ProviderScope;
  useClass: Constructor<T>;
}

export interface FactoryProvider<T = unknown> {
  provide: Token<T>;
  scope?: ProviderScope;
  useFactory: (container: ContainerLike) => T;
}

export interface ValueProvider<T = unknown> {
  provide: Token<T>;
  scope?: ProviderScope;
  useValue: T;
}

export type ProviderDefinition<T = unknown> = Constructor<T> | ClassProvider<T> | FactoryProvider<T> | ValueProvider<T>;

export interface ModuleDefinition {
  kind: 'module-definition';
  providers: ProviderDefinition[];
  controllers: Constructor[];
  imports: ModuleLike[];
}

export type ModuleLike = ModuleDefinition | Constructor;

export interface AppDefinition<TSchema = unknown> {
  modules: ModuleLike[];
  schemaAdapter: import('./types').SchemaAdapter<TSchema>;
  globals?: AppEnhancerMetadata;
  openApi?: AppOpenApiConfig;
}

export interface AppOpenApiConfig {
  tags?: Array<{ name: string; description?: string }>;
  servers?: Array<{ url: string; description?: string }>;
  contact?: {
    name?: string;
    url?: string;
    email?: string;
  };
  license?: {
    name: string;
    identifier?: string;
    url?: string;
  };
  security?: RouteSecurityRequirement[];
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
  examples?: Record<string, OpenApiExample>;
}

export interface OpenApiSecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  description?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
  flows?: Record<string, unknown>;
}

export interface OpenApiExample {
  summary?: string;
  description?: string;
  value?: unknown;
  externalValue?: string;
}

export interface AppEnhancerMetadata {
  guards: Token[];
  middleware: Token[];
  filters: Token[];
}

export interface RouteDescriptor {
  methodName: string;
  route: RouteMetadata;
  docs: RouteDocsMetadata;
  parameters: ParameterMetadata[];
  enhancers: RouteEnhancerMetadata;
}

export interface ContainerLike {
  resolve<T>(token: Token<T>): T;
}

const injectableMetadataStore = new WeakMap<Function, InjectableMetadata>();
const moduleMetadataStore = new WeakMap<Function, ModuleDecoratorMetadata>();
const controllerMetadataStore = new WeakMap<Function, ControllerMetadata>();
const routeMetadataStore = new WeakMap<object, Map<string | symbol, RouteMetadata>>();
const routeDocsStore = new WeakMap<object, Map<string | symbol, RouteDocsMetadata>>();
const routeParameterStore = new WeakMap<object, Map<string | symbol, ParameterMetadata[]>>();
const routeEnhancerStore = new WeakMap<object, Map<string | symbol, RouteEnhancerMetadata>>();

function getOrCreateMap<T>(store: WeakMap<object, Map<string | symbol, T>>, target: object) {
  let current = store.get(target);
  if (!current) {
    current = new Map<string | symbol, T>();
    store.set(target, current);
  }
  return current;
}

export function setInjectableMetadata(target: Function, metadata: InjectableMetadata) {
  injectableMetadataStore.set(target, metadata);
}

export function getInjectableMetadata(target: Function): InjectableMetadata {
  return injectableMetadataStore.get(target) ?? { deps: [] };
}

export function setModuleDecoratorMetadata(target: Function, metadata: ModuleDecoratorMetadata) {
  moduleMetadataStore.set(target, metadata);
}

export function getModuleDecoratorMetadata(target: Function): ModuleDecoratorMetadata | undefined {
  return moduleMetadataStore.get(target);
}

export function setControllerMetadata(target: Function, metadata: ControllerMetadata) {
  const existing = controllerMetadataStore.get(target);
  controllerMetadataStore.set(target, {
    basePath: metadata.basePath,
    tags: [...new Set([...(existing?.tags ?? []), ...metadata.tags])],
    guards: [...new Set([...(existing?.guards ?? []), ...metadata.guards])],
    middleware: [...new Set([...(existing?.middleware ?? []), ...metadata.middleware])],
    filters: [...new Set([...(existing?.filters ?? []), ...metadata.filters])],
  });
}

export function getControllerMetadata(target: Function): ControllerMetadata | undefined {
  return controllerMetadataStore.get(target);
}

export function setRouteMetadata(target: object, propertyKey: string | symbol, metadata: RouteMetadata) {
  getOrCreateMap(routeMetadataStore, target).set(propertyKey, metadata);
}

export function appendControllerTag(target: Function, tag: string) {
  const existing = getControllerMetadata(target) ?? getDefaultControllerMetadata();
  setControllerMetadata(target, {
    basePath: existing.basePath,
    tags: [...existing.tags, tag],
    guards: existing.guards,
    middleware: existing.middleware,
    filters: existing.filters,
  });
}

export function appendControllerEnhancers(target: Function, kind: keyof RouteEnhancerMetadata, tokens: Token[]) {
  const existing = getControllerMetadata(target) ?? getDefaultControllerMetadata();
  setControllerMetadata(target, {
    basePath: existing.basePath,
    tags: existing.tags,
    guards: kind === 'guards' ? [...existing.guards, ...tokens] : existing.guards,
    middleware: kind === 'middleware' ? [...existing.middleware, ...tokens] : existing.middleware,
    filters: kind === 'filters' ? [...existing.filters, ...tokens] : existing.filters,
  });
}

export function updateRouteDocs(
  target: object,
  propertyKey: string | symbol,
  updater: (current: RouteDocsMetadata) => RouteDocsMetadata,
) {
  const docsMap = getOrCreateMap(routeDocsStore, target);
  const current = docsMap.get(propertyKey) ?? { tags: [], responses: [], security: [] };
  docsMap.set(propertyKey, updater(current));
}

export function appendRouteParameter(target: object, propertyKey: string | symbol, metadata: ParameterMetadata) {
  const parameterMap = getOrCreateMap(routeParameterStore, target);
  const current = parameterMap.get(propertyKey) ?? [];
  parameterMap.set(propertyKey, [...current, metadata].sort((left, right) => left.index - right.index));
}

export function updateRouteEnhancers(
  target: object,
  propertyKey: string | symbol,
  updater: (current: RouteEnhancerMetadata) => RouteEnhancerMetadata,
) {
  const enhancerMap = getOrCreateMap(routeEnhancerStore, target);
  const current = enhancerMap.get(propertyKey) ?? getDefaultRouteEnhancers();
  enhancerMap.set(propertyKey, updater(current));
}

export function getRouteDescriptors(controller: Constructor): RouteDescriptor[] {
  const prototype = controller.prototype;
  const routeMap = routeMetadataStore.get(prototype) ?? new Map<string | symbol, RouteMetadata>();
  const docsMap = routeDocsStore.get(prototype) ?? new Map<string | symbol, RouteDocsMetadata>();
  const parameterMap = routeParameterStore.get(prototype) ?? new Map<string | symbol, ParameterMetadata[]>();
  const enhancerMap = routeEnhancerStore.get(prototype) ?? new Map<string | symbol, RouteEnhancerMetadata>();

  return [...routeMap.entries()].map(([propertyKey, route]) => ({
    methodName: String(propertyKey),
    route,
    docs: docsMap.get(propertyKey) ?? { tags: [], responses: [], security: [] },
    parameters: parameterMap.get(propertyKey) ?? [],
    enhancers: enhancerMap.get(propertyKey) ?? getDefaultRouteEnhancers(),
  }));
}

function getDefaultControllerMetadata(): ControllerMetadata {
  return {
    basePath: '',
    tags: [],
    guards: [],
    middleware: [],
    filters: [],
  };
}

function getDefaultRouteEnhancers(): RouteEnhancerMetadata {
  return {
    guards: [],
    middleware: [],
    filters: [],
  };
}
