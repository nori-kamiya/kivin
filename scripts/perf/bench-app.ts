// Benchmark app for the performance regression gate (scripts/perf-regression.ts).
//
// It uses only long-standing public `@kivin/core` APIs (manual manifest, `setInjectableMetadata`)
// so the very same file can be run against the base ref and the current tree.
import {
  createApp,
  defineApplication,
  defineModule,
  setInjectableMetadata,
  type AppManifest,
  type CanActivate,
  type ExceptionFilter,
  type NestLikeMiddleware,
  type RequestContext,
  type ResponseState,
} from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import * as v from 'valibot';

const SearchQuerySchema = v.object({ search: v.optional(v.pipe(v.string(), v.minLength(2))) });
const IdParamSchema = v.object({ id: v.pipe(v.string(), v.regex(/^\d+$/)) });
const CreateUserSchema = v.object({ name: v.pipe(v.string(), v.minLength(1)), email: v.pipe(v.string(), v.email()) });
const PatchUserSchema = v.object({ name: v.optional(v.string()), email: v.optional(v.pipe(v.string(), v.email())) });
const UserSchema = v.object({ id: v.string(), name: v.string(), email: v.string() });

interface UserRecord {
  id: string;
  name: string;
  email: string;
}

class UserNotFoundError extends Error {}

class UserStore {
  readonly users: UserRecord[] = Array.from({ length: 20 }, (_, index) => ({
    id: String(index + 1),
    name: `User ${index + 1}`,
    email: `user${index + 1}@example.com`,
  }));

  list(search?: string) {
    return search ? this.users.filter((user) => user.name.toLowerCase().includes(search.toLowerCase())) : this.users;
  }

  find(id: string) {
    const user = this.users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new UserNotFoundError(id);
    }
    return user;
  }
}

class ApiKeyGuard implements CanActivate {
  canActivateRaw(request: Request) {
    return request.headers.get('x-api-key') === 'secret';
  }

  canActivate(context: RequestContext) {
    return context.req.raw.headers.get('x-api-key') === 'secret';
  }
}

class RequestIdMiddleware implements NestLikeMiddleware {
  handleRaw(request: Request, _params: Record<string, string>, state: ResponseState, next: () => Response | PromiseLike<Response>) {
    state.setResponseHeader('x-request-id', request.headers.get('x-request-id') ?? 'generated');
    return next();
  }

  handle(context: RequestContext, next: () => Response | PromiseLike<Response>) {
    context.setResponseHeader('x-request-id', context.req.raw.headers.get('x-request-id') ?? 'generated');
    return next();
  }
}

class UserNotFoundFilter implements ExceptionFilter {
  catch(error: unknown) {
    if (error instanceof UserNotFoundError) {
      return Response.json({ message: 'not found' }, { status: 404 });
    }
    return undefined;
  }
}

const REQUEST_STAMP = Symbol.for('perf.requestStamp');
let stampCounter = 0;

class HealthController {
  health() {
    return { ok: true };
  }

  contextJson(context: RequestContext) {
    return context.json({ ok: true, path: '/context' });
  }
}

class UsersController {
  constructor(private readonly store: UserStore) {}

  list(search?: string) {
    return this.store.list(search);
  }

  find(id: string) {
    return this.store.find(id);
  }

  create(input: v.InferOutput<typeof CreateUserSchema>, context: RequestContext) {
    return context.json({ id: '999', ...input }, { status: 201 });
  }

  patch(id: string, input: v.InferOutput<typeof PatchUserSchema>) {
    const user = this.store.find(id);
    return { ...user, ...input };
  }

  remove(id: string, context: RequestContext) {
    this.store.find(id);
    return context.noContent();
  }

  scoped(context: RequestContext) {
    return { stamp: context.inject<{ value: number }>(REQUEST_STAMP).value };
  }
}

setInjectableMetadata(UsersController, { deps: [UserStore] });

const route = (input: Partial<AppManifest['routes'][number]> & Pick<AppManifest['routes'][number], 'method' | 'fullPath' | 'controller' | 'methodName'>): AppManifest['routes'][number] => ({
  parameters: [],
  guards: [],
  middleware: [],
  filters: [],
  docs: { tags: [], security: [], responses: [] },
  ...input,
});

