import type { AppManifest, AppOpenApiConfig, SchemaAdapter } from '@kivin/core';

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export function buildOpenApiDocument<TSchema>(input: {
  manifest: AppManifest<TSchema>;
  schemaAdapter: SchemaAdapter<TSchema>;
  info: OpenApiInfo;
  config?: AppOpenApiConfig;
}) {
  const tagMap = new Map<string, { name: string; description?: string }>();
  const paths: Record<string, Record<string, unknown>> = {};

  for (const tag of input.config?.tags ?? []) {
    tagMap.set(tag.name, tag);
  }

  for (const route of input.manifest.routes) {
    const pathItem = (paths[route.fullPath] ??= {});
    const routeTags = route.docs.tags.length > 0 ? route.docs.tags : ['default'];
    const routeSecurity = route.docs.security ?? [];
    routeTags.forEach((tag) => {
      if (!tagMap.has(tag)) {
        tagMap.set(tag, { name: tag });
      }
    });

    pathItem[route.method.toLowerCase()] = {
      tags: routeTags,
      summary: route.docs.summary,
      description: route.docs.description,
      operationId: route.docs.operationId,
      parameters: [
        ...buildParameters('path', route.docs.paramSchema, input.schemaAdapter),
        ...buildParameters('query', route.docs.querySchema, input.schemaAdapter),
      ],
      security: routeSecurity.length > 0
        ? routeSecurity.map((entry) => ({ [entry.scheme]: entry.scopes }))
        : undefined,
      requestBody: route.docs.bodySchema
        ? {
            required: true,
            content: {
              'application/json': {
                schema: input.schemaAdapter.toOpenApiSchema(route.docs.bodySchema),
              },
            },
          }
        : undefined,
      responses: Object.fromEntries(
        route.docs.responses.map((response) => [
          String(response.status),
          {
            description: response.description || 'Response',
            content: response.schema
              ? {
                  'application/json': {
                    schema: input.schemaAdapter.toOpenApiSchema(response.schema),
                  },
                }
              : undefined,
          },
        ]),
      ),
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      ...input.info,
      ...(input.config?.contact ? { contact: input.config.contact } : {}),
      ...(input.config?.license ? { license: input.config.license } : {}),
    },
    ...(input.config?.servers ? { servers: input.config.servers } : {}),
    ...(input.config?.security ? {
      security: input.config.security.map((entry) => ({ [entry.scheme]: entry.scopes })),
    } : {}),
    tags: [...tagMap.values()],
    ...(input.config?.securitySchemes || input.config?.examples
      ? {
          components: {
            ...(input.config?.securitySchemes ? { securitySchemes: input.config.securitySchemes } : {}),
            ...(input.config?.examples ? { examples: input.config.examples } : {}),
          },
        }
      : {}),
    paths,
  };
}

function buildParameters<TSchema>(
  location: 'path' | 'query',
  schema: TSchema | undefined,
  schemaAdapter: SchemaAdapter<TSchema>,
) {
  if (!schema) {
    return [];
  }

  const jsonSchema = schemaAdapter.toOpenApiSchema(schema);
  const properties = isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
  const required = Array.isArray(jsonSchema.required) ? new Set(jsonSchema.required.filter((item): item is string => typeof item === 'string')) : new Set<string>();

  return Object.entries(properties).map(([name, value]) => ({
    in: location,
    name,
    required: location === 'path' ? true : required.has(name),
    schema: isRecord(value) ? value : {},
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createDocsHtml(openApiUrl = '/openapi.json') {
  const safeUrl = JSON.stringify(openApiUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>kivin docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.20.0/swagger-ui.css" crossorigin="anonymous" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.20.0/swagger-ui-bundle.js" crossorigin="anonymous"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${safeUrl},
        dom_id: '#swagger-ui'
      });
    </script>
  </body>
</html>`;
}
