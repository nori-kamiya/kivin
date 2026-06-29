import { createApp, defineApplication, defineModule, forbidden, notFound, type AppManifest, type CanActivate, type ParameterMetadata, type RequestContext, type SchemaAdapter } from '@kivin/core';

type BenchmarkSchema = { kind: 'body' | 'users-query' | 'patch-body' | 'create-body' | 'user-id-param' };

interface UserRecord {
  id: string;
  name: string;
  email: string;
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

  find(id: string) {
    return this.users.find((user) => user.id === id);
  }

  create(input: { name: string; email: string }) {
    const created = {
      id: String(this.nextId),
      name: input.name,
      email: input.email,
    };

    this.nextId += 1;
    this.users.push(created);
    return created;
  }

  patch(id: string, input: { name?: string }) {
    const user = this.find(id);
    if (!user) {
      throw notFound(`User ${id} was not found`);
    }

    if (input.name) {
      user.name = input.name;
    }

    return user;
  }
}

const store = new UserStore();
const variant = process.env.BENCH_VARIANT ?? 'mixed';

const BODY_SCHEMA: BenchmarkSchema = { kind: 'body' };
const USERS_QUERY_SCHEMA: BenchmarkSchema = { kind: 'users-query' };
const PATCH_BODY_SCHEMA: BenchmarkSchema = { kind: 'patch-body' };
const CREATE_BODY_SCHEMA: BenchmarkSchema = { kind: 'create-body' };
const USER_ID_PARAM_SCHEMA: BenchmarkSchema = { kind: 'user-id-param' };

function isUsersValidationVariant(candidate: string) {
  return candidate === 'users-validation';
}

function isCreateVariant(candidate: string) {
  return candidate === 'create'
    || candidate === 'create-no-request-id'
    || candidate === 'create-no-guard'
    || candidate === 'create-no-validation'
    || candidate === 'create-bare';
}

function isPatchVariant(candidate: string) {
  return candidate === 'patch'
    || candidate === 'patch-validation'
    || candidate === 'patch-logger'
    || candidate === 'patch-validation-logger';
}

function usesPatchValidation(candidate: string) {
  return candidate === 'patch-validation' || candidate === 'patch-validation-logger';
}

function usesPatchLogger(candidate: string) {
  return candidate === 'patch-logger' || candidate === 'patch-validation-logger';
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

function logInfoDisabled(_message: string, _fields?: () => Record<string, unknown>) {
  return undefined;
}

class RequestIdMiddleware {
  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    const requestId = context.request.headers.get('x-request-id') ?? `${context.request.method.toLowerCase()}-${crypto.randomUUID()}`;
    context.setResponseHeader('x-request-id', requestId);
    return next();
  }

  handleRaw(request: Request, _params: Record<string, string>, responseState: { setResponseHeader: (name: string, value: string) => void }, next: () => Response | PromiseLike<Response>) {
    const requestId = request.headers.get('x-request-id') ?? `${request.method.toLowerCase()}-${crypto.randomUUID()}`;
    responseState.setResponseHeader('x-request-id', requestId);
    return next();
  }
}

class ApiKeyGuard implements CanActivate {
  canActivateRaw(request: Request) {
    const method = request.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return true;
    }

    if (request.headers.get('x-api-key') === 'secret') {
      return true;
    }

    throw forbidden();
  }

  canActivate(context: RequestContext) {
    const request = context.request;
    const method = request.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return true;
    }

    if (request.headers.get('x-api-key') === 'secret') {
      return true;
    }

    throw forbidden();
  }
}

class BenchmarkController {
  healthContext(context: RequestContext) {
    return context.json({ ok: true });
  }

