// Test helpers: build an app with providers swapped out and call it in-process.
import { createApp } from './app';
import type { AppDefinition, ModuleDefinition, ProviderDefinition } from './metadata';
import { buildManifest } from './runtime/manifest';
import type { AppManifest } from './runtime/types';

export interface TestingAppOptions<TSchema> {
  /** Generated manifest. Defaults to `buildManifest(definition)` from decorator metadata. */
  manifest?: AppManifest<TSchema>;
  /**
   * Providers that replace the app's own (matched by token), e.g.
   * `{ provide: UserRepository, useValue: fakeRepository }`.
   */
  overrides?: ProviderDefinition[];
}

/**
 * An app for tests: providers can be overridden, and `request()` calls the app in-process
 * without opening a port. `baseUrl` is only used to build absolute request URLs.
 */
export function createTestingApp<TSchema>(definition: AppDefinition<TSchema>, options: TestingAppOptions<TSchema> = {}) {
  const overrides: ModuleDefinition = {
    kind: 'module-definition',
    providers: options.overrides ?? [],
    controllers: [],
    imports: [],
  };
  // Later registrations win in the container, so the override module goes last.
  const app = createApp({ ...definition, modules: [...definition.modules, overrides] }, options.manifest ?? buildManifest(definition));

  return Object.assign(app, {
    /** `app.fetch` with a relative path; `json` is serialized with a JSON content type. */
    request(path: string, init: RequestInit & { json?: unknown } = {}) {
      const { json, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (json !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return Promise.resolve(app.fetch(new Request(new URL(path, 'http://kivin.test'), {
        ...rest,
        headers,
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      })));
    },
  });
}
