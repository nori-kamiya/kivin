# kivin

*[日本語版 README](README.ja.md)*

A lightweight, Fetch API based web framework built for Bun single-binary deployment. It is early-stage (`v0.0.1`), so the API may still change before a stable release.

Goals:

- A thin runtime core, like Hono
- NestJS-style module / controller / service structure
- Valibot (or any Standard Schema validator) and OpenAPI connected by build-time generation

> **Requirements:** [Bun](https://bun.sh) **1.4.0 or later** (declared in `engines.bun`; older Bun fails). kivin is Bun-only and does not run on Node.

## Install

```bash
bun add @kivin/core @kivin/decorators @kivin/valibot valibot
bun add -d @kivin/cli @types/bun typescript
```

`@kivin/cli` must be installed in your project as a dev dependency (not only run from elsewhere): it generates the route manifest by loading your app against the `@kivin/core` your project installed. Packages that plug into the core (`@kivin/security`, `@kivin/http`, ...) list `@kivin/core` as a peer dependency; install them with `bun add` the same way. Zod, ArkType and other Standard Schema validators use `@kivin/standard-schema` instead of `@kivin/valibot` ([docs/schema-adapter.md](docs/schema-adapter.md), Japanese).

To scaffold a project instead of wiring it by hand:

```bash
bunx --package @kivin/cli kivin init my-app
```

(Use the scoped `--package @kivin/cli` form. The unscoped npm name `kivin` is not this project.)

### TypeScript setup

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],          // no DOM lib needed
    "types": ["bun"],           // required: kivin's declarations use Bun's types
    "strict": true,
    "noEmit": true
  },
  // include the generated files so `tsc` checks handler/schema contracts
  "include": ["*.ts", ".kivin/generated/**/*.ts", ".kivin/generated/**/*.json"]
}
```

kivin uses TC39 standard decorators (the TypeScript 5+ default). Do **not** enable `experimentalDecorators`.

## Quick start

The smallest app is a controller, a module and an application.

```ts
// app.ts
import { defineApplication, defineModule } from '@kivin/core';
import { Controller, Get } from '@kivin/decorators';
import { createValibotAdapter } from '@kivin/valibot';

@Controller('/hello')
export class HelloController {
  @Get('/')
  hello() {
    return { message: 'hello kivin' };
  }
}

const HelloModule = defineModule({
  controllers: [HelloController],
  providers: [],
  imports: [],
});

export default defineApplication({
  modules: [HelloModule],
  schemaAdapter: createValibotAdapter(),
});
```

`schemaAdapter` is required.

```ts
// main.ts
import { createApp } from '@kivin/core';
import manifest from './.kivin/generated/manifest';
import appDefinition from './app';

const app = createApp(appDefinition, manifest);

// Every manifest route is mounted as a Bun.serve native route
app.listen(3000);
```

Add scripts to `package.json` (the `kivin` binary comes from the local `@kivin/cli`):

```json
{
  "scripts": {
    "generate": "kivin generate --entry app.ts --outDir .kivin/generated",
    "dev": "kivin dev --entry app.ts --outDir .kivin/generated --main main.ts",
    "build": "kivin generate --entry app.ts --outDir .kivin/generated && bun build main.ts --compile --outfile server",
    "typecheck": "tsc"
  }
}
```

```bash
bun run generate      # writes manifest.ts / contracts.ts / client.ts / openapi.json into .kivin/generated
bun run main.ts       # run from the generated manifest
curl localhost:3000/hello/
```

Static routes such as `openapi.json` or a docs page can be mounted as native routes too:

```ts
import openApiDocument from './.kivin/generated/openapi.json';

