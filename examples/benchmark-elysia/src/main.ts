import { Elysia } from 'elysia';

interface UserRecord {
  id: string;
  name: string;
  email: string;
}

const users: UserRecord[] = [
  { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: '2', name: 'Grace Hopper', email: 'grace@example.com' },
];
let nextId = 3;

const variant = process.env.BENCH_VARIANT ?? 'mixed';
const port = Number(process.env.PORT ?? 3303);

function usesUsersValidation(candidate: string) {
  return candidate === 'users-validation';
}

function isCreateVariant(candidate: string) {
  return candidate === 'create'
    || candidate === 'create-no-request-id'
    || candidate === 'create-no-guard'
    || candidate === 'create-no-validation'
    || candidate === 'create-bare';
}

function usesCreateValidation(candidate: string) {
  return candidate === 'create';
}

function usesCreateGuard(candidate: string) {
  return candidate === 'create' || candidate === 'create-no-request-id' || candidate === 'create-no-validation';
}

function usesCreateRequestId(candidate: string) {
  return candidate === 'create' || candidate === 'create-no-guard' || candidate === 'create-no-validation';
}

function usesPatchValidation(candidate: string) {
  return candidate === 'patch-validation' || candidate === 'patch-validation-logger';
}

function usesPatchLogger(candidate: string) {
  return candidate === 'patch-logger' || candidate === 'patch-validation-logger';
}

function validateUsersSearch(search: string | undefined) {
  return typeof search === 'string' && search.length >= 2;
}

function validatePatchBody(body: unknown): body is { name?: string } {
  return Boolean(body) && typeof body === 'object' && !Array.isArray(body)
    && (!('name' in body) || body.name === undefined || typeof body.name === 'string');
}

function validateCreateBody(body: unknown): body is { name: string; email: string } {
  return Boolean(body) && typeof body === 'object' && !Array.isArray(body)
    && 'name' in body && typeof body.name === 'string'
    && 'email' in body && typeof body.email === 'string'
    && body.email.includes('@');
}

function logInfoDisabled(_message: string, _fields?: () => Record<string, unknown>) {
  return undefined;
}

const app = new Elysia()
  .get('/health', () => ({ ok: true }));

if (usesCreateRequestId(variant)) {
  app.onRequest(({ request, set }) => {
    set.headers['x-request-id'] = request.headers.get('x-request-id') ?? `${request.method.toLowerCase()}-${crypto.randomUUID()}`;
  });
}

if (variant === 'mixed' || variant === 'users' || variant === 'users-validation') {
  app.get('/users', ({ query }) => {
    const search = typeof query.search === 'string' ? query.search : undefined;
    if (usesUsersValidation(variant) && !validateUsersSearch(search)) {
      return new Response(JSON.stringify({ message: 'query validation failed', issues: [{ message: 'search must be a string with minLength 2' }] }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    if (!search) {
      return users;
    }

    const keyword = search.toLowerCase();
    return users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword));
  });
}

if (variant === 'mixed') {
  app.get('/users/:id', ({ params, set }) => {
    const user = users.find((candidate) => candidate.id === params.id);
    if (!user) {
      set.status = 404;
      return { message: `User ${params.id} was not found` };
    }

    return user;
  });
}

if (variant === 'mixed' || isCreateVariant(variant)) {
  app.post('/users', ({ body, headers, set }) => {
    if (usesCreateGuard(variant) && headers['x-api-key'] !== 'secret') {
      set.status = 403;
      return { message: 'Forbidden' };
    }

    if (usesCreateValidation(variant) && !validateCreateBody(body)) {
      set.status = 400;
      return { message: 'body validation failed', issues: [{ message: 'name must be a string and email must be an email-like string' }] };
    }

    const input = body && typeof body === 'object' ? body as { name?: string; email?: string } : {};
    const created = {
      id: String(nextId),
      name: typeof input.name === 'string' ? input.name : `Benchmark User ${nextId}`,
      email: typeof input.email === 'string' ? input.email : `benchmark-${nextId}@example.com`,
    };

    nextId += 1;
    users.push(created);
    set.status = 201;
    return created;
  });
}

if (variant === 'mixed' || variant === 'patch' || variant === 'patch-validation' || variant === 'patch-logger' || variant === 'patch-validation-logger') {
  app.patch('/users/:id', ({ body, headers, params, set }) => {
    if (headers['x-api-key'] !== 'secret') {
      set.status = 403;
      return { message: 'Forbidden' };
    }

    if (usesPatchValidation(variant) && !validatePatchBody(body)) {
      set.status = 400;
      return { message: 'body validation failed', issues: [{ message: 'name must be a string when provided' }] };
    }

    const user = users.find((candidate) => candidate.id === params.id);
    if (!user) {
      set.status = 404;
      return { message: `User ${params.id} was not found` };
    }

    if (usesPatchLogger(variant)) {
      logInfoDisabled('users.patch.requested', () => ({
        id: params.id,
        hasName: Boolean(body && typeof body === 'object' && 'name' in body && typeof body.name === 'string'),
      }));
    }

    if (body && typeof body === 'object' && 'name' in body && typeof body.name === 'string') {
      user.name = body.name;
    }

    return user;
  });
}

app.listen(port);

console.log(`benchmark-elysia (${variant}) listening on http://127.0.0.1:${port}`);