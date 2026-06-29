import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { InlineController, InlineSecondController } from './controllers';

const importedModule = defineModule({
  providers: [],
  controllers: [InlineController],
  imports: [],
});

const appDefinition = defineApplication({
  modules: [
    importedModule,
    defineModule({
      providers: [],
      controllers: [InlineSecondController],
      imports: [],
    }),
  ],
  schemaAdapter: createValibotAdapter(),
});

export default appDefinition;
