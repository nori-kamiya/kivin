import { defineApplication, defineModule, setInjectableMetadata } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { REQUEST_TRACE, RequestScopedController, RequestScopedFilter, RequestScopedGuard, RequestScopedMiddleware, SingletonController } from './controllers';

setInjectableMetadata(RequestScopedGuard, { deps: [REQUEST_TRACE] });
setInjectableMetadata(RequestScopedMiddleware, { deps: [REQUEST_TRACE] });
setInjectableMetadata(RequestScopedFilter, { deps: [REQUEST_TRACE] });
setInjectableMetadata(RequestScopedController, { deps: [REQUEST_TRACE] });

const appDefinition = defineApplication({
  modules: [
    defineModule({
      providers: [
        { provide: RequestScopedGuard, scope: 'request', useClass: RequestScopedGuard },
        { provide: RequestScopedMiddleware, scope: 'request', useClass: RequestScopedMiddleware },
        { provide: RequestScopedFilter, scope: 'request', useClass: RequestScopedFilter },
        { provide: RequestScopedController, scope: 'request', useClass: RequestScopedController },
        {
          provide: REQUEST_TRACE,
          scope: 'request',
          useFactory: () => ({ requestId: 'fixture' }),
        },
      ],
      controllers: [SingletonController, RequestScopedController],
      imports: [],
    }),
  ],
  schemaAdapter: createValibotAdapter(),
});

export default appDefinition;