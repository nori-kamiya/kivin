// A database module as apps often write it. The client is created by a DI factory (not at import),
// connects in onModuleInit and closes in onApplicationShutdown. `kivin generate` imports this file
// but must never run any of that: each step throws if it does.
import { createToken } from '@kivinjs/core';

export interface Database {
  query(sql: string): Promise<unknown[]>;
}

export const DATABASE = createToken<Database>('build-side-effects-app.database');

// Something at module top level that keeps the process alive, like a pool's keep-alive timer:
// generate must still exit once the files are written.
export const keepAlive = setInterval(() => undefined, 60_000);

export class DatabaseLifecycle {
  async onModuleInit() {
    throw new Error('onModuleInit ran during kivin generate');
  }

  async onApplicationShutdown() {
    throw new Error('onApplicationShutdown ran during kivin generate');
  }
}

export function createDatabase(): Database {
  throw new Error('the database factory ran during kivin generate');
}
