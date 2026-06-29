import { Elysia, t } from 'elysia';

const SearchQuerySchema = t.Object({
  search: t.String({ minLength: 2 }),
});

const UserIdParamSchema = t.Object({
  id: t.String(),
});

const PatchUserSchema = t.Object({
  name: t.Optional(t.String()),
  email: t.Optional(t.String({ format: 'email' })),
});

const CreateUserSchema = t.Object({
  name: t.String(),
  email: t.String({ format: 'email' }),
});

const docsHtml = '<!doctype html><html><head><title>elysia stack benchmark</title></head><body><main><h1>elysia stack benchmark</h1><p>App-like benchmark route.</p></main></body></html>';

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
const port = Number(process.env.PORT ?? 3403);

const app = new Elysia();

if (variant !== 'delete-bare') {
  app.onRequest(({ request, set }) => {
    set.headers['x-request-id'] = request.headers.get('x-request-id') ?? crypto.randomUUID();
  });
}

app.get('/health', () => ({ ok: true, suite: 'stack' }));

if (variant === 'mixed' || variant === 'docs') {
  app.get('/docs', ({ set }) => {
    set.headers['content-type'] = 'text/html; charset=utf-8';
    return docsHtml;
  });
}

if (variant === 'mixed' || variant === 'users') {
  app.get('/users', ({ query }) => {
    const keyword = query.search.toLowerCase();
    return users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword));
  }, {
    query: SearchQuerySchema,
  });
}

if (variant === 'mixed' || variant === 'create') {
  app.post('/users', ({ body, headers, set }) => {
    if (headers['x-api-key'] !== 'secret') {
      set.status = 403;
      return { message: 'Forbidden' };
    }

    const created = {
      id: String(nextId),
      name: body.name,
      email: body.email,
    };

    nextId += 1;
    users.push(created);
    set.status = 201;
    return created;
  }, {
    body: CreateUserSchema,
  });
}

if (variant === 'mixed' || variant === 'patch') {
  app.patch('/users/:id', ({ body, headers, params, set }) => {
    if (headers['x-api-key'] !== 'secret') {
      set.status = 403;
      return { message: 'Forbidden' };
    }

    const user = users.find((candidate) => candidate.id === params.id);
    if (!user) {
      set.status = 404;
      return { message: `User ${params.id} was not found` };
    }

    if (body.email && body.email !== user.email) {
      const duplicate = users.find((candidate) => candidate.email === body.email && candidate.id !== user.id);
      if (duplicate) {
        set.status = 409;
        return { message: `User email ${body.email} is already in use` };
      }

      user.email = body.email;
    }

    if (body.name) {
      user.name = body.name;
    }

    return user;
  }, {
    params: UserIdParamSchema,
    body: PatchUserSchema,
  });
}

if (variant === 'mixed' || variant === 'delete') {
  app.delete('/users/:id', ({ headers, params, set }) => {
    if (headers['x-api-key'] !== 'secret') {
      set.status = 403;
      return { message: 'Forbidden' };
    }

    const user = users.find((candidate) => candidate.id === params.id);
    if (!user) {
      set.status = 404;
      return { message: `User ${params.id} was not found` };
    }

    set.status = 204;
    return undefined;
  }, {
    params: UserIdParamSchema,
  });
}

if (variant === 'mixed' || variant === 'delete-inline') {
  app.delete('/users-inline/:id', ({ headers, params, set }) => {
    if (headers['x-api-key'] !== 'secret') {
      set.status = 403;
      return { message: 'Forbidden' };
    }

    const user = users.find((candidate) => candidate.id === params.id);
    if (!user) {
      set.status = 404;
      return { message: `User ${params.id} was not found` };
    }

    set.status = 204;
    return undefined;
  }, {
    params: UserIdParamSchema,
  });
}

if (variant === 'mixed' || variant === 'delete-no-guard') {
  app.delete('/users-no-guard/:id', ({ params, set }) => {
    const user = users.find((candidate) => candidate.id === params.id);
    if (!user) {
      set.status = 404;
      return { message: `User ${params.id} was not found` };
    }

    set.status = 204;
    return undefined;
  }, {
    params: UserIdParamSchema,
  });
}

if (variant === 'mixed' || variant === 'delete-bare') {
  app.delete('/users-bare/:id', ({ params, set }) => {
    const user = users.find((candidate) => candidate.id === params.id);
    if (!user) {
      set.status = 404;
      return { message: `User ${params.id} was not found` };
    }

    set.status = 204;
    return undefined;
  }, {
    params: UserIdParamSchema,
  });
}

app.listen(port);

console.log(`benchmark-stack-elysia (${variant}) listening on http://127.0.0.1:${port}`);