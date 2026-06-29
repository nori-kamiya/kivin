import { createSecureHeadersMiddleware, defineApplication, defineModule } from '@kivin/core';
import { createLogger, LOGGER, LOGGER_OPTIONS, RequestLoggerMiddleware } from '@kivin/logger';
import { createValibotAdapter } from '@kivin/valibot';
import { RequestIdMiddleware } from './request-id.middleware';
import { UsersModule } from './users.module';

const AppSecureHeadersMiddleware = createSecureHeadersMiddleware({
  contentSecurityPolicy: "default-src 'self'",
  frameOptions: 'SAMEORIGIN',
});

const LoggerModule = defineModule({
  providers: [
    {
      provide: LOGGER_OPTIONS,
      useValue: {
        serviceName: 'kivin-example-basic',
        level: 'info',
        baseFields: {
          app: 'basic-example',
        },
      },
    },
    {
      provide: LOGGER,
      useFactory: (container) => createLogger(container.resolve(LOGGER_OPTIONS)),
    },
    AppSecureHeadersMiddleware,
    RequestLoggerMiddleware,
  ],
  controllers: [],
  imports: [],
});

const appDefinition = defineApplication({
  modules: [LoggerModule, UsersModule],
  schemaAdapter: createValibotAdapter(),
  globals: {
    guards: [],
    middleware: [AppSecureHeadersMiddleware, RequestIdMiddleware, RequestLoggerMiddleware],
    filters: [],
  },
  openApi: {
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Local development server',
      },
    ],
    contact: {
      name: 'kivin maintainers',
      email: 'kivin@example.com',
      url: 'https://example.com/kivin',
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT',
    },
    tags: [
      {
        name: 'Users',
        description: 'User management endpoints for the example application.',
      },
    ],
    security: [],
    securitySchemes: {
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Static API key used by the example create endpoint.',
      },
    },
    examples: {
      CreateUserExample: {
        summary: 'Create user payload',
        value: {
          name: 'Ada Lovelace',
          email: 'ada@example.com',
        },
      },
    },
  },
});

export default appDefinition;
export { appDefinition };
