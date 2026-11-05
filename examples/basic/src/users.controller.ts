import type { RouteInput } from '@kivin/core';
import {
    ApiResponse,
    Consumes,
    Controller,
    Delete,
    Description,
    Get,
    Injectable,
    OperationId,
    Patch,
    Post,
    Put,
    Security,
    Summary,
    Tag,
    UseBodySchema,
    UseFilters,
    UseGuards,
    UseParamSchema,
    UseQuerySchema,
} from '@kivin/decorators';
import { getRequestLogger } from '@kivin/logger';
import { ApiKeyGuard } from './api-key.guard';
import { UserNotFoundFilter } from './user-not-found.filter';
import {
    AvatarSchema,
    AvatarUploadSchema,
    CreateUserSchema,
    ErrorSchema,
    PatchUserSchema,
    ReplaceUserSchema,
    UserIdParamSchema,
    UserListSchema,
    UserSchema,
    UserSearchQuerySchema,
} from './users.schemas';
import { UserService } from './users.service';

@Controller('/users')
@Tag('Users')
@Injectable({ deps: [UserService] })
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('/')
  @Summary('List users')
  @Description('Returns the current in-memory users. Optional search filters by name or email.')
  @OperationId('users.list')
  @UseQuerySchema(UserSearchQuerySchema)
  @ApiResponse(200, UserListSchema, 'User list')
  list({ query }: RouteInput<{ query: typeof UserSearchQuerySchema }>) {
    return this.userService.list(query.search);
  }

  @Get('/:id')
  @Summary('Find user by id')
  @Description('Returns a single user by id or raises a domain error handled by a route filter.')
  @OperationId('users.findById')
  @UseParamSchema(UserIdParamSchema)
  @UseFilters(UserNotFoundFilter)
  @ApiResponse(200, UserSchema, 'User detail')
  @ApiResponse(404, ErrorSchema, 'User was not found')
  findById({ params }: RouteInput<{ params: typeof UserIdParamSchema }>) {
    return this.userService.requireById(params.id);
  }

  @Post('/')
  @Summary('Create user')
  @Description('Creates a new user. This endpoint is protected by an API key guard.')
  @OperationId('users.create')
  @Security('apiKeyAuth')
  @UseBodySchema(CreateUserSchema)
  @UseGuards(ApiKeyGuard)
  @ApiResponse(201, UserSchema, 'Created user')
  @ApiResponse(409, ErrorSchema, 'User email conflict')
  create({ body, context }: RouteInput<{ body: typeof CreateUserSchema }>) {
    getRequestLogger(context).info('users.create.requested', { email: body.email });
    const created = this.userService.create(body);
    return context.json(created, { status: 201 });
  }

  @Put('/:id')
  @Summary('Replace user')
  @Description('Replaces a user with a full payload. Fails when the id is missing or the email is already used by another user.')
  @OperationId('users.replace')
  @Security('apiKeyAuth')
  @UseParamSchema(UserIdParamSchema)
  @UseBodySchema(ReplaceUserSchema)
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @ApiResponse(200, UserSchema, 'Replaced user')
  @ApiResponse(404, ErrorSchema, 'User was not found')
  @ApiResponse(409, ErrorSchema, 'User email conflict')
  replace({ params, body, context }: RouteInput<{ params: typeof UserIdParamSchema; body: typeof ReplaceUserSchema }>) {
    getRequestLogger(context).info('users.replace.requested', { id: params.id, email: body.email });
    return this.userService.replace(params.id, body);
  }

  @Patch('/:id')
  @Summary('Patch user')
  @Description('Updates selected user fields. Fails when the id is missing or the email is already used by another user.')
  @OperationId('users.patch')
  @Security('apiKeyAuth')
  @UseParamSchema(UserIdParamSchema)
  @UseBodySchema(PatchUserSchema)
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @ApiResponse(200, UserSchema, 'Patched user')
  @ApiResponse(404, ErrorSchema, 'User was not found')
  @ApiResponse(409, ErrorSchema, 'User email conflict')
  patch({ params, body, context }: RouteInput<{ params: typeof UserIdParamSchema; body: typeof PatchUserSchema }>) {
    getRequestLogger(context).info('users.patch.requested', { id: params.id, email: body.email ?? null });
    return this.userService.patch(params.id, body);
  }

  @Put('/:id/avatar')
  @Summary('Upload avatar')
  @Description('Uploads a PNG or JPEG avatar (max 1 MiB) as multipart/form-data.')
  @OperationId('users.uploadAvatar')
  @Security('apiKeyAuth')
  @Consumes('multipart/form-data')
  @UseParamSchema(UserIdParamSchema)
  @UseBodySchema(AvatarUploadSchema)
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @ApiResponse(200, AvatarSchema, 'Stored avatar')
  @ApiResponse(404, ErrorSchema, 'User was not found')
  @ApiResponse(415, ErrorSchema, 'Body was not multipart/form-data')
  uploadAvatar({ params, body }: RouteInput<{ params: typeof UserIdParamSchema; body: typeof AvatarUploadSchema }>) {
    this.userService.requireById(params.id);
    return { userId: params.id, filename: body.avatar.name, type: body.avatar.type, size: body.avatar.size, alt: body.alt ?? null };
  }

  @Delete('/:id')
  @Summary('Delete user')
  @Description('Deletes a user by id and returns no content when successful.')
  @OperationId('users.delete')
  @Security('apiKeyAuth')
  @UseParamSchema(UserIdParamSchema)
  @UseGuards(ApiKeyGuard)
  @UseFilters(UserNotFoundFilter)
  @ApiResponse(204, 'User deleted')
  @ApiResponse(404, ErrorSchema, 'User was not found')
  delete({ params, context }: RouteInput<{ params: typeof UserIdParamSchema }>) {
    getRequestLogger(context).info('users.delete.requested', { id: params.id });
    this.userService.remove(params.id);
    return context.noContent();
  }
}
