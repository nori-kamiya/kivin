import { createApp, createTestingApp, defineApplication, defineModule, setInjectableMetadata, type AppManifest, type RequestContext } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { describe, expect, test } from 'bun:test';

function build(log: string[], options: { failOnce?: boolean } = {}) {
  let failures = options.failOnce ? 1 : 0;

  class Database {
    connected = false;
    async onModuleInit() {
      await Bun.sleep(1);
      if (failures > 0) {
        failures -= 1;
        throw new Error('connect failed');
      }
      this.connected = true;
      log.push('db:init');
    }
    onApplicationBootstrap() {
      log.push('db:bootstrap');
    }
  }

  class Repo {
    constructor(readonly db: Database) {}
    onModuleInit() {
      log.push(`repo:init(db connected=${this.db.connected})`);
    }
  }
  setInjectableMetadata(Repo, { deps: [Database] });

  // Not used by any route: still initialised.
  class Warmup {
    onApplicationBootstrap() {
      log.push('warmup:bootstrap');
    }
  }

  const CACHE = Symbol.for('test.cache');
  const cache = { onModuleInit: () => void log.push('cache:init') };
  const FACTORY = Symbol.for('test.factory');

  class StatusController {
    constructor(readonly repo: Repo) {}
    status(_input: { context: RequestContext }) {
      return { connected: this.repo.db.connected };
    }
  }
  setInjectableMetadata(StatusController, { deps: [Repo] });

  const manifest: AppManifest = {
    routes: [{
      method: 'GET', fullPath: '/status', controller: StatusController, methodName: 'status',
      parameters: [{ index: 0, source: 'input', fields: ['context'] }], guards: [], middleware: [], filters: [],
      docs: { tags: [], security: [], responses: [] },
    }],
  };
  const definition = defineApplication({
    modules: [defineModule({
      providers: [Database, Repo, Warmup, { provide: CACHE, useValue: cache }, { provide: FACTORY, useFactory: () => ({ onModuleInit: () => void log.push('factory:init') }) }],
      controllers: [StatusController],
      imports: [],
    })],
    schemaAdapter: createValibotAdapter(),
  });
  return { definition, manifest };
}

describe('startup lifecycle hooks', () => {
  test('init runs onModuleInit (dependencies first, awaited) then onApplicationBootstrap, for every singleton', async () => {
    const log: string[] = [];
    const { definition, manifest } = build(log);
    const app = createApp(definition, manifest);
    await app.init();
    expect(log.slice(0, 4).sort()).toEqual(['cache:init', 'db:init', 'factory:init', 'repo:init(db connected=true)'].sort());
    expect(log.indexOf('db:init')).toBeLessThan(log.indexOf('repo:init(db connected=true)'));
    expect(log.slice(4).sort()).toEqual(['db:bootstrap', 'warmup:bootstrap']);
    expect(await (await app.fetch(new Request('http://x/status'))).json()).toEqual({ connected: true });

    await app.init();
    expect(log).toHaveLength(6);
  });

  test('listen refuses to start while hooks are pending, and starts after init', async () => {
    const log: string[] = [];
    const { definition, manifest } = build(log);
    const app = createApp(definition, manifest);
    expect(() => app.listen({ port: 0 })).toThrow(/await app\.init\(\)/);
    expect(log).toEqual([]);
    await app.init();
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      expect(await (await fetch(`http://127.0.0.1:${server.port}/status`)).json()).toEqual({ connected: true });
    } finally {
      await app.close();
    }
  });

  test('apps without hooks listen without init', async () => {
    class Plain {
      ping() {
        return 'pong';
      }
    }
    const app = createApp(defineApplication({
      modules: [defineModule({ providers: [], controllers: [Plain], imports: [] })],
      schemaAdapter: createValibotAdapter(),
    }), { routes: [{ method: 'GET', fullPath: '/ping', controller: Plain, methodName: 'ping', parameters: [], guards: [], middleware: [], filters: [], docs: { tags: [], security: [], responses: [] } }] });
    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      expect(await (await fetch(`http://127.0.0.1:${server.port}/ping`)).json()).toBe('pong');
    } finally {
      await app.close();
    }
  });

  test('a failing hook rejects init, which can be retried', async () => {
    const log: string[] = [];
    const { definition, manifest } = build(log, { failOnce: true });
    const app = createApp(definition, manifest);
    await expect(app.init()).rejects.toThrow('connect failed');
    expect(() => app.listen({ port: 0 })).toThrow(/await app\.init\(\)/);
    await app.init();
    expect(log).toContain('db:init');
  });

  test('createTestingApp().request runs init before the first request', async () => {
    const log: string[] = [];
    const { definition, manifest } = build(log);
    const app = createTestingApp(definition, { manifest });
    expect(await (await app.request('/status')).json()).toEqual({ connected: true });
    expect(log).toContain('warmup:bootstrap');
  });
});
