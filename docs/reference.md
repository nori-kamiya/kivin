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
| `createApp(appDefinition, manifest)` | function | アプリ定義とコンパイル済み manifest から、`fetch` と `listen(portOrOptions)` を持つアプリを生成する。`listen({ port, hostname, routes })` の `routes` は app のルートと一緒に Bun native routes に載る |
| `buildManifest(appDefinition)` | function | アプリ定義から実行時 manifest を組み立てる（通常は生成 manifest 経由で呼ばれる） |
| `defineApplication(input)` | function | アプリ定義（root module / OpenAPI 設定など）を宣言する |
| `defineModule(input)` | function | モジュール（controllers / providers / imports / グローバル enhancer）を宣言する |
| `AppManifest`, `ManifestRoute` | type | 生成 manifest の型 |
| `ListenOptions`, `BunRouteDefinition`, `BunRouteHandler` | type | `listen()` のオプションと native route の型 |
| `app.close(options?)` | method | graceful shutdown: 受付停止 → 処理中のリクエストを待つ → `onApplicationShutdown` を新しい順に呼ぶ |
| `createTimeoutMiddleware(ms, options)` | function | 時間内に終わらないリクエストに 504 を返すミドルウェア |
| `createRateLimitMiddleware(options)` | function | 固定ウィンドウのメモリ上レートリミット（429 / Retry-After / RateLimit-* ヘッダ） |
| `getClientAddress(request)` | function | `listen()` で受けたリクエストの接続元アドレス（Bun の `requestIP`） |
| `createCompressMiddleware(options)` | function | gzip / brotli 圧縮ミドルウェア（Accept-Encoding の交渉、閾値、型フィルタ、NDJSON はストリーム圧縮） |
| `createEtagMiddleware(options)` | function | ボディのハッシュから弱い ETag を付け、If-None-Match に 304 を返すミドルウェア |
| `serveStatic(options)` | function | 静的ファイル配信ハンドラ（`listen({ routes })` に渡す）。ETag / 304、Range、事前圧縮、SPA fallback、パストラバーサル対策 |
| `app.init()` | method | 起動時フック（`onModuleInit` → `onApplicationBootstrap`）を実行。フックがあるアプリは `listen` 前に必須 |
| `app.get(token)` | method | root container から provider を取り出す |
| `createTestingApp(definition, { manifest?, overrides? })` | function | provider を差し替えたアプリを作る。`request(path, { json })` でポートを開かずに呼べる |

### Web features

| Export | 種別 | 概要 |
| --- | --- | --- |
| `defineApplication({ cors })`, `CorsOptions` | option | アプリ全体の CORS ヘッダと preflight 自動応答 |
| `context.cookie(name)` / `cookies()` / `setCookie()` / `deleteCookie()` | method | Cookie の読み書き（複数の `Set-Cookie` に対応） |
| `parseCookies`, `serializeCookie`, `serializeDeletedCookie`, `getCookie` | function | Cookie の単体ユーティリティ |
| `context.formData()` / `context.form()` | method | multipart / urlencoded のボディ（`form()` はフィールドを string / File / 配列にしたオブジェクト） |
| `context.sse(handler, options?)`, `createEventStream`, `formatEvent` | method / function | Server-Sent Events のレスポンス |
| `defineWebSocket(route)`, `listen({ websockets })` | function / option | Bun ネイティブの WebSocket ルート（`upgrade` で認証・拒否） |
| `listen({ maxRequestBodySize, idleTimeout, shutdownSignals })` | option | ボディサイズ上限、アイドルタイムアウト、シグナルでの graceful shutdown |

### Dependency Injection

| Export | 種別 | 概要 |
| --- | --- | --- |
| `Container` | class | DI コンテナ。request-scoped 解決のための child container を持つ |
| `RequestContext` | class | リクエストスコープのコンテキスト。`inject(...)` / `jsonBody()` / パラメータ取得などを提供 |
| `ResponseState` | class | レスポンスヘッダ等の状態を蓄積する |
| `createToken<T>(key)` | function | 型付きの DI トークン（`InjectionToken<T>`、実体は `Symbol.for(key)`）を作る。`@Injectable({ deps })` の型チェックに使われる |
| `InjectionToken<T>`, `TokenValue<T>`, `TokenValues<T>` | type | 型付きトークンと、トークンが解決する値の型 |

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

### Handler return values

- `Response`: そのまま返す（キューされたヘッダ・Cookie は付与される）
- `Bun.file()` / `Blob` / `ReadableStream` / `ArrayBuffer` / typed array: そのままボディとして送る。`Content-Type` は Blob の型（ファイルは拡張子から）、それ以外は `application/octet-stream`。ルートの既定ステータス（POST の 201 など）とキューされたヘッダは JSON と同じく適用され、静的レスポンスとして事前計算されることはない（ファイルはリクエストごとに読む）
- `undefined`（何も返さない）: 空ボディ。ステータスはルートの既定（GET 200、POST 201、既定が 204 のルートは 204）
- それ以外: JSON（`Response.json()`）

