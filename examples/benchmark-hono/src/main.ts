import { Hono } from 'hono';

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

const app = new Hono();
const variant = process.env.BENCH_VARIANT ?? 'mixed';

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
  if (!search || search.length < 2) {
    return { success: false as const, issues: [{ message: 'search must be a string with minLength 2' }] };
  }

  return { success: true as const, output: search };
}

function validateUserId(id: string | undefined) {
  if (!id) {
    return { success: false as const, issues: [{ message: 'id must be a string' }] };
  }

  return { success: true as const, output: id };
}

function validatePatchBody(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { success: false as const, issues: [{ message: 'body must be an object' }] };
  }

  const name = (input as { name?: unknown }).name;
  if (name !== undefined && typeof name !== 'string') {
    return { success: false as const, issues: [{ message: 'name must be a string when provided' }] };
  }

  return { success: true as const, output: input as { name?: string } };
}

function validateCreateBody(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { success: false as const, issues: [{ message: 'body must be an object' }] };
  }

  const { email, name } = input as { email?: unknown; name?: unknown };
  if (typeof name !== 'string' || typeof email !== 'string' || !email.includes('@')) {
    return { success: false as const, issues: [{ message: 'name must be a string and email must be an email-like string' }] };
  }

  return { success: true as const, output: input as { name: string; email: string } };
}

function logInfoDisabled(_message: string, _fields?: () => Record<string, unknown>) {
  return undefined;
}

if (usesCreateRequestId(variant)) {
  app.use('*', async (context, next) => {
    const requestId = context.req.header('x-request-id') ?? `${context.req.method.toLowerCase()}-${crypto.randomUUID()}`;
    await next();
    context.header('x-request-id', requestId);
  });
}

app.get('/health', (context) => context.json({ ok: true }));

if (variant === 'mixed' || variant === 'users' || variant === 'users-validation') {
  app.get('/users', (context) => {
    const search = context.req.query('search');
    if (usesUsersValidation(variant)) {
      const parsedSearch = validateUsersSearch(search);
      if (!parsedSearch.success) {
        return context.json({ message: 'query validation failed', issues: parsedSearch.issues }, 400);
      }

      const keyword = parsedSearch.output.toLowerCase();
      return context.json(users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword)));
    }

    if (!search) {
      return context.json(users);
    }

    const keyword = search.toLowerCase();
    return context.json(users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword)));
  });
}

if (variant === 'mixed') {
  app.get('/users/:id', (context) => {
    const user = users.find((candidate) => candidate.id === context.req.param('id'));
    if (!user) {
      return context.json({ message: `User ${context.req.param('id')} was not found` }, 404);
    }
    return context.json(user);
  });
}

if (variant === 'mixed' || isCreateVariant(variant)) {
  app.post('/users', async (context) => {
    if (usesCreateGuard(variant) && context.req.header('x-api-key') !== 'secret') {
      return context.json({ message: 'Forbidden' }, 403);
    }

    const requestBody = await context.req.json<{ name?: string; email?: string }>();
    let body: { name: string; email: string } | { name?: string; email?: string } = requestBody;

    if (usesCreateValidation(variant)) {
      const parsedBody = validateCreateBody(requestBody);
      if (!parsedBody.success) {
        return context.json({ message: 'body validation failed', issues: parsedBody.issues }, 400);
      }

      body = parsedBody.output;
    }

    const created = {
      id: String(nextId),
      name: typeof body.name === 'string' ? body.name : `Benchmark User ${nextId}`,
      email: typeof body.email === 'string' ? body.email : `benchmark-${nextId}@example.com`,
    };

    nextId += 1;
    users.push(created);
    return context.json(created, 201);
  });
}

if (variant === 'mixed' || variant === 'patch' || variant === 'patch-validation' || variant === 'patch-logger' || variant === 'patch-validation-logger') {
  app.patch('/users/:id', async (context) => {
    if (context.req.header('x-api-key') !== 'secret') {
      return context.json({ message: 'Forbidden' }, 403);
    }

    const routeId = context.req.param('id');
    const userId = usesPatchValidation(variant)
      ? (() => {
        const parsedId = validateUserId(routeId);
        if (!parsedId.success) {
          return parsedId;
        }

        return parsedId.output;
      })()
      : routeId;

    if (typeof userId !== 'string') {
      return context.json({ message: 'params validation failed', issues: userId.issues }, 400);
    }

    const user = users.find((candidate) => candidate.id === userId);
    if (!user) {
      return context.json({ message: `User ${userId} was not found` }, 404);
    }

    const requestBody = await context.req.json<{ name?: string }>();
    let body: { name?: string } = requestBody;

    if (usesPatchValidation(variant)) {
      const parsedBody = validatePatchBody(requestBody);
      if (!parsedBody.success) {
        return context.json({ message: 'body validation failed', issues: parsedBody.issues }, 400);
      }

      body = parsedBody.output;
    }

    if (usesPatchLogger(variant)) {
      logInfoDisabled('users.patch.requested', () => ({
        id: userId,
        hasName: typeof body.name === 'string',
      }));
    }

    if (body.name) {
      user.name = body.name;
    }

    return context.json(user);
  });
}

const port = Number(process.env.PORT ?? 3302);

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`benchmark-hono (${variant}) listening on http://127.0.0.1:${port}`);