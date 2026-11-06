# kivin

Bun single-binary deployment を前提にした、軽量な Fetch API ベースの Web フレームワークです。現在は early-stage (`v0.0.1`) で、API は安定版に向けて変わる可能性があります。

狙いは次の 3 点です。

- Hono のように薄い実行時コア
- NestJS のような module / controller / service の構造化
- Valibot と OpenAPI をビルド時生成でつなぐ

## Current features

- AST-based route manifest generation
- tsconfig path alias resolution for module graph traversal
- generated import alias collision avoidance
- Valibot schema validation
- Standard Schema adapter (Zod, ArkType, Valibot, ...)
- compile-time route / DI contract checks (`contracts.ts`, typed `@Injectable` deps)
- generated typed HTTP client (`client.ts`)
- `kivin dev` watch mode (regenerate + restart)
- ahead-of-time route executors generated into the manifest (`--no-aot` / `KIVIN_AOT=0` to opt out)
- CORS, cookies, JWT auth guard with JWKS (`@kivin/jwt`), WebSocket, Server-Sent Events, multipart forms
- per-route request body limits (`@BodyLimit`, 413)
- request timeout and in-memory rate limiting middleware
- response compression (brotli / gzip) and ETag / 304 middleware
- static file serving (`serveStatic`: ETag / 304, Range, precompressed, SPA fallback)
- Basic / Bearer auth guards and CSRF protection (Sec-Fetch-Site / Origin)
- graceful shutdown with `onApplicationShutdown` hooks, `createTestingApp` with provider overrides
- OpenAPI 3.1 generation
- `operationId`, route description, and security scheme support
- standardized `HttpError` helpers and `204 No Content` responses
- default secure-headers middleware for production-facing APIs
- configurable secure-headers middleware via `createSecureHeadersMiddleware(...)` (`@kivin/security`)
- mutation route support for `PUT`, `PATCH`, and `DELETE`
- global / route guards
- global / route middleware
- global / route exception filters
- Bun single binary build

## Packages

- `@kivin/core`: ルータ、DI、モジュール、ライフサイクル、入力検証、Cookie / SSE / WebSocket などアプリ実行時の中核
- `@kivin/security`: Basic / Bearer 認証ガード、CSRF、secure headers、レートリミット、IP 制限
- `@kivin/http`: 圧縮、ETag、タイムアウト、リクエスト ID、コンテンツネゴシエーション
- `@kivin/static`: 静的ファイル配信（`serveStatic`）
- `@kivin/decorators`: Module / Controller / Route / Parameter decorators
- `@kivin/logger`: JSON line の構造化ロガーと request logger middleware
- `@kivin/openapi`: OpenAPI ドキュメント生成
- `@kivin/valibot`: Valibot schema adapter
- `@kivin/standard-schema`: Standard Schema adapter（Zod / ArkType / Valibot など）
- `@kivin/jwt`: JWT の検証・署名（Web Crypto）と認証 guard
- `@kivin/cli`: manifest と OpenAPI のコード生成 CLI

## Quick start

