import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { ContractController } from './controller';

const ContractModule = defineModule({
  providers: [],
  controllers: [ContractController],
  imports: [],
});

const appDefinition = defineApplication({
  modules: [ContractModule],
  schemaAdapter: createValibotAdapter(),
  openApi: {
    tags: [
      {
        name: 'Contracts',
        description: 'Contract read endpoints.',
      },
      {
        name: 'Mutations',
        description: 'Contract mutation endpoints.',
      },
    ],
    security: [
      {
        scheme: 'bearerAuth',
        scopes: ['contracts:read'],
      },
    ],
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    },
  },
});

export default appDefinition;
export { appDefinition };
