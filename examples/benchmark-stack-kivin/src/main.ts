import { createApp, defineApplication, defineModule, forbidden, setInjectableMetadata, type AppManifest, type CanActivate, type ExceptionFilter, type NestLikeMiddleware, type RequestContext, type ResponseState } from '@kivin/core';
import { createLoggerModule, LOGGER, type Logger } from '@kivin/logger';
import { createValibotAdapter } from '@kivin/valibot';
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

type PatchUserInput = v.InferOutput<typeof PatchUserSchema>;
type CreateUserInput = v.InferOutput<typeof CreateUserSchema>;
const JSON_RESPONSE_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const REQUEST_ID_HEADER = 'x-request-id';

const docsHtml = `<!doctype html><html><head><title>kivin stack benchmark</title></head><body><main><h1>kivin stack benchmark</h1><p>App-like benchmark route.</p></main></body></html>`;

interface UserRecord {
  id: string;
  name: string;
  email: string;
}

class UserNotFoundError extends Error {
  constructor(id: string) {
    super(`User ${id} was not found`);
  }
}

class UserStore {
  private nextId = 3;
  private readonly users: UserRecord[] = [
    { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
    { id: '2', name: 'Grace Hopper', email: 'grace@example.com' },
  ];

  list(search?: string) {
    if (!search) {
      return this.users;
    }

    const keyword = search.toLowerCase();
    return this.users.filter((user) => user.name.toLowerCase().includes(keyword) || user.email.toLowerCase().includes(keyword));
  }

  create(input: CreateUserInput) {
    const created = {
      id: String(this.nextId),
      name: input.name,
      email: input.email,
    };

    this.nextId += 1;
    this.users.push(created);
    return created;
  }

  patch(id: string, input: PatchUserInput) {
    const user = this.users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new UserNotFoundError(id);
    }

    if (input.email && input.email !== user.email) {
      const duplicate = this.users.find((candidate) => candidate.email === input.email && candidate.id !== id);
      if (duplicate) {
        throw new Response(JSON.stringify({ message: `User email ${input.email} is already in use` }), {
          status: 409,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      user.email = input.email;
    }

    if (input.name) {
      user.name = input.name;
    }

    return user;
  }

  remove(id: string) {
    const user = this.users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new UserNotFoundError(id);
    }

    return user;
  }

  has(id: string) {
    return this.users.some((candidate) => candidate.id === id);
  }
}

const userStore = new UserStore();
const variant = process.env.BENCH_VARIANT ?? 'mixed';

function isCreateVariant(candidate: string) {
  return candidate === 'create'
    || candidate === 'create-no-request-id'
    || candidate === 'create-no-guard'
    || candidate === 'create-no-validation'
    || candidate === 'create-bare';
}

function shouldUseRequestIdMiddleware(candidate: string) {
  return candidate !== 'delete-bare'
    && candidate !== 'create-no-request-id'
    && candidate !== 'create-bare';
}

function buildCreateRoute(candidate: string): AppManifest['routes'][number] {
  const includeGuard = candidate !== 'create-no-guard' && candidate !== 'create-bare';
  const includeValidation = candidate !== 'create-no-validation' && candidate !== 'create-bare';
  const methodName = candidate === 'create-bare' ? 'createBare' : 'create';

  return {
    method: 'POST',
    fullPath: '/users',
    controller: BenchmarkController,
    methodName,
    parameters: [{ index: 0, source: 'body' }],
    guards: includeGuard ? [ApiKeyGuard] : [],
    middleware: [],
    filters: [],
    docs: {
      tags: ['benchmark-stack'],
      bodySchema: includeValidation ? CreateUserSchema : undefined,
      security: [],
      responses: [{ status: 201, description: 'Created' }],
    },
  };
}

class RequestIdMiddleware implements NestLikeMiddleware {
  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    const request = context.request;
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
    context.setResponseHeader(REQUEST_ID_HEADER, requestId);
    return next();
  }

  handleRaw(request: Request, _params: Record<string, string>, responseState: ResponseState, next: () => Response | PromiseLike<Response>) {
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
    responseState.setResponseHeader(REQUEST_ID_HEADER, requestId);
    return next();
  }
}

class ApiKeyGuard implements CanActivate {
  canActivateRaw(request: Request) {
    if (request.headers.get('x-api-key') === 'secret') {
      return true;
    }

    throw forbidden();
  }

  canActivate(context: RequestContext) {
    if (context.request.headers.get('x-api-key') === 'secret') {
      return true;
    }

    throw forbidden();
  }
}

class UserNotFoundFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof UserNotFoundError)) {
      return undefined;
    }

    return context.json({ message: error.message }, { status: 404 });
  }
}

class BenchmarkController {
  constructor(private readonly logger: Logger) {}

  health() {
    return { ok: true, suite: 'stack' };
  }

