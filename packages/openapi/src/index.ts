import type { AppManifest, AppOpenApiConfig, SchemaAdapter } from '@kivinjs/core';

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
    const openApiPath = toOpenApiPath(route.fullPath);
    const pathItem = (paths[openApiPath] ??= {});
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
        ...withTemplateParameters(openApiPath, buildParameters('path', route.docs.paramSchema, input.schemaAdapter)),
        ...buildParameters('query', route.docs.querySchema, input.schemaAdapter),
        ...buildParameters('header', route.docs.headerSchema, input.schemaAdapter),
      ],
      security: routeSecurity.length > 0
        ? routeSecurity.map((entry) => ({ [entry.scheme]: entry.scopes }))
        : undefined,
      requestBody: route.docs.bodySchema
        ? {
            required: true,
            content: requestBodyContent(route.docs.consumes, input.schemaAdapter.toOpenApiSchema(route.docs.bodySchema)),
          }
        : undefined,
      // An operation needs at least one response; routes without @ApiResponse document a plain 200.
      responses: route.docs.responses.length === 0 ? { '200': { description: 'Success' } } : Object.fromEntries(
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

/**
 * OpenAPI path template for a route path: `:id` parameters become `{id}` (OpenAPI path templating;
 * Swagger UI, generators and validators do not understand `:id`) and a trailing slash is dropped,
 * as the router serves `/users/` and `/users` alike.
 */
export function toOpenApiPath(path: string) {
  const templated = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return templated.length > 1 && templated.endsWith('/') ? templated.slice(0, -1) : templated;
}

/**
 * Every `{name}` in the path must be declared as a path parameter (OpenAPI requires it). Parameters
 * the route's param schema does not describe are added as required strings.
 */
function withTemplateParameters(path: string, declared: Array<{ in: string; name: string; required: boolean; schema: Record<string, unknown> }>) {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  const missing = names.filter((name) => !declared.some((parameter) => parameter.name === name));
  return [...declared, ...missing.map((name) => ({ in: 'path', name, required: true, schema: { type: 'string' } }))];
}

/** Request body content for the route's `@Consumes` media type (JSON when unset). */
function requestBodyContent(consumes: string | undefined, schema: Record<string, unknown>) {
  return { [consumes ?? 'application/json']: { schema } };
}

function buildParameters<TSchema>(
  location: 'path' | 'query' | 'header',
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
