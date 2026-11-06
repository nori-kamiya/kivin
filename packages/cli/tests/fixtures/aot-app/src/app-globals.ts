import { defineApplication } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import { AotModule } from './modules';
import { MissingFilter, RawKeyGuard, TraceMiddleware } from './providers';

export default defineApplication({
  modules: [AotModule],
  schemaAdapter: createValibotAdapter(),
  globals: { guards: [RawKeyGuard], middleware: [TraceMiddleware], filters: [MissingFilter] },
});
