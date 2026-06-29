import {
    getModuleDecoratorMetadata,
    type AppDefinition,
    type ModuleDefinition,
    type ModuleLike,
} from './metadata';
import type { SchemaAdapter } from './types';

export function defineModule(input: Omit<ModuleDefinition, 'kind'>): ModuleDefinition {
  return {
    kind: 'module-definition',
    providers: input.providers,
    controllers: input.controllers,
    imports: input.imports,
  };
}

export function defineApplication<TSchema>(input: {
  modules: ModuleLike[];
  schemaAdapter: SchemaAdapter<TSchema>;
  globals?: AppDefinition<TSchema>['globals'];
  openApi?: AppDefinition<TSchema>['openApi'];
}): AppDefinition<TSchema> {
  return {
    modules: input.modules,
    schemaAdapter: input.schemaAdapter,
    globals: input.globals ?? { guards: [], middleware: [], filters: [] },
    ...(input.openApi ? { openApi: input.openApi } : {}),
  };
}

export function normalizeModule(moduleLike: ModuleLike): ModuleDefinition {
  if (typeof moduleLike !== 'function') {
    return moduleLike;
  }

  const metadata = getModuleDecoratorMetadata(moduleLike);
  if (!metadata) {
    throw new Error(`Module metadata is missing for ${moduleLike.name}`);
  }

  return defineModule({
    providers: metadata.providers ?? [],
    controllers: metadata.controllers ?? [],
    imports: metadata.imports ?? [],
  });
}

export function flattenModules(modules: ModuleLike[]): ModuleDefinition[] {
  const normalized = modules.map(normalizeModule);
  const result: ModuleDefinition[] = [];

  for (const moduleDefinition of normalized) {
    result.push(moduleDefinition, ...flattenModules(moduleDefinition.imports));
  }

  return result;
}