### Security

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createSecureHeadersMiddleware(options)` | function | secure-headers ミドルウェアを生成する |
| `SecureHeadersMiddleware` | class | デフォルト設定の secure-headers ミドルウェア |
| `SecureHeadersOptions` | type | secure-headers 設定 |

### Compile-time contracts (types)

| Export | 種別 | 概要 |
| --- | --- | --- |
| `InferSchemaInput<S>`, `InferSchemaOutput<S>` | type | Standard Schema 互換 schema の入力 / 出力型（非対応の schema は `any`） |
| `RouteContract` | namespace | 生成される `contracts.ts` が使う型チェック（`Body` / `Field` / `Whole` / `Returns` / `Expect`） |

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
| `@Injectable({ deps })` | プロバイダ宣言。deps の並び・型・個数がコンストラクタ引数と合わないとコンパイルエラー |
| `@Controller(basePath)` | コントローラ宣言 |

### Routes

`@Get`, `@Head`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`（各 path 引数）。

### Enhancers

`@UseGuards(...)`, `@UseMiddleware(...)`, `@UseFilters(...)`。

### Handler input

引数デコレータはありません（TC39 標準デコレータには存在しないため）。ハンドラは 1 つの入力オブジェクト `{ params, query, body, headers, context }` を受け取り、型は `RouteInput<{ params?: typeof S; query?: typeof S; body?: typeof S; headers?: typeof S }>` で付けます。分割代入したフィールドだけがリクエストごとに計算されます。

- デコレータは TC39 標準で動きます。`experimentalDecorators` は不要です（有効にしないでください）。
- メソッドのメタデータは `Class[Symbol.metadata]` に保存されます。`Symbol.metadata` が無い実行環境では `@kivin/core` が well-known symbol を補います。

### Validation schemas

`@UseBodySchema(schema)`, `@UseQuerySchema(schema)`, `@UseParamSchema(schema)`, `@UseHeaderSchema(schema)`。`@BodyLimit(bytes)` はルートのボディ上限（413。アプリ全体の既定は `defineApplication({ bodyLimit })`）。ヘッダは小文字の名前（`'x-api-version'` など）で検証され、schema にあるキーだけが `headers` に渡ります（schema が無ければ全ヘッダの文字列レコード）。ヘッダの検証はガードやミドルウェアより前に行われ、失敗は `400 headers validation failed` です。クエリで同じキーが繰り返されると（`?tag=a&tag=b`、生成クライアントが配列を送る形）配列になります。`v.array(...)` で受けられ、単一値の schema に繰り返しキーが来た場合は 400 です。OpenAPI には `in: header` のパラメータとして出力されます。`@Consumes('multipart/form-data' | 'application/x-www-form-urlencoded' | 'application/json')` はボディの形式（フォームなら `FormData` を読んでオブジェクトにしてから検証。OpenAPI と生成クライアントにも反映）。

検証に失敗すると `400 { message: '<body|query|params|headers> validation failed', issues: [{ path: ['tags', 1, 'name'], message: '...' }] }` を返します。`issues` は schema ライブラリに関係なく `path` と `message` だけで、リクエストの値そのもの（ライブラリの生 issue に含まれる `input` など）は返しません。ただしライブラリ既定のメッセージには値が含まれることがあるので（valibot の `email` / `regex` など）、パスワード等の機微なフィールドにはメッセージを指定してください。フィルタで独自の形式にする場合は `toValidationIssues(rawIssues)` が使えます。

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

## @kivin/standard-schema

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createStandardSchemaAdapter(options?)` | function | Standard Schema 対応 validator（Zod / ArkType / Valibot など）用の `SchemaAdapter`。`options.toJsonSchema` / `options.target` で OpenAPI 変換を調整できる |
| `StandardSchema`, `StandardSchemaAdapterOptions`, `JsonSchemaTarget` | type | アダプタ関連の型 |

---

## @kivin/jwt

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createJwtGuard(options)` | function | Bearer（または Cookie）の JWT を検証する guard。失敗時 401 + `WWW-Authenticate`、`authorize` が false なら 403 |
| `getJwtPayload(context)` | function | guard が検証した payload |
| `verifyJwt(token, options)`, `signJwt(payload, options)` | function | HS* / RS* / PS* / ES* / EdDSA。`algorithms` は必須、`exp` は既定で必須 |
| `JwtError` | class | `code`: `malformed` / `algorithm` / `signature` / `expired` / `not-yet-valid` / `claim` |

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
| `LOGGER`, `LOGGER_OPTIONS` | `InjectionToken` | 型付き DI トークン |
| `Logger`, `LogLevel`, `LogFields`, `LogRecord`, `LoggerModuleOptions` | type | ロガー関連の型 |

---

## @kivin/cli

`kivin` CLI（`bun run packages/cli/src/bin.ts <command>`）。

### `generate`

manifest・contracts・client・OpenAPI を生成する。`client.ts` はサーバーコードを型としてのみ参照する型付き HTTP クライアント（`createClient` / `KivinClientError` / `Operations`）。`contracts.ts` は型チェック専用のモジュールで、tsconfig に含めると handler と schema の不一致を `tsc` が検出する。

```
generate --entry <app.ts> --outDir <dir> [--title <t>] [--version <v>] [--no-aot]
```

### `dev`

ソース変更を監視し、`generate` を実行してから `--main` のサーバーを再起動する。生成に失敗した場合は直前のサーバーを維持する。

```
dev --entry <app.ts> --outDir <dir> --main <main.ts> [--watch <dir>]...
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
