# API Reference

kivin の公開 API を package ごとにまとめたリファレンスです。詳細な設計背景は各専用ドキュメント（[architecture](./architecture.md) ほか）を参照してください。

- [@kivin/core](#kivincore)
- [@kivin/decorators](#kivindecorators)
- [@kivin/valibot](#kivinvalibot)
- [@kivin/openapi](#kivinopenapi)
- [@kivin/logger](#kivinlogger)
- [@kivin/cli](#kivincli)

---

## @kivin/core

ルータ・DI・アプリ実行時コア。

### Application

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createApp(manifest)` | function | コンパイル済み manifest から `fetch` ハンドラを持つアプリを生成する |
| `buildManifest(appDefinition)` | function | アプリ定義から実行時 manifest を組み立てる（通常は生成 manifest 経由で呼ばれる） |
| `defineApplication(input)` | function | アプリ定義（root module / OpenAPI 設定など）を宣言する |
| `defineModule(input)` | function | モジュール（controllers / providers / imports / グローバル enhancer）を宣言する |
| `AppManifest`, `ManifestRoute` | type | 生成 manifest の型 |

### Dependency Injection

| Export | 種別 | 概要 |
| --- | --- | --- |
| `Container` | class | DI コンテナ。request-scoped 解決のための child container を持つ |
| `RequestContext` | class | リクエストスコープのコンテキスト。`inject(...)` / `jsonBody()` / パラメータ取得などを提供 |
| `ResponseState` | class | レスポンスヘッダ等の状態を蓄積する |

### HTTP errors / helpers

`HttpError` と、対応する HTTP ステータスを返すヘルパー群:

`httpError`, `badRequest` (400), `unauthorized` (401), `forbidden` (403),
`notFound` (404), `conflict` (409), `unprocessableEntity` (422),
`preconditionFailed` (412), `preconditionRequired` (428),
`notModified` (304), `tooManyRequests` (429), `serviceUnavailable` (503)。

### Response builders

`createJsonResponse`, `createJsonResponseCreated` (201),
`createJsonResponseWithStatus`, `createJsonResponseWithHeader`,
`createJsonResponseWithStatusAndHeader`,
`createNoContentResponse` (204), `createNoContentResponseWithHeader`,
`createTextResponse`, 定数 `JSON_CONTENT_TYPE` / `TEXT_CONTENT_TYPE`。

### Security

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createSecureHeadersMiddleware(options)` | function | secure-headers ミドルウェアを生成する |
| `SecureHeadersMiddleware` | class | デフォルト設定の secure-headers ミドルウェア |
| `SecureHeadersOptions` | type | secure-headers 設定 |

### Runtime contracts (types)

`CanActivate`（guard）, `ExceptionFilter`, `NestLikeMiddleware`, `HonoLikeMiddleware`,
`SchemaAdapter`, `HttpMethod`, `Token`, `Constructor`,
`ParseResult` / `ParseSuccess` / `ParseFailure`,
および metadata 系の型（`ModuleDefinition`, `ControllerMetadata`, `RouteMetadata`,
`ProviderScope`, `ParameterMetadata` ほか）。

---

## @kivin/decorators

NestJS 風の宣言的 API。コンパイル時に AST から読み取られる。

### Structure

| Decorator | 概要 |
| --- | --- |
| `@Module({ ... })` | モジュール宣言 |
| `@Injectable({ deps })` | プロバイダ宣言 |
| `@Controller(basePath)` | コントローラ宣言 |

### Routes

`@Get`, `@Head`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`（各 path 引数）。

### Enhancers

`@UseGuards(...)`, `@UseMiddleware(...)`, `@UseFilters(...)`。

### Parameters

`@Context()`, `@PathParam(name)`, `@QueryParam(name?)`, `@Body()`。

### Validation schemas

`@UseBodySchema(schema)`, `@UseQuerySchema(schema)`, `@UseParamSchema(schema)`。

### OpenAPI metadata

`@Tag(tag)`, `@Summary(text)`, `@Description(text)`, `@OperationId(id)`,
`@Security(scheme, scopes?)`, `@Response(status, schemaOrDescription?, description?)`
（別名 `@ApiResponse`）。

---

## @kivin/valibot

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createValibotAdapter()` | function | Valibot スキーマを `SchemaAdapter` として使えるアダプタを生成する |
| `ValibotSchema` | type | アダプタが受け付ける Valibot スキーマ型 |

---

## @kivin/openapi

| Export | 種別 | 概要 |
| --- | --- | --- |
| `buildOpenApiDocument(input)` | function | manifest から OpenAPI 3.1 ドキュメントを生成する |
| `createDocsHtml(openApiUrl?)` | function | OpenAPI を表示する self-contained な docs HTML を生成する（既定 URL は `/openapi.json`） |
| `OpenApiInfo` | type | `info` セクションの型 |

---

## @kivin/logger

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createLoggerModule(options?)` | function | ロガーを提供する `ModuleDefinition` を生成する |
| `createLogger(options?)` | function | スタンドアロンの構造化ロガーを生成する |
| `getRequestLogger(context)` | function | `RequestContext` からリクエストスコープのロガーを取得する |
| `RequestLoggerMiddleware` | class | リクエストログを出力するミドルウェア |
| `LOGGER`, `LOGGER_OPTIONS` | symbol | DI トークン |
| `Logger`, `LogLevel`, `LogFields`, `LogRecord`, `LoggerModuleOptions` | type | ロガー関連の型 |

---

## @kivin/cli

`kivin` CLI（`bun run packages/cli/src/bin.ts <command>`）。

### `generate`

manifest と OpenAPI を生成する。

```
generate --entry <app.ts> --outDir <dir> [--title <t>] [--version <v>]
```

### `openapi`

OpenAPI ドキュメントのみ生成する。

```
openapi --entry <app.ts> --output <file.json> [--title <t>] [--version <v>]
```

### `inspect`

ルート / モジュールのグラフを確認する。

```
inspect routes  --entry <app.ts> [--format text|json]
inspect modules --entry <app.ts> [--format text|json]
```

`inspect routes` は handler・controller scope・executor mode
（`native-static` / `singleton-runtime` / `context-runtime` / `request-runtime`）・
guard / middleware / filter の scope を表示する。
`inspect modules` は provider / controller scope と app-global な enhancer 配線を表示する。