app.listen({
  port: 3000,
  routes: {
    '/openapi.json': Response.json(openApiDocument),
  },
});
```

For a single binary, keep the generated manifest as a static import and run `bun build main.ts --compile --outfile server` (no runtime scan). Do not name the output `app`: `./app` would then shadow `app.ts`.

`examples/basic` in this repository is a complete app, but it uses the monorepo's workspace links and cannot be copied out as is.

### What `generate` does and does not do

- `kivin generate` analyses the source (AST) for decorators, **and it imports your entry file and everything it imports**. Top-level side effects therefore run at build time: reading required environment variables, opening connections and similar code in modules reachable from `app.ts` will fail a CI/Docker build that has no secrets. Validate the environment through DI (`envProvider` from `@kivin/config`) or in `main.ts` ([docs/production.md](docs/production.md), Japanese).
- Schemas, guards and middleware passed to decorators must be **exported** or written inline. A `const IdSchema = ...` that is not exported fails generation.
- If generation fails, the previous contents of `--outDir` are left untouched.

## Dev mode

```bash
bun run dev
```

Every time you save, the manifest / contracts / client are regenerated and the server restarts. If generation fails (a half-typed syntax error, say), the previous server keeps running. `--watch <dir>` adds directories to watch.

## Typed client

`generate` also writes `client.ts`: a typed HTTP client derived from your schemas and handler types. It only references server code through `import type`, so it can be bundled into a frontend as is.

```ts
import { createClient, KivinClientError } from './.kivin/generated/client';

const api = createClient({
  baseUrl: 'https://api.example.com',
  headers: () => ({ authorization: `Bearer ${token}` }),
});

const users = await api.users.list({ query: { search: 'ada' } });
const user = await api.users.findById({ params: { id: '1' } });
await api.users.create({ body: { name: 'Ada', email: 'ada@example.com' } }); // body is type-checked
```

- A method named after `@OperationId('users.list')` becomes `client.users.list` (otherwise controller and method names are used).
- Input types come from the query / param / body schemas; output types from the 2xx response schema. Routes without schemas use the handler's parameter and return types (`unknown` when the handler returns a `Response`).
- Non-2xx responses throw `KivinClientError` (with `status` and the parsed `body`).
- Pass `app.fetch` as the `fetch` option to call the app from tests without starting a server.

## Handlers and decorators

kivin uses TC39 standard decorators, which have no parameter decorators, so a handler receives one input object. Destructure only the fields you use and kivin computes only those per request.

```ts
import * as v from 'valibot';
import type { RouteInput } from '@kivin/core';
import { Controller, Get, Post, UseBodySchema, UseParamSchema } from '@kivin/decorators';

export const UserIdParamSchema = v.object({ id: v.string() });
export const CreateUserSchema = v.object({ name: v.string(), email: v.pipe(v.string(), v.email()) });

@Controller('/users')
export class UserController {
  @Get('/:id')
  @UseParamSchema(UserIdParamSchema)
  findById({ params }: RouteInput<{ params: typeof UserIdParamSchema }>) {
    return { id: params.id }; // params.id is typed as the schema's output
  }