> 前提: [Bun](https://bun.sh) 1.3 以上。現状はモノレポとして利用する形を想定しています（npm 配布は未対応）。リポジトリを clone して `bun install` してください。

最小構成は controller・module・application の 3 つです。

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

`schemaAdapter` は必須です。Zod や ArkType など Standard Schema 対応の validator を使う場合は `@kivin/standard-schema` の `createStandardSchemaAdapter()` を渡します（[docs/schema-adapter.md](docs/schema-adapter.md)）。

ルートグラフと OpenAPI をビルド時に生成し、生成 manifest から実行します。

```bash
# manifest.ts / contracts.ts / client.ts / openapi.json を生成
bun run packages/cli/src/bin.ts generate --entry app.ts --outDir .kivin/generated

# 生成 manifest を使ってアプリを起動
bun run main.ts
```

```ts
// main.ts
import { createApp } from '@kivin/core';
import manifest from './.kivin/generated/manifest';
import appDefinition from './app';

const app = createApp(appDefinition, manifest);

// manifest のルートはすべて Bun.serve の native routes に載ります
app.listen(3000);
```

`openapi.json` や docs ページのような静的ルートも native routes として一緒に載せられます。

```ts
app.listen({
  port: 3000,
  routes: {
    '/openapi.json': Response.json(openApiDocument),
  },
});
```

single binary にするには generated manifest を静的 import したまま `bun build --compile` します（runtime scan 不要）。動く完全な例は [`examples/basic`](examples/basic) を参照してください。

## Dev mode

```bash
bun run packages/cli/src/bin.ts dev --entry app.ts --outDir .kivin/generated --main main.ts
```

ソースを保存するたびに manifest / contracts / client を再生成してサーバーを再起動します。生成に失敗した場合（書きかけの構文エラーなど）は直前のサーバーを動かしたままにするので、編集中にアプリが落ちることはありません。`--watch <dir>` で監視対象を追加できます。

## Typed client

`generate` は `client.ts` も出力します。schema とハンドラの型から作られた型付き HTTP クライアントで、サーバー側のコードは `import type` でしか参照しないため、そのままフロントエンドにバンドルできます。

```ts
import { createClient, KivinClientError } from './.kivin/generated/client';

const api = createClient({
  baseUrl: 'https://api.example.com',
  headers: () => ({ authorization: `Bearer ${token}` }),
});

const users = await api.users.list({ query: { search: 'ada' } }); // 型は UserListSchema の出力
const user = await api.users.findById({ params: { id: '1' } });
await api.users.create({ body: { name: 'Ada', email: 'ada@example.com' } }); // body の型を検査
```

- メソッドは `@OperationId('users.list')` から `client.users.list` になります（無い場合はコントローラ名とメソッド名）。
- 入力の型は query / param / body の schema 入力、出力の型は 2xx レスポンス schema の出力から取ります。schema が無いルートはハンドラの引数・戻り値の型を使います（`Response` を直接返すルートは `unknown`）。
- 2xx 以外は `KivinClientError`（`status` とパース済みの `body` を持つ）を投げます。
- `fetch` オプションに `app.fetch` を渡すと、サーバーを立てずにテストからそのまま呼べます。

## Handlers and decorators

kivin は TC39 標準デコレータ（TypeScript 5+ の既定、`experimentalDecorators` 不要）を使います。標準には引数デコレータが無いので、ハンドラは 1 つの入力オブジェクトを受け取ります。使うフィールドだけを分割代入すると、kivin はリクエストごとにそのフィールドだけを計算します。

```ts
import type { RouteInput } from '@kivin/core';

@Controller('/users')
export class UserController {
  @Get('/:id')
  @UseParamSchema(UserIdParamSchema)
  findById({ params }: RouteInput<{ params: typeof UserIdParamSchema }>) {
    return this.users.find(params.id); // schema の出力型
  }

  @Post('/')
  @UseBodySchema(CreateUserSchema)
  create({ body, context }: RouteInput<{ body: typeof CreateUserSchema }>) {
    return context.json(this.users.create(body), { status: 201 });
  }
}
```

フィールドは `params` / `query` / `body` / `context` の 4 つです。schema を宣言していない場合、`params` と `query` は文字列のレコード、`body` は `unknown` になります。

## Compile-time contracts

decorator は型を変えられないため、schema とハンドラの入力型は別々に書くことになります。kivin はそのズレをビルド時に検出します。

- `kivin generate` は `contracts.ts` も出力します。`tsconfig` に `.kivin/generated/**/*.ts` を含めておくと、`tsc` が次の不一致をエラーにします。
  - ハンドラの入力型（`RouteInput<{ params; query; body; headers }>`）と、ルートの `@UseParamSchema` / `@UseQuerySchema` / `@UseBodySchema` / `@UseHeaderSchema`
  - ハンドラの戻り値と、宣言された 2xx レスポンス schema（`Response` を直接返す場合は対象外）
- `@Injectable({ deps })` は型付きで、deps の並び・型・個数がコンストラクタ引数と合わないとコンパイルエラーになります。シンボルのトークンに型を付けたい場合は `createToken<T>('key')` を使います。

```text
contracts.ts: Type '{ contractError: "UserController.findById: the handler input type does not match the route's @UseParamSchema / @UseQuerySchema / @UseBodySchema / @UseHeaderSchema"; ... }' does not satisfy the constraint 'true'.
```

型は Standard Schema の型情報から取るので、Valibot 以外の validator でも同じように効きます。

## Workflow

```bash
bun install
bun run generate
bun run check
bun test
bun run example:dev
bun run example:build
bun run example:smoke
bun run inspect:routes
bun run inspect:modules
bun run bench
```

`bun run generate` は TypeScript source を AST 解析して次を生成します。

- `examples/basic/.kivin/generated/manifest.ts`
- `examples/basic/.kivin/generated/contracts.ts`
- `examples/basic/.kivin/generated/client.ts`
- `examples/basic/.kivin/generated/openapi.json`

`bun run example:build` は generated manifest を静的 import したまま `bun build --compile` を実行します。runtime scan は不要です。

`bun run example:smoke` は compiled binary を起動して list/create/update/patch/delete、`/openapi.json`、`HEAD` / `OPTIONS` を実際に検証します。

`bun run bench` は compiled binary の `kivin` / `hono` / `elysia` を同一 workload で比較し、startup、binary size、GET/PATCH の throughput と latency を出します。

full stack の順位を更新したい時は `BENCH_ITERATIONS=10 bun run bench:stack` を基準にするのが安全です。CI のペア計測（`bun run perf:check`、2026-11）では、`kivin` は app-like な全 workload で `Hono` を上回り（118〜131%）、`Elysia` とも全 workload で同等以上（100〜114%）です。詳細は [docs/performance.md](docs/performance.md#latest-paired-comparison-ci-2026-11-06)。数値は環境・バージョンに依存するため、各自の環境で再計測することを推奨します。

`bun run inspect:routes` は route ごとの handler に加えて controller scope、guard/middleware/filter の scope、executor mode (`native-static` / `singleton-runtime` / `context-runtime` / `request-runtime`) も表示します。

`bun run inspect:modules` は provider scope に加えて controller scope と app-global guard/middleware/filter wiring も表示します。

## Documents

- [docs/reference.md](docs/reference.md) — API reference
- [docs/production.md](docs/production.md) — CORS / Cookie / JWT / WebSocket / SSE / multipart / graceful shutdown / テスト
- [docs/decorators-roadmap.md](docs/decorators-roadmap.md) — レガシー / TC39 デコレータの調査と移行方針
- [docs/architecture.md](docs/architecture.md)
- [docs/development-guide.md](docs/development-guide.md)
- [docs/ast-generator.md](docs/ast-generator.md)
- [docs/performance.md](docs/performance.md)
- [docs/pipeline.md](docs/pipeline.md)
- [docs/schema-adapter.md](docs/schema-adapter.md)
- [docs/openapi-flow.md](docs/openapi-flow.md)
- [docs/bun-compile.md](docs/bun-compile.md)
- [docs/testing.md](docs/testing.md)

変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。

## License

[MIT](LICENSE) © nori-kamiya
