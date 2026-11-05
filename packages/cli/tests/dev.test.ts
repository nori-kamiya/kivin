import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDev, type DevEvent, type DevHandle } from '../src/dev';

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
