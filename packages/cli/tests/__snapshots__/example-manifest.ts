import type { AppManifest } from '@kivin/core';
import { ApiKeyGuard } from '../../../../examples/basic/src/api-key.guard';
import { UserNotFoundFilter } from '../../../../examples/basic/src/user-not-found.filter';
import { UserController } from '../../../../examples/basic/src/users.controller';
import { CreateUserSchema, ErrorSchema, PatchUserSchema, ReplaceUserSchema, UserIdParamSchema, UserListSchema, UserSchema, UserSearchQuerySchema } from '../../../../examples/basic/src/users.schemas';

export const manifest: AppManifest = {
  routes: [
    {
      method: "GET",
      fullPath: "/users/",
      controller: UserController,
      methodName: "list",
      parameters: [{ index: 0, source: "query", name: "search" }],
      guards: [],
      middleware: [],
      filters: [],
      docs: { summary: "List users", description: "Returns the current in-memory users. Optional search filters by name or email.", operationId: "users.list", tags: ["Users"], querySchema: UserSearchQuerySchema, security: [], responses: [{ status: 200, description: "User list", schema: UserListSchema }] },
    },
    {
      method: "GET",
      fullPath: "/users/:id",
      controller: UserController,
      methodName: "findById",
      parameters: [{ index: 0, source: "path", name: "id" }],
      guards: [],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Find user by id", description: "Returns a single user by id or raises a domain error handled by a route filter.", operationId: "users.findById", tags: ["Users"], paramSchema: UserIdParamSchema, security: [], responses: [{ status: 200, description: "User detail", schema: UserSchema }, { status: 404, description: "User was not found", schema: ErrorSchema }] },
    },
    {
      method: "POST",
      fullPath: "/users/",
      controller: UserController,
      methodName: "create",
      parameters: [{ index: 0, source: "body" }, { index: 1, source: "context" }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [],
      docs: { summary: "Create user", description: "Creates a new user. This endpoint is protected by an API key guard.", operationId: "users.create", tags: ["Users"], bodySchema: CreateUserSchema, security: [{ scheme: "apiKeyAuth", scopes: [] }], responses: [{ status: 201, description: "Created user", schema: UserSchema }, { status: 409, description: "User email conflict", schema: ErrorSchema }] },
    },
    {
      method: "PUT",
      fullPath: "/users/:id",
      controller: UserController,
      methodName: "replace",
      parameters: [{ index: 0, source: "path", name: "id" }, { index: 1, source: "body" }, { index: 2, source: "context" }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Replace user", description: "Replaces a user with a full payload. Fails when the id is missing or the email is already used by another user.", operationId: "users.replace", tags: ["Users"], bodySchema: ReplaceUserSchema, paramSchema: UserIdParamSchema, security: [{ scheme: "apiKeyAuth", scopes: [] }], responses: [{ status: 200, description: "Replaced user", schema: UserSchema }, { status: 404, description: "User was not found", schema: ErrorSchema }, { status: 409, description: "User email conflict", schema: ErrorSchema }] },
    },
    {
      method: "PATCH",
      fullPath: "/users/:id",
      controller: UserController,
      methodName: "patch",
      parameters: [{ index: 0, source: "path", name: "id" }, { index: 1, source: "body" }, { index: 2, source: "context" }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Patch user", description: "Updates selected user fields. Fails when the id is missing or the email is already used by another user.", operationId: "users.patch", tags: ["Users"], bodySchema: PatchUserSchema, paramSchema: UserIdParamSchema, security: [{ scheme: "apiKeyAuth", scopes: [] }], responses: [{ status: 200, description: "Patched user", schema: UserSchema }, { status: 404, description: "User was not found", schema: ErrorSchema }, { status: 409, description: "User email conflict", schema: ErrorSchema }] },
    },
    {
      method: "DELETE",
      fullPath: "/users/:id",
      controller: UserController,
      methodName: "delete",
      parameters: [{ index: 0, source: "path", name: "id" }, { index: 1, source: "context" }],
      guards: [ApiKeyGuard],
      middleware: [],
      filters: [UserNotFoundFilter],
      docs: { summary: "Delete user", description: "Deletes a user by id and returns no content when successful.", operationId: "users.delete", tags: ["Users"], paramSchema: UserIdParamSchema, security: [{ scheme: "apiKeyAuth", scopes: [] }], responses: [{ status: 204, description: "User deleted" }, { status: 404, description: "User was not found", schema: ErrorSchema }] },
    }
  ],
};

export default manifest;
