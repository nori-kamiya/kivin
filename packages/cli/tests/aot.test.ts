// Differential test: every request must produce exactly the same response with the generated AOT
// executors as with the runtime-compiled executors (manifest without `aot`).
import { createApp, type AppManifest } from '@kivin/core';
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildManifestSourceFromAst } from '../src/ast';
import { loadAppDefinition } from '../src/index';

const fixtureDir = join(import.meta.dir, 'fixtures/aot-app/src');
const outDir = join(import.meta.dir, '.generated/aot-app');

interface Case {
  name: string;
  request: () => Request;
  /** Expected status, for cases whose outcome is not otherwise obvious from the differential check. */
  status?: number;
}

const json = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => () =>
  new Request(`http://aot.test${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => () => new Request(`http://aot.test${path}`, { method, headers });

function uploadForm(title: string) {
  const form = new FormData();
  form.append('title', title);
  form.append('file', new File(['body'], 'a.txt'));
  return form;
}

const cases: Case[] = [
  { name: 'context json', request: get('/aot/context') },
  { name: 'HEAD on GET route', request: get('/aot/context', {}, 'HEAD') },
  { name: 'query schema ok', request: get('/aot/search?q=pen&page=2') },
  { name: 'query schema missing', request: get('/aot/search') },
  { name: 'query schema invalid', request: get('/aot/search?q=x') },
  { name: 'raw named query', request: get('/aot/raw-query?name=ada') },
  { name: 'raw named query missing', request: get('/aot/raw-query') },
  { name: 'whole input object (no destructuring)', request: get('/aot/whole-input?x=1') },
  { name: 'param schema found', request: get('/aot/items/1') },
  { name: 'param schema invalid', request: get('/aot/items/abc') },
  { name: 'filter handles missing', request: get('/aot/items/7') },
  { name: 'create ok (context guard)', request: json('POST', '/aot/items', { name: 'Ink', price: 3 }, { 'x-role': 'admin' }) },
  { name: 'create guard false -> 403', request: json('POST', '/aot/items', { name: 'Ink', price: 3 }, { 'x-role': 'guest' }) },
  { name: 'create guard throws 401', request: json('POST', '/aot/items', { name: 'Ink', price: 3 }, { 'x-role': 'banned' }) },
  { name: 'create invalid body', request: json('POST', '/aot/items', { name: '', price: 'x' }, { 'x-role': 'admin' }) },
  { name: 'create malformed json', request: json('POST', '/aot/items', '{"name":', { 'x-role': 'admin' }) },
  { name: 'replace ok (raw guard + 1 middleware)', request: json('PUT', '/aot/items/1', { name: 'Pen', price: 5 }) },
  { name: 'replace raw guard deny', request: json('PUT', '/aot/items/1', { name: 'Pen', price: 5 }, { 'x-key': 'deny' }) },
  { name: 'replace middleware short-circuit', request: json('PUT', '/aot/items/1', { name: 'Pen', price: 5 }, { 'x-short-circuit': '1' }) },
  { name: 'replace http error inside middleware', request: json('PUT', '/aot/items/1', { name: 'Pen', price: -1 }) },
  { name: 'replace invalid param', request: json('PUT', '/aot/items/x', { name: 'Pen', price: 5 }) },
  { name: 'patch ok (2 middleware)', request: json('PATCH', '/aot/items/1', { price: 9 }) },
  { name: 'patch missing -> filter', request: json('PATCH', '/aot/items/5', { price: 9 }) },
  { name: 'patch invalid body', request: json('PATCH', '/aot/items/1', { price: 'nine' }) },
  { name: 'delete 204', request: get('/aot/items/3', { 'x-role': 'admin' }, 'DELETE') },
  { name: 'delete thrown response', request: get('/aot/items/0', { 'x-role': 'admin' }, 'DELETE') },
  { name: 'delete guard order (raw deny first)', request: get('/aot/items/3', { 'x-key': 'deny', 'x-role': 'banned' }, 'DELETE') },
  { name: 'delete guard second fails', request: get('/aot/items/3', { 'x-role': 'guest' }, 'DELETE') },
  { name: 'boom ok', request: get('/aot/boom/none') },
  { name: 'boom HttpError', request: get('/aot/boom/http') },
  { name: 'boom thrown Response', request: get('/aot/boom/response') },
  { name: 'boom Error -> 500', request: get('/aot/boom/error') },
  { name: 'request-scoped injection', request: get('/aot/scoped') },
  { name: 'echo body without schema + cookies', request: json('POST', '/aot/echo', { a: [1, 2] }) },
  { name: 'multipart upload', status: 200, request: () => new Request('http://aot.test/aot/upload', { method: 'POST', body: uploadForm('Doc') }) },
  { name: 'multipart upload invalid', status: 400, request: () => new Request('http://aot.test/aot/upload', { method: 'POST', body: uploadForm('') }) },
  { name: 'multipart route rejects json (415)', status: 415, request: json('POST', '/aot/upload', { title: 'Doc' }) },
  { name: 'response schema violation', request: get('/aot/invalid-response') },
  { name: 'queued 204 status', request: get('/aot/no-content') },
  { name: 'method not allowed', request: get('/aot/scoped', {}, 'POST') },
  { name: 'not found', request: get('/aot/nope') },
];

async function snapshot(response: Response) {
  const headers = [...response.headers.entries()].filter(([name]) => name !== 'date').sort(([left], [right]) => left.localeCompare(right));
  return { status: response.status, headers, body: await response.text() };
}

async function loadManifest(entry: string, name: string) {
  const outFile = join(outDir, `${name}.manifest.ts`);
  const { source } = await buildManifestSourceFromAst({ entry, outFile });
  await mkdir(outDir, { recursive: true });
  await Bun.write(outFile, source);
  return { manifest: ((await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)).default as AppManifest), source };
}