  healthPlainResponse() {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  healthStaticObject() {
    return { ok: true };
  }

  list(search?: string) {
    return store.list(search);
  }

  findById(id: string) {
    const user = store.find(id);
    if (!user) {
      throw notFound(`User ${id} was not found`);
    }
    return user;
  }

  patch(id: string, body: { name?: string }) {
    return store.patch(id, body);
  }

  create(input: { name: string; email: string }) {
    return store.create(input);
  }

  createBare(input: { name: string; email: string }) {
    return store.create(input);
  }

  patchLogged(id: string, body: { name?: string }) {
    logInfoDisabled('users.patch.requested', () => ({
      id,
      hasName: Boolean(body.name),
    }));

    return store.patch(id, body);
  }
}

const passthroughSchemaAdapter: SchemaAdapter<BenchmarkSchema> = {
  name: 'passthrough',
  parse: <TOutput>(schema: BenchmarkSchema, input: unknown) => {
    switch (schema.kind) {
      case 'body':
        return { success: true, output: input as TOutput };
      case 'users-query': {
        if (
          !input
          || typeof input !== 'object'
          || typeof (input as { search?: unknown }).search !== 'string'
          || (input as { search: string }).search.length < 2
        ) {
          return { success: false, issues: [{ message: 'search must be a string with minLength 2' }] };
        }

        return { success: true, output: input as TOutput };
      }
      case 'patch-body': {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return { success: false, issues: [{ message: 'body must be an object' }] };
        }

        const name = (input as { name?: unknown }).name;
        if (name !== undefined && typeof name !== 'string') {
          return { success: false, issues: [{ message: 'name must be a string when provided' }] };
        }

        return { success: true, output: input as TOutput };
      }
      case 'create-body': {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return { success: false, issues: [{ message: 'body must be an object' }] };
        }

        const { email, name } = input as { email?: unknown; name?: unknown };
        if (typeof name !== 'string' || typeof email !== 'string' || !email.includes('@')) {
          return { success: false, issues: [{ message: 'name must be a string and email must be an email-like string' }] };
        }

        return { success: true, output: input as TOutput };
      }
      case 'user-id-param': {
        if (!input || typeof input !== 'object' || typeof (input as { id?: unknown }).id !== 'string') {
          return { success: false, issues: [{ message: 'id must be a string' }] };
        }

        return { success: true, output: input as TOutput };
      }
    }
  },
  toOpenApiSchema() {
    return {};
  },
};

const BenchmarkModule = defineModule({
  providers: [ApiKeyGuard, RequestIdMiddleware],
  controllers: [BenchmarkController],
  imports: [],
});

const appDefinition = defineApplication({
  modules: [BenchmarkModule],
  schemaAdapter: passthroughSchemaAdapter,
  globals: {
    guards: [],
    middleware: usesCreateRequestId(variant) ? [RequestIdMiddleware] : [],
    filters: [],
  },
});

const manifest: AppManifest<BenchmarkSchema> = {
  routes: [
    {
      method: 'GET',
      fullPath: '/health',
      controller: BenchmarkController,
      methodName: 'healthStaticObject',
      parameters: [],
      guards: [],
      middleware: [],
      filters: [],
      docs: { tags: ['benchmark'], security: [], responses: [] },
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
      docs: { tags: ['benchmark'], security: [], responses: [] },
    },
    {
      method: 'GET',
      fullPath: '/users/:id',
      controller: BenchmarkController,
      methodName: 'findById',
      parameters: [{ index: 0, source: 'path', name: 'id' }],
      guards: [],
      middleware: [],
      filters: [],
      docs: { tags: ['benchmark'], security: [], responses: [] },
    },
    {
      method: 'PATCH',
      fullPath: '/users/:id',
      controller: BenchmarkController,
      methodName: 'patch',
      parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [],
      docs: { tags: ['benchmark'], bodySchema: BODY_SCHEMA, security: [], responses: [] },
    },
  ],
};

function resolveHealthRoute(route: AppManifest<BenchmarkSchema>['routes'][number], healthMode: string) {
  if (route.fullPath !== '/health') {
    return route;
  }

  let methodName = 'healthStaticObject';
  let parameters: ParameterMetadata[] = [];

  if (healthMode === 'context-json') {
    methodName = 'healthContext';
    parameters = [{ index: 0, source: 'context' }];
  } else if (healthMode === 'plain-response') {
    methodName = 'healthPlainResponse';
  }

  return {
    ...route,
    methodName,
    parameters,
  };
}

