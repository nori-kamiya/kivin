import { Module } from '@kivin/decorators';
import { ApiKeyGuard } from './api-key.guard';
import { RequestIdMiddleware } from './request-id.middleware';
import { UserNotFoundFilter } from './user-not-found.filter';
import { UserController } from './users.controller';
import { UserService } from './users.service';

@Module({
  providers: [UserService, ApiKeyGuard, RequestIdMiddleware, UserNotFoundFilter],
  controllers: [UserController],
})
export class UsersModule {}
