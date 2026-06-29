import type { RequestContext } from '@kivin/core';
import {
    ApiResponse,
    Body,
    Context,
    Controller,
    Delete,
    Description,
    Get,
    Injectable,
    OperationId,
    Patch,
    PathParam,
    Post,
    Put,
    QueryParam,
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
    CreateUserSchema,
    ErrorSchema,
    PatchUserSchema,
    ReplaceUserSchema,
    UserIdParamSchema,
    UserListSchema,
    UserSchema,
    UserSearchQuerySchema,
    type CreateUserInput,
    type PatchUserInput,
    type ReplaceUserInput,
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
  list(@QueryParam('search') search?: string) {
    return this.userService.list(search);
  }

  @Get('/:id')
  @Summary('Find user by id')
  @Description('Returns a single user by id or raises a domain error handled by a route filter.')
  @OperationId('users.findById')
  @UseParamSchema(UserIdParamSchema)
  @UseFilters(UserNotFoundFilter)
  @ApiResponse(200, UserSchema, 'User detail')
  @ApiResponse(404, ErrorSchema, 'User was not found')
  findById(@PathParam('id') id: string) {
    return this.userService.requireById(id);
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
  create(@Body() input: CreateUserInput, @Context() context: RequestContext) {
    getRequestLogger(context).info('users.create.requested', { email: input.email });
    const created = this.userService.create(input);
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
  replace(@PathParam('id') id: string, @Body() input: ReplaceUserInput, @Context() context: RequestContext) {
    getRequestLogger(context).info('users.replace.requested', { id, email: input.email });
    return this.userService.replace(id, input);
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
  patch(@PathParam('id') id: string, @Body() input: PatchUserInput, @Context() context: RequestContext) {
    getRequestLogger(context).info('users.patch.requested', { id, email: input.email ?? null });
    return this.userService.patch(id, input);
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
  delete(@PathParam('id') id: string, @Context() context: RequestContext) {
    getRequestLogger(context).info('users.delete.requested', { id });
    this.userService.remove(id);
    return context.noContent();
  }
}
