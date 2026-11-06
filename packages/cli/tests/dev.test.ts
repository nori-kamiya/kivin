import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCliBin, startDev, type DevEvent, type DevHandle } from '../src/dev';

const appDir = join(import.meta.dir, '.generated/dev-app');
const portFile = join(appDir, 'port.txt');
const events: DevEvent[] = [];
let dev: DevHandle | undefined;

const controllerSource = (message: string) => `import { Controller, Get } from '@kivin/decorators';

@Controller('/hello')
export class HelloController {
  @Get('/')
  hello() {
    return { message: ${JSON.stringify(message)} };
  }
}
`;

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out; events: ${JSON.stringify(events)}`);
}

async function fetchMessage() {
  const port = (await readFile(portFile, 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${port}/hello`);
  return ((await response.json()) as { message: string }).message;
}

afterAll(async () => {
  await dev?.stop();
});

describe('kivin dev', () => {
  test('regenerates and restarts on change, and keeps serving when generate fails', async () => {
    await rm(appDir, { recursive: true, force: true });
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, 'controller.ts'), controllerSource('first'));
    await writeFile(join(appDir, 'app.ts'), `import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { HelloController } from './controller';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [HelloController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
`);
    await writeFile(join(appDir, 'main.ts'), `import { createApp } from '@kivin/core';
import { writeFileSync } from 'node:fs';
import manifest from './.kivin/generated/manifest';
import appDefinition from './app';

const server = createApp(appDefinition, manifest).listen({ port: 0, hostname: '127.0.0.1' });
writeFileSync(${JSON.stringify(portFile)}, String(server.port));
`);

    dev = startDev({
      entry: join(appDir, 'app.ts'),
      outDir: join(appDir, '.kivin/generated'),
      main: join(appDir, 'main.ts'),
      onEvent: (event) => events.push(event),
    });
    await dev.ready;
    expect(await waitFor(async () => ((await fetchMessage()) === 'first' ? 'ok' : undefined))).toBe('ok');

    await rm(portFile, { force: true });
    await writeFile(join(appDir, 'controller.ts'), controllerSource('second'));
    expect(await waitFor(async () => ((await fetchMessage()) === 'second' ? 'ok' : undefined))).toBe('ok');
    expect(events.some((event) => event.type === 'change')).toBe(true);
    expect(events.filter((event) => event.type === 'started')).toHaveLength(2);

    // A broken app definition must not take the running server down.
    await writeFile(join(appDir, 'app.ts'), 'export default defineApplication(');
    await waitFor(async () => (events.some((event) => event.type === 'generate-failed') ? true : undefined));
    expect(await fetchMessage()).toBe('second');
    expect(events.filter((event) => event.type === 'started')).toHaveLength(2);
  }, 30000);
});

describe('resolveCliBin', () => {
  test('given a dist-like directory with only bin.js, when resolving, then returns bin.js', async () => {
    const dir = join(tmpdir(), `kivin-bin-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bin.js'), '');
    expect(resolveCliBin(dir)).toBe(join(dir, 'bin.js'));
    await rm(dir, { recursive: true, force: true });
  });

  test('given a src-like directory with bin.ts, when resolving, then returns bin.ts', () => {
    expect(resolveCliBin(join(import.meta.dir, '../src'))).toBe(join(import.meta.dir, '../src/bin.ts'));
  });
});

describe('kivin dev first generate failure', () => {
  test('given no server ever started, when generate fails, then the event says no server is running', async () => {
    const dir = join(tmpdir(), `kivin-dev-fail-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'app.ts'), 'export default defineApplication(');
    await writeFile(join(dir, 'main.ts'), '');
    // Let the fixture writes above drain from the OS event queue so they are not mistaken for staging noise.
    await Bun.sleep(500);
    const seen: DevEvent[] = [];
    const handle = startDev({ entry: join(dir, 'app.ts'), outDir: join(dir, 'out'), main: join(dir, 'main.ts'), onEvent: (event) => seen.push(event) });
    await handle.ready;
    await handle.stop();
    await rm(dir, { recursive: true, force: true });
    const failed = seen.find((event) => event.type === 'generate-failed');
    expect(failed && failed.type === 'generate-failed' && failed.serverRunning).toBe(false);
  }, 30000);

  test('given an outDir outside .kivin, when generating, then the staging files do not retrigger the watcher', async () => {
    const dir = join(import.meta.dir, '.generated/dev-outdir-src');
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/controller.ts'), controllerSource('only'));
    await writeFile(join(dir, 'src/app.ts'), `import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { HelloController } from './controller';

export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [HelloController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});
`);
    await writeFile(join(dir, 'src/main.ts'), 'setInterval(() => {}, 1000);\n');
    // Let the fixture writes above drain from the OS event queue so they are not mistaken for staging noise.
    await Bun.sleep(500);
    const seen: DevEvent[] = [];
    const handle = startDev({
      entry: join(dir, 'src/app.ts'),
      outDir: join(dir, 'src/generated'),
      main: join(dir, 'src/main.ts'),
      onEvent: (event) => seen.push(event),
    });
    try {
      await handle.ready;
      await Bun.sleep(1500);
      expect(seen.filter((event) => event.type === 'started')).toHaveLength(1);
      expect(seen.filter((event) => event.type === 'change')).toHaveLength(0);
    } finally {
      await handle.stop();
    }
  }, 30000);
});
