// Compile-time checks for the generated typed client (`bun run check` regenerates it first).
// Not imported by the app; it only documents and pins down the client's types.
import { createClient, KivinClientError, type Operations } from '../.kivin/generated/client';

const client = createClient({ baseUrl: 'http://localhost:3000', headers: () => ({ 'x-api-key': 'secret' }) });

export async function typedClientUsage() {
  const users: Array<{ id: string; name: string; email: string }> = await client.users.list();
  await client.users.list({ query: { search: 'ada' } });
  const user: { id: string; name: string; email: string } = await client.users.findById({ params: { id: '1' } });
  await client.users.create({ body: { name: 'Ada', email: 'ada@example.com' } });
  await client.users.patch({ params: { id: '1' }, body: {} });
  const deleted: void = await client.users.delete({ params: { id: '1' } });
  // Header-schema routes type the header names and values; they stay optional per call because
  // they can come from createClient({ headers }).
  const me: { id: string; name: string; email: string } = await client.users.me({ headers: { 'x-user-id': '1' } });
  await client.users.me();
  await client.users.list({ query: { search: 'ada' }, headers: [['x-trace', '1']] });

  // @ts-expect-error path params are required
  await client.users.findById();
  // @ts-expect-error the body must match the create schema input
  await client.users.create({ body: { name: 'Ada' } });
  // @ts-expect-error unknown query field
  await client.users.list({ query: { q: 'ada' } });
  // @ts-expect-error header values must match the header schema input (string)
  await client.users.me({ headers: { 'x-user-id': 1 } });

  try {
    await client.users.findById({ params: { id: '404' } });
  } catch (error) {
    if (error instanceof KivinClientError && error.status === 404) {
      return { users, user, deleted, me };
    }
    throw error;
  }
  return { users, user, deleted, me };
}

export type CreateOperation = Operations['users.create'];
