import { defineModule } from '@kivinjs/core';
import { AotController } from './controller';
import { HeaderMiddleware, MissingFilter, RawKeyGuard, requestIdProvider, RoleGuard, Store, TraceMiddleware } from './providers';

export const AotModule = defineModule({
  providers: [Store, RawKeyGuard, RoleGuard, HeaderMiddleware, TraceMiddleware, MissingFilter, requestIdProvider],
  controllers: [AotController],
  imports: [],
});
