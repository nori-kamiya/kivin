import { defineApplication, defineModule, forbidden, type CanActivate, type ExceptionFilter, type NestLikeMiddleware, type RequestContext, type ResponseState, type RouteInput } from '@kivin/core';
import { ApiResponse, Controller, Delete, Get, Injectable, Patch, Post, Tag, UseBodySchema, UseFilters, UseGuards, UseParamSchema, UseQuerySchema } from '@kivin/decorators';
import { createLoggerModule, LOGGER, type Logger } from '@kivin/logger';
import { createValibotAdapter } from '@kivin/valibot';
import * as v from 'valibot';

export const SearchQuerySchema = v.object({
  search: v.pipe(v.string(), v.minLength(2)),
});

export const UserIdParamSchema = v.object({
  id: v.string(),
});

export const PatchUserSchema = v.object({
  name: v.optional(v.string()),
  email: v.optional(v.pipe(v.string(), v.email())),
});

export const CreateUserSchema = v.object({
  name: v.string(),
  email: v.pipe(v.string(), v.email()),
});

const JSON_RESPONSE_HEADERS = { 'content-type': 'application/json;charset=utf-8' };
type PatchUserInput = v.InferOutput<typeof PatchUserSchema>;
type CreateUserInput = v.InferOutput<typeof CreateUserSchema>;
export const REQUEST_ID_HEADER = 'x-request-id';

const docsHtml = `<!doctype html><html><head><title>kivin stack benchmark</title></head><body><main><h1>kivin stack benchmark</h1><p>App-like benchmark route.</p></main></body></html>`;

export interface UserRecord {
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

export class RequestIdMiddleware implements NestLikeMiddleware {
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

export class ApiKeyGuard implements CanActivate {
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

export class UserNotFoundFilter implements ExceptionFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof UserNotFoundError)) {
      return undefined;
    }

    return context.json({ message: error.message }, { status: 404 });
  }
}

// Routes the variants pick from. Variants that replace POST /users live on their own paths here and
// are mounted at /users by main.ts, so the generated manifest (with AOT executors) covers all of them.
@Controller('/')
@Tag('benchmark-stack')
@Injectable({ deps: [LOGGER] })
export class BenchmarkController {
  constructor(private readonly logger: Logger) {}

  @Get('/health')
  health() {
    return { ok: true, suite: 'stack' };
  }

  @Get('/docs')
  docs() {
    return new Response(docsHtml, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  @Get('/users')
  @UseQuerySchema(SearchQuerySchema)
  list({ query }: RouteInput<{ query: typeof SearchQuerySchema }>) {
    return userStore.list(query.search);
  }

  @Post('/users')
  @UseGuards(ApiKeyGuard)
  @UseBodySchema(CreateUserSchema)
  @ApiResponse(201, 'Created')
  create({ body }: RouteInput<{ body: typeof CreateUserSchema }>) {
    if (this.logger.isLevelEnabled('info')) {
      this.logger.info('users.create.requested', () => ({ email: body.email }));
    }

    return userStore.create(body);
  }

  @Post('/variants/create-no-guard')
  @UseBodySchema(CreateUserSchema)
  @ApiResponse(201, 'Created')
  createNoGuard({ body }: RouteInput<{ body: typeof CreateUserSchema }>) {
    return this.create({ body } as RouteInput<{ body: typeof CreateUserSchema }>);
  }

  @Post('/variants/create-no-validation')
  @UseGuards(ApiKeyGuard)
  @ApiResponse(201, 'Created')
  createNoValidation({ body }: RouteInput) {
    return this.create({ body } as RouteInput<{ body: typeof CreateUserSchema }>);
  }

  @Post('/variants/create-bare')
  @ApiResponse(201, 'Created')
  createBare({ body }: RouteInput) {
    return userStore.create(body as { name: string; email: string });
  }

  @Patch('/users/:id')
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @UseParamSchema(UserIdParamSchema)
  @UseBodySchema(PatchUserSchema)
  patch({ params, body }: RouteInput<{ params: typeof UserIdParamSchema; body: typeof PatchUserSchema }>) {
    if (this.logger.isLevelEnabled('info')) {
      this.logger.info('users.patch.requested', () => ({
        id: params.id,
        hasEmail: Boolean(body.email),
        hasName: Boolean(body.name),
      }));
    }

    return userStore.patch(params.id, body);
  }

  @Delete('/users/:id')
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @UseParamSchema(UserIdParamSchema)
  @ApiResponse(204, 'Deleted')
  remove({ params }: RouteInput<{ params: typeof UserIdParamSchema }>) {
    userStore.remove(params.id);
    return undefined;
  }

  @Delete('/users-inline/:id')
  @UseGuards(ApiKeyGuard)
  @UseParamSchema(UserIdParamSchema)
  @ApiResponse(204, 'Deleted')
  removeInline({ params }: RouteInput<{ params: typeof UserIdParamSchema }>) {
    return inlineRemove(params.id);
  }

  @Delete('/users-no-guard/:id')
  @UseParamSchema(UserIdParamSchema)
  @ApiResponse(204, 'Deleted')
  removeNoGuard({ params }: RouteInput<{ params: typeof UserIdParamSchema }>) {
    return inlineRemove(params.id);
  }

  @Delete('/users-bare/:id')
  @UseParamSchema(UserIdParamSchema)
  @ApiResponse(204, 'Deleted')
  removeBare({ params }: RouteInput<{ params: typeof UserIdParamSchema }>) {
    return inlineRemove(params.id);
  }
}

function inlineRemove(id: string) {
  if (!userStore.has(id)) {
    return new Response(JSON.stringify({ message: `User ${id} was not found` }), {
      status: 404,
      headers: JSON_RESPONSE_HEADERS,
    });
  }

  return undefined;
}

export const LoggerModule = createLoggerModule({
  serviceName: 'kivin-benchmark-stack',
  level: 'error',
  sink: () => {},
});

export const BenchmarkModule = defineModule({
  providers: [RequestIdMiddleware, ApiKeyGuard, UserNotFoundFilter],
  controllers: [BenchmarkController],
  imports: [],
});

// Entry for `kivin generate` (route graph only). main.ts builds the real definition with the logger
// module and per-variant global middleware.
export default defineApplication({
  modules: [BenchmarkModule],
  schemaAdapter: createValibotAdapter(),
});