  @Post('/')
  @UseBodySchema(CreateUserSchema)
  create({ body, context }: RouteInput<{ body: typeof CreateUserSchema }>) {
    return context.json({ id: '1', ...body }, { status: 201 });
  }
}
```

The fields are `params`, `query`, `body`, `headers` and `context` (five). Without a schema, `params` is a string record, `query` is a record of `string | string[] | undefined` (repeated keys become arrays), and `body` is `unknown`.

## Compile-time contracts

Decorators cannot change types, so the schema and the handler's input type are written separately. kivin catches a mismatch at build time:

- `kivin generate` also writes `contracts.ts`. With `.kivin/generated/**/*.ts` in your `tsconfig` `include`, `tsc` fails when
  - a handler's input type (`RouteInput<{ params; query; body; headers }>`) disagrees with the route's `@UseParamSchema` / `@UseQuerySchema` / `@UseBodySchema` / `@UseHeaderSchema`, or
  - a handler's return value disagrees with the declared 2xx response schema (not checked when the handler returns a `Response`).
- `@Injectable({ deps })` is typed: the order, types and count of `deps` must match the constructor, or compilation fails. Use `createToken<T>('key')` for typed symbol tokens.

```text
contracts.ts: Type '{ contractError: "UserController.findById: the handler input type does not match the route's @UseParamSchema / @UseQuerySchema / @UseBodySchema / @UseHeaderSchema"; ... }' does not satisfy the constraint 'true'.
```

Types come from Standard Schema type info, so this works with validators other than Valibot.

## Features

- AST-based route manifest generation, tsconfig path alias resolution, ahead-of-time route executors (`--no-aot` / `KIVIN_AOT=0` to opt out)
- Valibot and Standard Schema (Zod, ArkType, ...) validation; OpenAPI 3.1 generation (`operationId`, descriptions, security schemes)
- Generated typed HTTP client; compile-time route and DI contract checks
- CORS, cookies (signed cookies too), WebSocket, Server-Sent Events, multipart forms, per-route body limits
- Guards, middleware and exception filters (global and per route); `HttpError` helpers; graceful shutdown; `createTestingApp` with provider overrides
- Opt-in middleware packages: auth guards (Basic / Bearer / JWT with JWKS), CSRF, secure headers (`createSecureHeadersMiddleware`, **not enabled by default**), rate limiting, IP allow / deny lists, compression, ETag, timeouts, request IDs, content negotiation, streaming, reverse proxy, static files, sessions, metrics / tracing / health checks, typed env vars, cron jobs, GraphQL Yoga mounting
- Bun single binary builds (`bun build --compile`)

## Packages

Every package requires Bun 1.4.0 or later. Details: [docs/reference.md](docs/reference.md) (Japanese).

| Package | Purpose |
| --- | --- |
| `@kivin/core` | Router, DI, modules, lifecycle, input validation, cookies / SSE / WebSocket: the runtime core |
| `@kivin/decorators` | Module / Controller / Route / Enhancer / OpenAPI decorators |
| `@kivin/valibot` | Valibot schema adapter |
| `@kivin/standard-schema` | Standard Schema adapter (Zod, ArkType, Valibot, ...) |
| `@kivin/cli` | Code generation CLI (`generate`, `dev`, `openapi`, `inspect`) |
| `@kivin/openapi` | OpenAPI 3.1 document generation |
| `@kivin/security` | Basic / Bearer guards, CSRF, secure headers, rate limiting, IP restriction |
| `@kivin/jwt` | JWT verification / signing (Web Crypto), JWKS, auth guard |
| `@kivin/http` | Compression, ETag, timeout, request ID, content negotiation, streaming, pretty JSON, method override, trailing slash |
| `@kivin/static` | Static file serving (`serveStatic`) |
| `@kivin/session` | Server-side sessions (signed cookie, pluggable stores) |
| `@kivin/logger` | JSON-line logger and request logger middleware |
| `@kivin/observability` | OpenTelemetry tracing, Prometheus metrics, Server-Timing, health checks |
| `@kivin/config` | Typed, validated environment variables |
| `@kivin/schedule` | Cron jobs tied to the application lifecycle |
| `@kivin/graphql` | Mount GraphQL Yoga |

## Performance

In paired CI measurements (compiled binaries, `bun run perf:check`), kivin was 101% to 134% of Hono's throughput on app-like workloads and 97% to 109% of Elysia's, with several confidence intervals crossing 100%. See "Latest paired comparison" in [docs/performance.md](docs/performance.md). Numbers depend on environment and version; measure on your own.

## Documents

The documents below are in Japanese.

- [docs/reference.md](docs/reference.md): API reference
- [docs/production.md](docs/production.md): CORS / cookies / auth / security / streaming / observability / env vars / cron / sessions / GraphQL / WebSocket / SSE / multipart / graceful shutdown / testing
- [docs/architecture.md](docs/architecture.md)
- [docs/pipeline.md](docs/pipeline.md): request flow
- [docs/ast-generator.md](docs/ast-generator.md)
- [docs/schema-adapter.md](docs/schema-adapter.md)
- [docs/openapi-flow.md](docs/openapi-flow.md)
- [docs/bun-compile.md](docs/bun-compile.md)
- [docs/decorators-roadmap.md](docs/decorators-roadmap.md): the move to TC39 decorators
- [docs/performance.md](docs/performance.md)

The [CHANGELOG](CHANGELOG.md) is written in Japanese.

## Contributing

Working on kivin itself (clone, then `bun install`):

```bash
bun run generate
bun run check           # generate + tsc -b
bun test
bun run example:smoke   # compile examples/basic into a binary and exercise it
bun run release:check   # check + test + example:smoke: the gate before merging
```

See [docs/development-guide.md](docs/development-guide.md), [docs/testing.md](docs/testing.md) and the maintainer notes in [docs/handoff.md](docs/handoff.md) (all Japanese).

## License

[MIT](LICENSE) © nori-kamiya
