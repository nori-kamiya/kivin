import { createApp } from '@kivin/core';
import { createDocsHtml } from '@kivin/openapi';
import manifest from '../.kivin/generated/manifest';
import openApiDocument from '../.kivin/generated/openapi.json';
import appDefinition from './app';

const port = Number(process.env.PORT ?? 3000);
const app = createApp(appDefinition, manifest);
const docsHtml = createDocsHtml('/openapi.json');

Bun.serve({
  port,
  fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === '/openapi.json') {
      return new Response(JSON.stringify(openApiDocument, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname === '/docs') {
      return new Response(docsHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return app.fetch(request);
  },
});

console.log(`kivin example is listening on http://localhost:${port}`);
