// Benchmark app source. `scripts/perf-regression.ts` runs each tree's own `kivin generate` on it, so
// the benchmark measures what users get from that version of the CLI and runtime.
import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { HealthController, ScopedController, UsersController } from './controllers';
import { ApiKeyGuard, requestStampProvider, RequestIdMiddleware, UserNotFoundFilter, UserStore } from './providers';

const BenchModule = defineModule({
  providers: [UserStore, ApiKeyGuard, RequestIdMiddleware, UserNotFoundFilter, requestStampProvider],
  controllers: [HealthController, UsersController, ScopedController],
  imports: [],
});

export default defineApplication({
  modules: [BenchModule],
  schemaAdapter: createValibotAdapter(),
});
