import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDev, type DevEvent } from '../src/dev';

const controllerSource = `import { Controller, Get } from '@kivin/decorators';

@Controller('/hello')
export class HelloController {
  @Get('/')
  hello() {
    return { message: 'idle' };
  }
}
`;

const appSource = `import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { HelloController } from './controller';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [HelloController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
`;

async function writeIdleApp(name: string) {
  const dir = join(import.meta.dir, '.generated', name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/controller.ts'), controllerSource);
  await writeFile(join(dir, 'src/app.ts'), appSource);
  await writeFile(join(dir, 'src/main.ts'), 'setInterval(() => {}, 1000);\n');
  // Let the fixture writes above drain from the OS event queue so they are not mistaken for changes.
  await Bun.sleep(500);
  return dir;
}

async function waitUntil(seen: DevEvent[], type: DevEvent['type'], timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (seen.some((event) => event.type === type)) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${type}; events: ${JSON.stringify(seen)}`);
}

describe('kivin dev watch roots', () => {
  test('given a --watch directory that does not exist, when starting, then it throws before generating or spawning anything', async () => {
    const dir = await writeIdleApp('dev-missing-watch');
    const seen: DevEvent[] = [];
    try {
      expect(() => startDev({
        entry: join(dir, 'src/app.ts'),
        outDir: join(dir, 'src/generated'),
        main: join(dir, 'src/main.ts'),
        watch: [join(dir, 'does-not-exist')],
        onEvent: (event) => seen.push(event),
      })).toThrow(/does-not-exist/);
      await Bun.sleep(1000);
      expect(seen).toEqual([]);
      expect(existsSync(join(dir, 'src/generated'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('kivin dev server death', () => {
  test('given the server was killed by a signal, when generate then fails, then serverRunning is false', async () => {
    const dir = await writeIdleApp('dev-sigkill');
    const seen: DevEvent[] = [];
    const handle = startDev({
      entry: join(dir, 'src/app.ts'),
      outDir: join(dir, 'src/generated'),
      main: join(dir, 'src/main.ts'),
      onEvent: (event) => seen.push(event),
    });
    try {
      await handle.ready;
      const started = seen.find((event): event is Extract<DevEvent, { type: 'started' }> => event.type === 'started');
      expect(started).toBeDefined();
      process.kill(started!.pid, 'SIGKILL');
      await waitUntil(seen, 'exited');
      await writeFile(join(dir, 'src/app.ts'), 'export default defineApplication(');
      await waitUntil(seen, 'generate-failed');
      const failed = seen.find((event) => event.type === 'generate-failed');
      expect(failed && failed.type === 'generate-failed' && failed.serverRunning).toBe(false);
    } finally {
      await handle.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('kivin dev inspect staging', () => {
  test('given kivin inspect stages a manifest under a watched directory, when the file is written, then no restart is triggered', async () => {
    const dir = await writeIdleApp('dev-inspect-staging');
    const seen: DevEvent[] = [];
    const handle = startDev({
      entry: join(dir, 'src/app.ts'),
      outDir: join(dir, 'src/generated'),
      main: join(dir, 'src/main.ts'),
      onEvent: (event) => seen.push(event),
    });
    try {
      await handle.ready;
      await Bun.sleep(1000);
      await mkdir(join(dir, 'src/.kivin-inspect-AbC123'), { recursive: true });
      await writeFile(join(dir, 'src/.kivin-inspect-AbC123/manifest.ts'), 'export default {};\n');
      await Bun.sleep(1000);
      expect(seen.filter((event) => event.type === 'change')).toHaveLength(0);
      expect(seen.filter((event) => event.type === 'started')).toHaveLength(1);
    } finally {
      await handle.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
