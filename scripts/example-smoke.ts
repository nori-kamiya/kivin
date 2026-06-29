import { resolve } from 'node:path';

const binaryPath = resolve(import.meta.dir, '../examples/basic/bin/basic-app');
const port = 3100 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;

const processHandle = Bun.spawn([binaryPath], {
  env: {
    ...process.env,
    PORT: String(port),
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

try {
  await waitForServer(`${baseUrl}/users/`);

  const listResponse = await fetch(`${baseUrl}/users/?search=Ada`, {
    headers: { 'x-request-id': 'smoke-list' },
  });
  assert(listResponse.status === 200, `GET /users/ returned ${listResponse.status}`);
  assert(listResponse.headers.get('x-request-id') === 'smoke-list', 'GET /users/ did not preserve x-request-id');
  const users = await listResponse.json();
  assert(Array.isArray(users), 'GET /users/ did not return an array');
  assert(users.length === 1, `GET /users/ expected 1 user, received ${users.length}`);

  const headResponse = await fetch(`${baseUrl}/users/`, {
    method: 'HEAD',
    headers: { 'x-request-id': 'smoke-head' },
  });
  assert(headResponse.status === 200, `HEAD /users/ returned ${headResponse.status}`);
  assert(headResponse.headers.get('x-request-id') === 'smoke-head', 'HEAD /users/ did not preserve x-request-id');
  assert((await headResponse.text()) === '', 'HEAD /users/ returned a response body');

  const optionsResponse = await fetch(`${baseUrl}/users/`, {
    method: 'OPTIONS',
  });
  assert(optionsResponse.status === 204, `OPTIONS /users/ returned ${optionsResponse.status}`);
  assert(optionsResponse.headers.get('allow') === 'GET, HEAD, POST, OPTIONS', `Unexpected Allow header: ${optionsResponse.headers.get('allow')}`);

  const replaceResponse = await fetch(`${baseUrl}/users/1`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'secret',
      'x-request-id': 'smoke-put',
    },
    body: JSON.stringify({ name: 'Ada Byron', email: 'ada.byron@example.com' }),
  });
  assert(replaceResponse.status === 200, `PUT /users/1 returned ${replaceResponse.status}`);
  const replacedUser = await replaceResponse.json() as { name?: string; email?: string };
  assert(replacedUser.name === 'Ada Byron', 'PUT /users/1 did not replace the user name');
  assert(replacedUser.email === 'ada.byron@example.com', 'PUT /users/1 did not replace the user email');

  const patchResponse = await fetch(`${baseUrl}/users/1`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'secret',
      'x-request-id': 'smoke-patch',
    },
    body: JSON.stringify({ name: 'Ada Lovelace' }),
  });
  assert(patchResponse.status === 200, `PATCH /users/1 returned ${patchResponse.status}`);
  const patchedUser = await patchResponse.json() as { name?: string };
  assert(patchedUser.name === 'Ada Lovelace', 'PATCH /users/1 did not patch the user name');

  const conflictResponse = await fetch(`${baseUrl}/users/1`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'secret',
    },
    body: JSON.stringify({ email: 'grace@example.com' }),
  });
  assert(conflictResponse.status === 409, `PATCH /users/1 conflict returned ${conflictResponse.status}`);

  const deleteResponse = await fetch(`${baseUrl}/users/2`, {
    method: 'DELETE',
    headers: {
      'x-api-key': 'secret',
      'x-request-id': 'smoke-delete',
    },
  });
  assert(deleteResponse.status === 204, `DELETE /users/2 returned ${deleteResponse.status}`);
  assert((await deleteResponse.text()) === '', 'DELETE /users/2 returned a response body');

  const deletedLookupResponse = await fetch(`${baseUrl}/users/2`);
  assert(deletedLookupResponse.status === 404, `GET /users/2 after delete returned ${deletedLookupResponse.status}`);

  const openApiResponse = await fetch(`${baseUrl}/openapi.json`);
  assert(openApiResponse.status === 200, `/openapi.json returned ${openApiResponse.status}`);
  const openApiDocument = await openApiResponse.json() as { openapi?: string };
  assert(openApiDocument.openapi === '3.1.0', 'OpenAPI document did not expose version 3.1.0');

  console.log(`example smoke passed on ${baseUrl}`);
} catch (error) {
  const stdout = await streamToText(processHandle.stdout);
  const stderr = await streamToText(processHandle.stderr);
  if (stdout) {
    console.error(stdout);
  }
  if (stderr) {
    console.error(stderr);
  }
  throw error;
} finally {
  processHandle.kill();
  await processHandle.exited;
}

async function waitForServer(url: string) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the process starts listening.
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function streamToText(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) {
    return '';
  }

  return new Response(stream).text();
}