const manifest: AppManifest = {
  routes: [
    route({ method: 'GET', fullPath: '/health', controller: HealthController, methodName: 'health' }),
    route({ method: 'GET', fullPath: '/context', controller: HealthController, methodName: 'contextJson', parameters: [{ index: 0, source: 'context' }] }),
    route({
      method: 'GET', fullPath: '/users', controller: UsersController, methodName: 'list',
      parameters: [{ index: 0, source: 'query', name: 'search' }],
      docs: { tags: [], security: [], querySchema: SearchQuerySchema, responses: [] },
    }),
    route({
      method: 'GET', fullPath: '/users/:id', controller: UsersController, methodName: 'find',
      parameters: [{ index: 0, source: 'path', name: 'id' }],
      filters: [UserNotFoundFilter],
      docs: { tags: [], security: [], paramSchema: IdParamSchema, responses: [{ status: 200, description: 'user', schema: UserSchema }] },
    }),
    route({
      method: 'POST', fullPath: '/users', controller: UsersController, methodName: 'create',
      parameters: [{ index: 0, source: 'body' }, { index: 1, source: 'context' }],
      guards: [ApiKeyGuard],
      middleware: [RequestIdMiddleware],
      docs: { tags: [], security: [], bodySchema: CreateUserSchema, responses: [] },
    }),
    route({
      method: 'PATCH', fullPath: '/users/:id', controller: UsersController, methodName: 'patch',
      parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'body' }],
      guards: [ApiKeyGuard],
      filters: [UserNotFoundFilter],
      docs: { tags: [], security: [], paramSchema: IdParamSchema, bodySchema: PatchUserSchema, responses: [] },
    }),
    route({
      method: 'DELETE', fullPath: '/users/:id', controller: UsersController, methodName: 'remove',
      parameters: [{ index: 0, source: 'path', name: 'id' }, { index: 1, source: 'context' }],
      guards: [ApiKeyGuard],
      filters: [UserNotFoundFilter],
      docs: { tags: [], security: [], paramSchema: IdParamSchema, responses: [] },
    }),
    route({ method: 'GET', fullPath: '/scoped', controller: UsersController, methodName: 'scoped', parameters: [{ index: 0, source: 'context' }] }),
  ],
};

export function createBenchApp() {
  const definition = defineApplication({
    modules: [
      defineModule({
        providers: [
          UserStore,
          ApiKeyGuard,
          RequestIdMiddleware,
          UserNotFoundFilter,
          HealthController,
          UsersController,
          { provide: REQUEST_STAMP, scope: 'request', useFactory: () => ({ value: ++stampCounter }) },
        ],
        controllers: [HealthController, UsersController],
        imports: [],
      }),
    ],
    schemaAdapter: createValibotAdapter(),
  });
  return createApp(definition, manifest);
}

export interface BenchScenario {
  name: string;
  /** Expected status, asserted once before timing so a broken route cannot look "fast". */
  status: number;
  request: () => Request;
}

const BASE = 'http://bench.local';
const jsonHeaders = { 'content-type': 'application/json', 'x-api-key': 'secret' };

export const scenarios: BenchScenario[] = [
  { name: 'health-static', status: 200, request: () => new Request(`${BASE}/health`) },
  { name: 'context-json', status: 200, request: () => new Request(`${BASE}/context`) },
  { name: 'list-query', status: 200, request: () => new Request(`${BASE}/users?search=user`) },
  { name: 'get-param', status: 200, request: () => new Request(`${BASE}/users/7`) },
  { name: 'get-filtered-404', status: 404, request: () => new Request(`${BASE}/users/404`) },
  {
    name: 'create-body-guard-mw',
    status: 201,
    request: () => new Request(`${BASE}/users`, { method: 'POST', headers: jsonHeaders, body: '{"name":"Ada","email":"ada@example.com"}' }),
  },
  {
    name: 'patch-body-guard',
    status: 200,
    request: () => new Request(`${BASE}/users/3`, { method: 'PATCH', headers: jsonHeaders, body: '{"name":"Grace"}' }),
  },
  { name: 'delete-204', status: 204, request: () => new Request(`${BASE}/users/5`, { method: 'DELETE', headers: { 'x-api-key': 'secret' } }) },
  { name: 'request-scoped', status: 200, request: () => new Request(`${BASE}/scoped`) },
  { name: 'unknown-404', status: 404, request: () => new Request(`${BASE}/nope`) },
  { name: 'guard-403', status: 403, request: () => new Request(`${BASE}/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) },
];

