import { createApp } from '@kivin/core';
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateArtifacts, loadAppDefinition } from '../src/index';

const testsDir = import.meta.dir;
const repoRoot = resolve(testsDir, '../../..');
const exampleApp = join(repoRoot, 'examples/basic/src/app.ts');
const outDir = join(testsDir, '.generated/client-example');

type ClientModule = typeof import('../../../examples/basic/.kivin/generated/client');
let clientModule: ClientModule;
let client: ReturnType<ClientModule['createClient']>;
const seenRequests: Request[] = [];

beforeAll(async () => {
  const result = await generateArtifacts({ entry: exampleApp, outDir });
  const manifest = (await import(`${pathToFileURL(result.manifestPath).href}?t=${Date.now()}`)).default;
  clientModule = await import(`${pathToFileURL(result.clientPath).href}?t=${Date.now()}`);
  const app = createApp(await loadAppDefinition(exampleApp), manifest);
  client = clientModule.createClient({
    baseUrl: 'http://example.test/',
    headers: () => ({ 'x-api-key': 'secret' }),
    fetch: (request) => {
      seenRequests.push(request.clone());
      return app.fetch(request);
    },
  });
});

describe('generated client', () => {
  test('only imports types from server code', async () => {
    const source = await readFile(join(outDir, 'client.ts'), 'utf8');
    const importLines = source.split('\n').filter((line) => line.startsWith('import '));
    expect(importLines.length).toBeGreaterThan(0);
    expect(importLines.every((line) => line.startsWith('import type '))).toBe(true);
  });

  test('header-schema routes send the typed headers', async () => {
    expect(await client.users.me({ headers: { 'x-user-id': '1' } })).toMatchObject({ id: '1' });
    expect(seenRequests.at(-1)!.headers.get('x-user-id')).toBe('1');
    const missing = await client.users.me().catch((error: unknown) => error);
    expect((missing as { status: number }).status).toBe(400);
  });

  test('multipart routes send FormData with files', async () => {
    const avatar = new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' });
    const stored = await client.users.uploadAvatar({ params: { id: '1' }, body: { avatar, alt: 'me' } });
    expect(stored).toEqual({ userId: '1', filename: 'me.png', type: 'image/png', size: 4, alt: 'me' });
    expect(seenRequests.at(-1)!.headers.get('content-type')).toStartWith('multipart/form-data; boundary=');
  });

  test('calls routes with query, params and body and returns parsed JSON', async () => {
    const users = await client.users.list({ query: { search: 'ada' } });
    expect(users.map((user) => user.name)).toEqual(['Ada Lovelace']);
    expect(new URL(seenRequests.at(-1)!.url).search).toBe('?search=ada');

    const created = await client.users.create({ body: { name: 'Alan Turing', email: 'alan@example.com' } });
    expect(created).toMatchObject({ name: 'Alan Turing', email: 'alan@example.com' });
    expect(seenRequests.at(-1)!.headers.get('content-type')).toBe('application/json');
    expect(seenRequests.at(-1)!.headers.get('x-api-key')).toBe('secret');

    const fetched = await client.users.findById({ params: { id: created.id } });
    expect(fetched.email).toBe('alan@example.com');

    const patched = await client.users.patch({ params: { id: created.id }, body: { name: 'A. Turing' } });
    expect(patched.name).toBe('A. Turing');
  });

  test('returns undefined for 204 responses', async () => {
    const created = await client.users.create({ body: { name: 'To Delete', email: 'delete-me@example.com' } });
    await expect(client.users.delete({ params: { id: created.id } })).resolves.toBeUndefined();
  });

  test('throws KivinClientError with the parsed body for non-2xx responses', async () => {
    const error = await client.users.findById({ params: { id: '999' } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(clientModule.KivinClientError);
    expect((error as InstanceType<ClientModule['KivinClientError']>).status).toBe(404);
    expect((error as InstanceType<ClientModule['KivinClientError']>).body).toMatchObject({ message: expect.any(String) });
  });

  test('encodes path parameters and rejects missing ones', async () => {
    await client.users.findById({ params: { id: 'a/b' } }).catch(() => undefined);
    expect(new URL(seenRequests.at(-1)!.url).pathname).toBe('/users/a%2Fb');
    await expect(client.users.findById({ params: {} as { id: string } })).rejects.toThrow('Missing path parameter "id"');
  });
});
