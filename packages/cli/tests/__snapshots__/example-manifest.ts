import type { AotRouteRuntime, AppManifest, RequestContext } from '@kivin/core';
import { ApiKeyGuard } from '../../../../examples/basic/src/api-key.guard';
import { UserNotFoundFilter } from '../../../../examples/basic/src/user-not-found.filter';
import { UserController } from '../../../../examples/basic/src/users.controller';
import { AvatarSchema, AvatarUploadSchema, CreateUserSchema, CurrentUserHeadersSchema, ErrorSchema, PatchUserSchema, ReplaceUserSchema, UserIdParamSchema, UserListSchema, UserSchema, UserSearchQuerySchema } from '../../../../examples/basic/src/users.schemas';

export const manifest: AppManifest = {
  routes: [
    {
      method: "GET",
      fullPath: "/users/",
      controller: UserController,
      methodName: "list",
      parameters: [{ index: 0, source: "input", fields: ["query"] }],
      guards: [],
      middleware: [],
      filters: [],
      docs: { summary: "List users", description: "Returns the current in-memory users. Optional search filters by name or email.", operationId: "users.list", tags: ["Users"], querySchema: UserSearchQuerySchema, security: [], responses: [{ status: 200, description: "User list", schema: UserListSchema }] },
      aot: (rt: AotRouteRuntime<UserController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            const queryValue = rt.resolveQueryPayload(request.url);
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                return controller["list"]({ query: queryValue ?? {} } as never);
              });
            }
            const result = controller["list"]({ query: queryValue ?? {} } as never);
            return rt.finish(rt.isThenable(result) ? await result : result, context);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    },
    {
      method: "GET",
      fullPath: "/users/me",
      controller: UserController,
      methodName: "me",
      parameters: [{ index: 0, source: "input", fields: ["headers"] }],
      guards: [],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Current user", description: "Returns the user named by the x-user-id header (validated by a header schema).", operationId: "users.me", tags: ["Users"], headerSchema: CurrentUserHeadersSchema, security: [], responses: [{ status: 200, description: "Current user", schema: UserSchema }, { status: 404, description: "User was not found", schema: ErrorSchema }] },
      aot: (rt: AotRouteRuntime<UserController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                return controller["me"]({ headers: rt.headers(params) } as never);
              });
            }
            const result = controller["me"]({ headers: rt.headers(params) } as never);
            return rt.finish(rt.isThenable(result) ? await result : result, context);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    },
    {
      method: "GET",
      fullPath: "/users/:id",
      controller: UserController,
      methodName: "findById",
      parameters: [{ index: 0, source: "input", fields: ["params"] }],
      guards: [],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Find user by id", description: "Returns a single user by id or raises a domain error handled by a route filter.", operationId: "users.findById", tags: ["Users"], paramSchema: UserIdParamSchema, security: [], responses: [{ status: 200, description: "User detail", schema: UserSchema }, { status: 404, description: "User was not found", schema: ErrorSchema }] },
      aot: (rt: AotRouteRuntime<UserController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            const paramValue = rt.resolveParamPayload(params);
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                return controller["findById"]({ params: paramValue ?? {} } as never);
              });
            }
            const result = controller["findById"]({ params: paramValue ?? {} } as never);
            return rt.finish(rt.isThenable(result) ? await result : result, context);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    },
    {
      method: "POST",
      fullPath: "/users/",
      controller: UserController,
      methodName: "create",
      parameters: [{ index: 0, source: "input", fields: ["body", "context"] }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [],
      docs: { summary: "Create user", description: "Creates a new user. This endpoint is protected by an API key guard.", operationId: "users.create", tags: ["Users"], bodySchema: CreateUserSchema, security: [{ scheme: "apiKeyAuth", scopes: [] }], responses: [{ status: 201, description: "Created user", schema: UserSchema }, { status: 409, description: "User email conflict", schema: ErrorSchema }] },
      aot: (rt: AotRouteRuntime<UserController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                const body = await rt.readBody(request, ctx);
                return controller["create"]({ body: body, context: ctx } as never);
              });
            }
            const ctx = (context ??= rt.createContext(request, params));
            const body = await rt.readBody(request, ctx);
            const result = controller["create"]({ body: body, context: ctx } as never);
            return rt.finish(rt.isThenable(result) ? await result : result, ctx);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    },
    {
      method: "PUT",
      fullPath: "/users/:id",
      controller: UserController,
      methodName: "replace",
      parameters: [{ index: 0, source: "input", fields: ["params", "body", "context"] }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Replace user", description: "Replaces a user with a full payload. Fails when the id is missing or the email is already used by another user.", operationId: "users.replace", tags: ["Users"], bodySchema: ReplaceUserSchema, paramSchema: UserIdParamSchema, security: [{ scheme: "apiKeyAuth", scopes: [] }], responses: [{ status: 200, description: "Replaced user", schema: UserSchema }, { status: 404, description: "User was not found", schema: ErrorSchema }, { status: 409, description: "User email conflict", schema: ErrorSchema }] },
      aot: (rt: AotRouteRuntime<UserController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            const paramValue = rt.resolveParamPayload(params);
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                const body = await rt.readBody(request, ctx);
                return controller["replace"]({ params: paramValue ?? {}, body: body, context: ctx } as never);
              });
            }
            const ctx = (context ??= rt.createContext(request, params));
            const body = await rt.readBody(request, ctx);
            const result = controller["replace"]({ params: paramValue ?? {}, body: body, context: ctx } as never);
            return rt.finish(rt.isThenable(result) ? await result : result, ctx);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    },
    {
      method: "PATCH",
      fullPath: "/users/:id",
      controller: UserController,
      methodName: "patch",
      parameters: [{ index: 0, source: "input", fields: ["params", "body", "context"] }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Patch user", description: "Updates selected user fields. Fails when the id is missing or the email is already used by another user.", operationId: "users.patch", tags: ["Users"], bodySchema: PatchUserSchema, paramSchema: UserIdParamSchema, security: [{ scheme: "apiKeyAuth", scopes: [] }], responses: [{ status: 200, description: "Patched user", schema: UserSchema }, { status: 404, description: "User was not found", schema: ErrorSchema }, { status: 409, description: "User email conflict", schema: ErrorSchema }] },
      aot: (rt: AotRouteRuntime<UserController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            const paramValue = rt.resolveParamPayload(params);
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                const body = await rt.readBody(request, ctx);
                return controller["patch"]({ params: paramValue ?? {}, body: body, context: ctx } as never);
              });
            }
            const ctx = (context ??= rt.createContext(request, params));
            const body = await rt.readBody(request, ctx);
            const result = controller["patch"]({ params: paramValue ?? {}, body: body, context: ctx } as never);
            return rt.finish(rt.isThenable(result) ? await result : result, ctx);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    },
    {
      method: "PUT",
      fullPath: "/users/:id/avatar",
      controller: UserController,
      methodName: "uploadAvatar",
      parameters: [{ index: 0, source: "input", fields: ["params", "body"] }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Upload avatar", description: "Uploads a PNG or JPEG avatar (max 1 MiB) as multipart/form-data.", operationId: "users.uploadAvatar", tags: ["Users"], bodySchema: AvatarUploadSchema, consumes: "multipart/form-data", paramSchema: UserIdParamSchema, security: [{ scheme: "apiKeyAuth", scopes: [] }], responses: [{ status: 200, description: "Stored avatar", schema: AvatarSchema }, { status: 404, description: "User was not found", schema: ErrorSchema }, { status: 415, description: "Body was not multipart/form-data", schema: ErrorSchema }] },
      aot: (rt: AotRouteRuntime<UserController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            const paramValue = rt.resolveParamPayload(params);
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                const body = await rt.readBody(request, ctx);
                return controller["uploadAvatar"]({ params: paramValue ?? {}, body: body } as never);
              });
            }
            const body = await rt.readBody(request, context);
            const result = controller["uploadAvatar"]({ params: paramValue ?? {}, body: body } as never);
            return rt.finish(rt.isThenable(result) ? await result : result, context);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    },
    {
      method: "DELETE",
      fullPath: "/users/:id",
      controller: UserController,
      methodName: "delete",
      parameters: [{ index: 0, source: "input", fields: ["params", "context"] }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Delete user", description: "Deletes a user by id and returns no content when successful.", operationId: "users.delete", tags: ["Users"], paramSchema: UserIdParamSchema, security: [{ scheme: "apiKeyAuth", scopes: [] }], responses: [{ status: 204, description: "User deleted" }, { status: 404, description: "User was not found", schema: ErrorSchema }] },
      aot: (rt: AotRouteRuntime<UserController>) => {
        const controller = rt.controller;
        const hasGuards = rt.hasGuards;
        const hasMiddleware = rt.hasMiddleware;
        return async (request: Request, params: Record<string, string>) => {
          let context: RequestContext | undefined;
          try {
            const paramValue = rt.resolveParamPayload(params);
            if (hasGuards) {
              const guarded = rt.runGuards(request, params, context);
              context = rt.isThenable(guarded) ? await guarded : guarded;
            }
            if (hasMiddleware) {
              const ctx = (context ??= rt.createContext(request, params));
              return await rt.runMiddleware(ctx, async () => {
                return controller["delete"]({ params: paramValue ?? {}, context: ctx } as never);
              });
            }
            const ctx = (context ??= rt.createContext(request, params));
            const result = controller["delete"]({ params: paramValue ?? {}, context: ctx } as never);
            return rt.finish(rt.isThenable(result) ? await result : result, ctx);
          } catch (error) {
            return rt.handleError(error, context, request, params);
          }
        };
      },
    }
  ],
};

export default manifest;
