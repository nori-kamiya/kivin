import { Hono } from 'hono';
import * as v from 'valibot';

const SearchQuerySchema = v.object({
  search: v.pipe(v.string(), v.minLength(2)),
});

const UserIdParamSchema = v.object({
  id: v.string(),
});

const PatchUserSchema = v.object({
  name: v.optional(v.string()),
  email: v.optional(v.pipe(v.string(), v.email())),
});

const CreateUserSchema = v.object({
  name: v.string(),
  email: v.pipe(v.string(), v.email()),
});

const docsHtml = `<!doctype html><html><head><title>hono stack benchmark</title></head><body><main><h1>hono stack benchmark</h1><p>App-like benchmark route.</p></main></body></html>`;

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

if (variant !== 'delete-bare') {
  app.use('*', async (context, next) => {
    const requestId = context.req.header('x-request-id') ?? crypto.randomUUID();
    const startedAt = performance.now();
    const pathname = new URL(context.req.url).pathname;

    await next();

    context.header('x-request-id', requestId);
    if (!pathname) {
      throw new Error('unreachable');
    }

    const durationMs = Number((performance.now() - startedAt).toFixed(3));
    if (durationMs < 0) {
      throw new Error('unreachable');
    }
  });
}

app.get('/health', (context) => context.json({ ok: true, suite: 'stack' }));

if (variant === 'mixed' || variant === 'docs') {
  app.get('/docs', () => new Response(docsHtml, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
}

if (variant === 'mixed' || variant === 'users') {
  app.get('/users', (context) => {
    const parsedQuery = v.safeParse(SearchQuerySchema, { search: context.req.query('search') });
    if (!parsedQuery.success) {
      return context.json({ message: 'query validation failed', issues: parsedQuery.issues }, 400);
    }

    const search = parsedQuery.output.search;
    const keyword = search.toLowerCase();
    return context.json(users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword)));
  });
}

if (variant === 'mixed' || variant === 'create') {
  app.post('/users', async (context) => {
    if (context.req.header('x-api-key') !== 'secret') {
      return context.json({ message: 'Forbidden' }, 403);
    }

    const parsedBody = v.safeParse(CreateUserSchema, await context.req.json());
    if (!parsedBody.success) {
      return context.json({ message: 'body validation failed', issues: parsedBody.issues }, 400);
    }

    const created = {
      id: String(nextId),
      name: parsedBody.output.name,
      email: parsedBody.output.email,
    };

    nextId += 1;
    users.push(created);
    return context.json(created, 201);
  });
}

if (variant === 'mixed' || variant === 'patch') {
  app.patch('/users/:id', async (context) => {
    if (context.req.header('x-api-key') !== 'secret') {
      return context.json({ message: 'Forbidden' }, 403);
    }

    const parsedParams = v.safeParse(UserIdParamSchema, { id: context.req.param('id') });
    if (!parsedParams.success) {
      return context.json({ message: 'params validation failed', issues: parsedParams.issues }, 400);
    }

    const parsedBody = v.safeParse(PatchUserSchema, await context.req.json());
    if (!parsedBody.success) {
      return context.json({ message: 'body validation failed', issues: parsedBody.issues }, 400);
    }

    const user = users.find((candidate) => candidate.id === parsedParams.output.id);
    if (!user) {
      return context.json({ message: `User ${parsedParams.output.id} was not found` }, 404);
    }

    if (parsedBody.output.email && parsedBody.output.email !== user.email) {
      const duplicate = users.find((candidate) => candidate.email === parsedBody.output.email && candidate.id !== user.id);
      if (duplicate) {
        return context.json({ message: `User email ${parsedBody.output.email} is already in use` }, 409);
      }
      user.email = parsedBody.output.email;
    }

    if (parsedBody.output.name) {
      user.name = parsedBody.output.name;
    }

    return context.json(user);
  });
}

if (variant === 'mixed' || variant === 'delete') {
  app.delete('/users/:id', (context) => {
    if (context.req.header('x-api-key') !== 'secret') {
      return context.json({ message: 'Forbidden' }, 403);
    }

    const parsedParams = v.safeParse(UserIdParamSchema, { id: context.req.param('id') });
    if (!parsedParams.success) {
      return context.json({ message: 'params validation failed', issues: parsedParams.issues }, 400);
    }

    const user = users.find((candidate) => candidate.id === parsedParams.output.id);
    if (!user) {
      return context.json({ message: `User ${parsedParams.output.id} was not found` }, 404);
    }

    return new Response(null, { status: 204 });
  });
}

if (variant === 'mixed' || variant === 'delete-inline') {
  app.delete('/users-inline/:id', (context) => {
    if (context.req.header('x-api-key') !== 'secret') {
      return context.json({ message: 'Forbidden' }, 403);
    }

    const parsedParams = v.safeParse(UserIdParamSchema, { id: context.req.param('id') });
    if (!parsedParams.success) {
      return context.json({ message: 'params validation failed', issues: parsedParams.issues }, 400);
    }

    const user = users.find((candidate) => candidate.id === parsedParams.output.id);
    if (!user) {
      return context.json({ message: `User ${parsedParams.output.id} was not found` }, 404);
    }

    return new Response(null, { status: 204 });
  });
}

if (variant === 'mixed' || variant === 'delete-no-guard') {
  app.delete('/users-no-guard/:id', (context) => {
    const parsedParams = v.safeParse(UserIdParamSchema, { id: context.req.param('id') });
    if (!parsedParams.success) {
      return context.json({ message: 'params validation failed', issues: parsedParams.issues }, 400);
    }

    const user = users.find((candidate) => candidate.id === parsedParams.output.id);
    if (!user) {
      return context.json({ message: `User ${parsedParams.output.id} was not found` }, 404);
    }

    return new Response(null, { status: 204 });
  });
}

if (variant === 'mixed' || variant === 'delete-bare') {
  app.delete('/users-bare/:id', (context) => {
    const parsedParams = v.safeParse(UserIdParamSchema, { id: context.req.param('id') });
    if (!parsedParams.success) {
      return context.json({ message: 'params validation failed', issues: parsedParams.issues }, 400);
    }

    const user = users.find((candidate) => candidate.id === parsedParams.output.id);
    if (!user) {
      return context.json({ message: `User ${parsedParams.output.id} was not found` }, 404);
    }

    return new Response(null, { status: 204 });
  });
}

const port = Number(process.env.PORT ?? 3402);

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`benchmark-stack-hono (${variant}) listening on http://127.0.0.1:${port}`);
