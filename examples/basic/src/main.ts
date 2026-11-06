import { createApp } from '@kivinjs/core';
import { createDocsHtml } from '@kivinjs/openapi';
import manifest from '../.kivin/generated/manifest';
import openApiDocument from '../.kivin/generated/openapi.json';
import appDefinition from './app';

const port = Number(process.env.PORT ?? 3000);
const app = createApp(appDefinition, manifest);

// Every app route and the two static docs routes go into Bun's native route table.
app.listen({
  port,
  routes: {
    '/openapi.json': Response.json(openApiDocument),
    '/docs': new Response(createDocsHtml('/openapi.json'), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  },
});

console.log(`kivin example is listening on http://localhost:${port}`);