  docs() {
    return new Response(docsHtml, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  list(search?: string) {
    return userStore.list(search);
  }

  create(input: CreateUserInput) {
    if (this.logger.isLevelEnabled('info')) {
      this.logger.info('users.create.requested', () => ({ email: input.email }));
    }

    return userStore.create(input);
  }

  createBare(input: CreateUserInput) {
    return userStore.create(input);
  }

  patch(id: string, input: PatchUserInput) {
    if (this.logger.isLevelEnabled('info')) {
      this.logger.info('users.patch.requested', () => ({
        id,
        hasEmail: Boolean(input.email),
        hasName: Boolean(input.name),
      }));
    }

    return userStore.patch(id, input);
  }

  remove(id: string) {
    userStore.remove(id);
    return undefined;
  }

  removeInline(id: string) {
    if (!userStore.has(id)) {
      return new Response(JSON.stringify({ message: `User ${id} was not found` }), {
        status: 404,
        headers: JSON_RESPONSE_HEADERS,
      });
    }

    return undefined;
  }

  removeNoGuard(id: string) {
    return this.removeInline(id);
  }

  removeBare(id: string) {
    return this.removeInline(id);
  }
}

setInjectableMetadata(BenchmarkController, { deps: [LOGGER] });

const LoggerModule = createLoggerModule({
  serviceName: 'kivin-benchmark-stack',
  level: 'error',
  sink: () => {},
});

const BenchmarkModule = defineModule({
  providers: [RequestIdMiddleware, ApiKeyGuard, UserNotFoundFilter],
  controllers: [BenchmarkController],
  imports: [],
});

const appDefinition = defineApplication({
  modules: [LoggerModule, BenchmarkModule],
  schemaAdapter: createValibotAdapter(),
  globals: {
    guards: [],
    middleware: shouldUseRequestIdMiddleware(variant) ? [RequestIdMiddleware] : [],
    filters: [],
  },
});

const baseRoutes: AppManifest['routes'] = [
    {
      method: 'GET',
      fullPath: '/health',
      controller: BenchmarkController,
      methodName: 'health',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: { tags: ['benchmark-stack'], security: [], responses: [] },
    },
    {
      method: 'GET',
      fullPath: '/docs',
      controller: BenchmarkController,
      methodName: 'docs',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: { tags: ['benchmark-stack'], security: [], responses: [] },
    },
    {
      method: 'GET',
      fullPath: '/users',
      controller: BenchmarkController,
      methodName: 'list',
      parameters: [{ index: 0, source: 'query', name: 'search' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: { tags: ['benchmark-stack'], querySchema: SearchQuerySchema, security: [], responses: [] },
    },
    {
      method: 'PATCH',
      fullPath: '/users/:id',
      controller: BenchmarkController,
      methodName: 'patch',
      parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: {
        tags: ['benchmark-stack'],
        bodySchema: PatchUserSchema,
        paramSchema: UserIdParamSchema,
        security: [],
        responses: [],
      },
    },
    {
      method: 'DELETE',
      fullPath: '/users/:id',
      controller: BenchmarkController,
      methodName: 'remove',
      parameters: [{ index: 0, source: 'path', name: 'id' }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: {
        tags: ['benchmark-stack'],
        paramSchema: UserIdParamSchema,
        security: [],
        responses: [{ status: 204, description: 'Deleted' }],
      },
    },
    {
      method: 'DELETE',
      fullPath: '/users-inline/:id',
      controller: BenchmarkController,
      methodName: 'removeInline',
      parameters: [{ index: 0, source: 'path', name: 'id' }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [],
      docs: {
        tags: ['benchmark-stack'],
        paramSchema: UserIdParamSchema,
        security: [],
        responses: [{ status: 204, description: 'Deleted' }],
      },
    },
    {
      method: 'DELETE',
      fullPath: '/users-no-guard/:id',
      controller: BenchmarkController,
      methodName: 'removeNoGuard',
      parameters: [{ index: 0, source: 'path', name: 'id' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['benchmark-stack'],
        paramSchema: UserIdParamSchema,
        security: [],
        responses: [{ status: 204, description: 'Deleted' }],
      },
    },
    {
      method: 'DELETE',
      fullPath: '/users-bare/:id',
      controller: BenchmarkController,
      methodName: 'removeBare',
      parameters: [{ index: 0, source: 'path', name: 'id' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: {
        tags: ['benchmark-stack'],
        paramSchema: UserIdParamSchema,
        security: [],
        responses: [{ status: 204, description: 'Deleted' }],
      },
    },
];

function selectVariantRoutes(routes: AppManifest['routes'], selectedVariant: string) {
  if (isCreateVariant(selectedVariant)) {
    return routes.filter((route) => route.fullPath === '/health').concat(buildCreateRoute(selectedVariant));
  }

  switch (selectedVariant) {
    case 'health':
      return routes.filter((route) => route.fullPath === '/health');
    case 'docs':
      return routes.filter((route) => route.fullPath === '/health' || route.fullPath === '/docs');
    case 'users':
      return routes.filter((route) => route.fullPath === '/health' || (route.method === 'GET' && route.fullPath === '/users'));
    case 'create':
      return routes.filter((route) => route.fullPath === '/health').concat(buildCreateRoute('create'));
    case 'patch':
      return routes.filter((route) => route.fullPath === '/health' || (route.method === 'PATCH' && route.fullPath === '/users/:id'));
    case 'delete':
      return routes.filter((route) => route.fullPath === '/health' || (route.method === 'DELETE' && route.fullPath === '/users/:id'));
    case 'delete-inline':
      return routes.filter((route) => route.fullPath === '/health' || (route.method === 'DELETE' && route.fullPath === '/users-inline/:id'));
    case 'delete-no-guard':
      return routes.filter((route) => route.fullPath === '/health' || (route.method === 'DELETE' && route.fullPath === '/users-no-guard/:id'));
    case 'delete-bare':
      return routes.filter((route) => route.fullPath === '/health' || (route.method === 'DELETE' && route.fullPath === '/users-bare/:id'));
    default:
      return routes.concat(buildCreateRoute('create'));
  }
}

const port = Number(process.env.PORT ?? 3401);
const app = createApp(appDefinition, {
  routes: selectVariantRoutes(baseRoutes, variant),
});

app.listen(port);

console.log(`benchmark-stack-kivin (${variant}) listening on http://127.0.0.1:${port}`);
