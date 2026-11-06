import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateArtifacts, inspectRoutes } from '../src/index';

const root = join(import.meta.dir, '.generated/module-factory');

const controllerSource = `import { Controller, Get } from '@kivin/decorators';

@Controller('/ping')
export class PingController {
  @Get('/')
  ping() {
    return { ok: true };
  }
}
`;

const factorySource = `import { defineModule } from '@kivin/core';
import { PingController } from './controller';

export function createPingModule() {
  return defineModule({ providers: [], controllers: [PingController], imports: [] });
}
`;

async function makeApp(name: string, appBody: string) {
  const dir = join(root, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'controller.ts'), controllerSource);
  await writeFile(join(dir, 'factory.ts'), factorySource);
  await writeFile(join(dir, 'app.ts'), `import { defineApplication, defineModule } from '@kivin/core';
import { createLoggerModule } from '@kivin/logger';
import { createValibotAdapter } from '@kivin/valibot';
import { PingController } from './controller';
import { createPingModule } from './factory';

${appBody}
`);
  return { entry: join(dir, 'app.ts'), outDir: join(dir, 'out') };
}

describe('module factory calls', () => {
  test('given createLoggerModule() inline in imports, when generating, then routes are kept', async () => {
    const app = await makeApp('inline-import', `export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [PingController], imports: [createLoggerModule()] })],
  schemaAdapter: createValibotAdapter(),
});`);
    await generateArtifacts(app);
    expect(await readFile(join(app.outDir, 'manifest.ts'), 'utf8')).toContain('/ping');
  });

  test('given a const-bound createLoggerModule() as an application module, when generating, then it is accepted', async () => {
    const app = await makeApp('const-app-module', `const loggerModule = createLoggerModule();
export default defineApplication({
  modules: [loggerModule, defineModule({ providers: [], controllers: [PingController], imports: [] })],
  schemaAdapter: createValibotAdapter(),
});`);
    await generateArtifacts(app);
    expect(await readFile(join(app.outDir, 'manifest.ts'), 'utf8')).toContain('/ping');
  });

  test('given a const-bound factory call in imports, when generating, then it is accepted', async () => {
    const app = await makeApp('const-import', `const loggerModule = createLoggerModule();
export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [PingController], imports: [loggerModule] })],
  schemaAdapter: createValibotAdapter(),
});`);
    await generateArtifacts(app);
    expect(await readFile(join(app.outDir, 'manifest.ts'), 'utf8')).toContain('/ping');
  });

  test('given a factory call whose module declares controllers, when generating, then it fails telling to use @Module or defineModule', async () => {
    const app = await makeApp('opaque-controllers', `export default defineApplication({
  modules: [createPingModule()],
  schemaAdapter: createValibotAdapter(),
});`);
    await expect(generateArtifacts(app)).rejects.toThrow(/createPingModule\(\).*@Module or defineModule/s);
    await expect(readFile(join(app.outDir, 'manifest.ts'), 'utf8')).rejects.toThrow();
  });

  test('given a const-bound factory call declaring controllers, when inspecting routes, then it fails the same way', async () => {
    const app = await makeApp('opaque-inspect', `const pingModule = createPingModule();
export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [], imports: [pingModule] })],
  schemaAdapter: createValibotAdapter(),
});`);
    await expect(inspectRoutes({ entry: app.entry })).rejects.toThrow(/@Module or defineModule/);
  });

  test('given a factory-declared controller sharing its class name with a statically read one, when generating, then it fails', async () => {
    const app = await makeApp('same-name', `export default defineApplication({
  modules: [defineModule({ providers: [], controllers: [PingController], imports: [createOtherModule()] })],
  schemaAdapter: createValibotAdapter(),
});`);
    const dir = join(root, 'same-name');
    await mkdir(join(dir, 'other'), { recursive: true });
    await writeFile(join(dir, 'other/controller.ts'), controllerSource.replace('/ping', '/other'));
    await writeFile(join(dir, 'other/module.ts'), `import { defineModule } from '@kivin/core';
import { PingController } from './controller';

export function createOtherModule() {
  return defineModule({ providers: [], controllers: [PingController], imports: [] });
}
`);
    const appSource = await readFile(app.entry, 'utf8');
    await writeFile(app.entry, `import { createOtherModule } from './other/module';\n${appSource}`);
    await expect(generateArtifacts(app)).rejects.toThrow(/createOtherModule\(\).*PingController/s);
  });
});