function buildUsersRoute(selectedVariant: string): AppManifest<BenchmarkSchema>['routes'][number] {
  const docs: AppManifest<BenchmarkSchema>['routes'][number]['docs'] = {
    tags: ['benchmark'],
    security: [],
    responses: [],
  };

  if (isUsersValidationVariant(selectedVariant)) {
    docs.querySchema = USERS_QUERY_SCHEMA;
  }

  return {
    method: 'GET',
    fullPath: '/users',
    controller: BenchmarkController,
    methodName: 'list',
    parameters: [{ index: 0, source: 'query', name: 'search' }],
    guards: [],
    middleware: [],
    filters: [],
    docs,
  };
}

function buildPatchRoute(selectedVariant: string): AppManifest<BenchmarkSchema>['routes'][number] {
  const docs: AppManifest<BenchmarkSchema>['routes'][number]['docs'] = {
    tags: ['benchmark'],
    bodySchema: usesPatchValidation(selectedVariant) ? PATCH_BODY_SCHEMA : BODY_SCHEMA,
    security: [],
    responses: [],
  };

  if (usesPatchValidation(selectedVariant)) {
    docs.paramSchema = USER_ID_PARAM_SCHEMA;
  }

  return {
    method: 'PATCH',
    fullPath: '/users/:id',
    controller: BenchmarkController,
    methodName: usesPatchLogger(selectedVariant) ? 'patchLogged' : 'patch',
    parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
    guards: [ApiKeyGuard],
    middleware: [],
    filters: [],
    docs,
  };
}

function buildCreateRoute(selectedVariant: string): AppManifest<BenchmarkSchema>['routes'][number] {
  const docs: AppManifest<BenchmarkSchema>['routes'][number]['docs'] = {
    tags: ['benchmark'],
    security: [],
    responses: [{ status: 201, description: 'Created' }],
  };

  if (usesCreateValidation(selectedVariant)) {
    docs.bodySchema = CREATE_BODY_SCHEMA;
  }

  return {
    method: 'POST',
    fullPath: '/users',
    controller: BenchmarkController,
    methodName: selectedVariant === 'create-bare' ? 'createBare' : 'create',
    parameters: [{ index: 0, source: 'body' }],
    guards: usesCreateGuard(selectedVariant) ? [ApiKeyGuard] : [],
    middleware: [],
    filters: [],
    docs,
  };
}

function selectVariantRoutes(routes: AppManifest<BenchmarkSchema>['routes'], selectedVariant: string, healthMode: string) {
  const resolvedRoutes = routes.map((route) => resolveHealthRoute(route, healthMode));

  switch (selectedVariant) {
    case 'health':
      return resolvedRoutes.filter((route) => route.fullPath === '/health');
    case 'users':
    case 'users-validation':
      return resolvedRoutes.filter((route) => route.fullPath === '/health').concat(buildUsersRoute(selectedVariant));
    case 'create':
    case 'create-no-request-id':
    case 'create-no-guard':
    case 'create-no-validation':
    case 'create-bare':
      return resolvedRoutes.filter((route) => route.fullPath === '/health').concat(buildCreateRoute(selectedVariant));
    case 'patch':
    case 'patch-validation':
    case 'patch-logger':
    case 'patch-validation-logger':
      return resolvedRoutes.filter((route) => route.fullPath === '/health').concat(buildPatchRoute(selectedVariant));
    default:
      return resolvedRoutes;
  }
}

const port = Number(process.env.PORT ?? 3301);
const healthMode = process.env.BENCH_HEALTH_MODE ?? 'static-object';
const app = createApp(appDefinition, {
  routes: selectVariantRoutes(manifest.routes, variant, healthMode),
});

app.listen(port);

console.log(`benchmark-kivin (${variant}, ${healthMode}) listening on http://127.0.0.1:${port}`);