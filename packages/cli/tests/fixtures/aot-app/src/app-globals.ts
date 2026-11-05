import { defineApplication } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';
import { AotModule } from './modules';
import { MissingFilter, RawKeyGuard, TraceMiddleware } from './providers';

export default defineApplication({
  modules: [AotModule],
  schemaAdapter: createValibotAdapter(),
  globals: { guards: [RawKeyGuard], middleware: [TraceMiddleware], filters: [MissingFilter] },
});