function withoutAot(manifest: AppManifest): AppManifest {
  return { routes: manifest.routes.map(({ aot: _aot, ...route }) => route) };
}

function countingAot(manifest: AppManifest, bound: Set<string>): AppManifest {
  return {
    routes: manifest.routes.map((route) => route.aot
      ? {
          ...route,
          aot: (runtime) => {
            const execute = route.aot!(runtime);
            if (execute) {
              bound.add(`${route.method} ${route.fullPath}`);
            }
            return execute;
          },
        }
      : route),
  };
}

for (const variant of ['app', 'app-globals'] as const) {
  describe(`AOT executors match runtime executors (${variant})`, () => {
    let aotApp: ReturnType<typeof createApp>;
    let runtimeApp: ReturnType<typeof createApp>;
    const bound = new Set<string>();

    beforeAll(async () => {
      const entry = join(fixtureDir, `${variant}.ts`);
      const definition = await loadAppDefinition(entry);
      const { manifest, source } = await loadManifest(entry, variant);
      expect(source).toContain('aot: (rt: AotRouteRuntime<AotController>)');
      aotApp = createApp(definition, countingAot(manifest, bound));
      runtimeApp = createApp(definition, withoutAot(manifest));
    });

    test('AOT executors are bound for routes that would use the generic executor', () => {
      expect(bound.size).toBeGreaterThan(5);
    });

    for (const testCase of cases) {
      test(testCase.name, async () => {
        const fromAot = await snapshot(await aotApp.fetch(testCase.request()));
        const fromRuntime = await snapshot(await runtimeApp.fetch(testCase.request()));
        if (testCase.status !== undefined) {
          expect(fromAot.status).toBe(testCase.status);
        }
        expect(fromAot).toEqual(fromRuntime);
      });
    }
  });
}

describe('AOT generation', () => {
  test('can be turned off', async () => {
    const entry = join(fixtureDir, 'app.ts');
    const { source } = await buildManifestSourceFromAst({ entry, outFile: join(outDir, 'off.manifest.ts'), aot: false });
    expect(source).not.toContain('aot:');
  });
});
