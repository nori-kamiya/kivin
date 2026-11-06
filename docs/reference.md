# API Reference

kivin の公開 API を package ごとにまとめたリファレンスです。詳細な設計背景は各専用ドキュメント（[architecture](./architecture.md) ほか）を参照してください。

- [@kivin/core](#kivincore)
- [@kivin/security](#kivinsecurity)
- [@kivin/http](#kivinhttp)
- [@kivin/observability](#kivinobservability)
- [@kivin/config](#kivinconfig)
- [@kivin/schedule](#kivinschedule)
- [@kivin/session](#kivinsession)
- [@kivin/graphql](#kivingraphql)
- [@kivin/static](#kivinstatic)
- [@kivin/decorators](#kivindecorators)
- [@kivin/valibot](#kivinvalibot)
- [@kivin/standard-schema](#kivinstandardschema)
- [@kivin/jwt](#kivinjwt)
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
| `defineApplication({ basePath })` | option | 全ルートのパス接頭辞（`'/api'` なら `@Controller('/users')` の `@Get('/')` は `/api/users`）。`/` で始まる文字列リテラル。manifest・OpenAPI・生成クライアントに反映される |
| `defineApplication({ onRequest })`, `RequestHook` | option / type | ルーティング前に全リクエストで走るフック（順番に実行）。`Response` を返すと即応答、`Request` を返すとそのリクエストとしてルーティングし直す。未設定ならコストゼロ |
| `defineModule(input)` | function | モジュール（controllers / providers / imports / グローバル enhancer）を宣言する |
| `AppManifest`, `ManifestRoute` | type | 生成 manifest の型 |
| `ListenOptions`, `BunRouteDefinition`, `BunRouteHandler` | type | `listen()` のオプションと native route の型 |
| `app.close(options?)` | method | graceful shutdown: 受付停止 → 処理中のリクエストを待つ → `onApplicationShutdown` を新しい順に呼ぶ |
| `getClientAddress(request)` | function | `listen()` で受けたリクエストの接続元アドレス（Bun の `requestIP`） |
| `afterResponse(request, callback)` | function | そのリクエストの最終レスポンス（例外フィルタ・CORS の後、クライアントが受け取るもの）でコールバックを呼ぶ。`Response` を返すと差し替え。メトリクスやトレースのミドルウェアが正しいステータスを記録するのに使う |
| `enableAfterResponse()` | function | `afterResponse` を最初のリクエストから有効にする。ガード（同期・非同期を問わない）などの `await` の後ろで走るミドルウェアが `afterResponse` を使うなら、最初のリクエストより前に 1 回呼ぶ（`@kivin/observability` のミドルウェアは生成時に呼ぶ） |
| `app.init()` | method | 起動時フック（`onModuleInit` → `onApplicationBootstrap`）を実行。フックがあるアプリは `listen` 前に必須 |
| `app.get(token)` | method | root container から provider を取り出す |
| `createTestingApp(definition, { manifest?, overrides? })` | function | provider を差し替えたアプリを作る。`request(path, { json })` でポートを開かずに呼べる |

### Web features

| Export | 種別 | 概要 |
| --- | --- | --- |
| `defineApplication({ cors })`, `CorsOptions` | option | アプリ全体の CORS ヘッダと preflight 自動応答 |
| `context.cookie(name)` / `cookies()` / `setCookie()` / `deleteCookie()` | method | Cookie の読み書き（複数の `Set-Cookie` に対応） |
| `parseCookies`, `serializeCookie`, `serializeDeletedCookie`, `getCookie` | function | Cookie の単体ユーティリティ |
| `context.signedCookie(name, secrets)` / `setSignedCookie(name, value, secrets, options?)` | method | HMAC-SHA256 で署名した Cookie の読み書き。読み取りは値 / `undefined`（無い）/ `false`（署名不一致） |
| `signCookieValue`, `verifyCookieValue`, `getSignedCookie`, `serializeSignedCookie`, `CookieSecrets` | function / type | 署名付き Cookie の単体ユーティリティ。署名は Cookie 名と値の両方にかかり、鍵の配列でローテーションできる |
| `context.formData()` / `context.form()` | method | multipart / urlencoded のボディ（`form()` はフィールドを string / File / 配列にしたオブジェクト） |
| `context.sse(handler, options?)`, `createEventStream`, `formatEvent` | method / function | Server-Sent Events のレスポンス |
| `defineWebSocket(route)`, `listen({ websockets })` | function / option | Bun ネイティブの WebSocket ルート（`upgrade` で認証・拒否） |
| `listen({ maxRequestBodySize, idleTimeout, shutdownSignals, onShutdownStart, shutdownDelayMs })` | option | ボディサイズ上限、アイドルタイムアウト、シグナルでの graceful shutdown（開始フックと、停止前の待機時間） |

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

## @kivin/security

認証ガード・CSRF・セキュリティヘッダ・レートリミット。

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createSecureHeadersMiddleware(options)` | function | secure-headers ミドルウェアを生成する |
| `SecureHeadersMiddleware` | class | デフォルト設定の secure-headers ミドルウェア |
| `SecureHeadersOptions` | type | secure-headers 設定 |
| `createRateLimitMiddleware(options)` | function | 固定ウィンドウのレートリミット（429 / Retry-After / RateLimit-* ヘッダ）。`store` で共有ストア（Redis など）に差し替え可能 |
| `RateLimitStore`, `MemoryRateLimitStore` | interface / class | レートリミットのカウンタストア（既定はプロセス内メモリ） |
| `createBasicAuthGuard(options)` | function | HTTP Basic 認証ガード（定数時間比較、`verify` で独自検証） |
| `createBearerAuthGuard(options)` | function | `Authorization: Bearer` の静的トークン / 独自検証ガード |
| `createCsrfMiddleware(options)` | function | Sec-Fetch-Site / Origin によるクロスサイトリクエスト拒否（403） |
| `readBasicCredentials(request)` / `readBearerToken(request)` | function | 認証ヘッダの読み取り |
| `createIpRestrictionGuard(options)` | function | IP の許可 / 拒否リストのガード（拒否優先、許可リスト外は 403、不明なアドレスは既定で拒否）。アドレス・CIDR（IPv4 / IPv6）・`*`・判定関数 |
| `createIpRestriction(options)`, `createIpMatcher(rules)`, `parseIpAddress(text)` | function | IP 制限の判定関数（`onRequest` フック用）、ルール照合、アドレスのパース（IPv4-mapped は IPv4 扱い） |
| `anyGuard(...guards)` | function | いずれかのガードが通れば許可（Bearer または Basic など）。全拒否なら最初の `HttpError`、なければ 403。合成するガードはコンストラクタ依存なし |

## @kivin/http

HTTP レベルのミドルウェアとヘルパー。

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createTimeoutMiddleware(ms, options)` | function | 時間内に終わらないリクエストに 504 を返すミドルウェア |
| `createCompressMiddleware(options)` | function | gzip / brotli 圧縮ミドルウェア（Accept-Encoding の交渉、閾値、型フィルタ、NDJSON はストリーム圧縮） |
| `createEtagMiddleware(options)` | function | ボディのハッシュから弱い ETag を付け、If-None-Match に 304 を返すミドルウェア |
| `createRequestIdMiddleware(options)` / `getRequestId(request)` | function | リクエスト ID の付与（受信 ID は形式を検証）とレスポンスへの反映、ロガー連携 |
| `accepts(request, header, supported, fallback?)` | function | コンテンツネゴシエーション（Hono の `accepts`）。`Accept` / `Accept-Language` / `Accept-Encoding` / `Accept-Charset` から最適な値を返す。q 値（最も具体的な範囲の q が効く）→ 具体性 → 順序で選び、無ければ `fallback` |
| `acceptsType(request, types)` / `acceptsLanguage(request, languages)` | function | `Accept` / `Accept-Language` 用の短縮形（言語は `en` ⇔ `en-US` の前方一致に対応） |
| `negotiate(headerName, headerValue, supported)`, `parseAcceptHeader(header)` | function | ヘッダ文字列に対する交渉とパース |
| `acceptsEncoding(header, encoding)` | function | `Accept-Encoding` がエンコーディングを（q > 0 で）許すか。明示した `q=0` は `*` より優先、空のヘッダは identity のみ |
| `stream(handler, options?)` / `streamText(handler, options?)` | function | ストリーミングレスポンス（Hono の `stream` / `streamText`）。`write` / `writeln` / `pipe` / `sleep` / `onAbort`、バックプレッシャー対応、切断で `aborted` |
| `streamNdjson(source, options?)` | function | NDJSON（`application/x-ndjson`）を（async）iterable か書き込み関数からストリームする |
| `createPrettyJsonMiddleware(options?)` | function | `?pretty` のときだけ JSON レスポンスをインデントする（Hono の `prettyJSON`） |
| `createMethodOverride(options?)` | function | `onRequest` フック。POST をフォームの `_method`（またはヘッダ / クエリ）で PUT / PATCH / DELETE としてルーティングする |
| `createTrailingSlash(options?)` | function | `onRequest` フック。末尾スラッシュを除く（`trim`）/ 付ける（`append`）正規 URL へリダイレクト（GET / HEAD は 301、他は 308） |
| `proxy(target, request, options?)` | function | リバースプロキシ（Hono の `proxy`）。ホップバイホップヘッダの除去、`X-Forwarded-*`、圧縮されたままの転送、502 / 504、切断時の中断 |
| `html`, `raw`, `htmlResponse`, `escapeHtml`, `HtmlString` | function / class | 自動エスケープする HTML テンプレート（Hono の `html`）と `text/html` レスポンス |
| `createRequestStorageMiddleware()`, `getCurrentRequest()`, `getRequestValue(key)`, `setRequestValue(key, value)` | function | AsyncLocalStorage で現在のリクエストと値をどこからでも参照する（Hono の `contextStorage`） |

## @kivin/observability

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createMetrics(options?)` | function | Prometheus メトリクス。`middleware`（`globals.middleware` 用）、`handler`（`/metrics` のネイティブルート用）、`registry` を返す。`http_requests_total` / `http_request_duration_seconds`（`method` / `route` テンプレート / `status`）、`http_requests_in_flight`、プロセスメトリクス |
| `MetricsRegistry`, `Counter`, `Gauge`, `Histogram` | class | 依存なしのメトリクスレジストリ（ラベル付き、テキスト形式 0.0.4 で出力） |
| `createTracingMiddleware(options)` | function | OpenTelemetry の SERVER スパン（`@opentelemetry/api` の `tracer` / `propagation` / `context` を渡す。依存なし）。HTTP セマンティック規約の属性、`traceparent` からの継続、5xx は ERROR + 例外記録 |
| `createServerTimingMiddleware(options?)`, `serverTiming(request)` | function | `Server-Timing` ヘッダ（total とハンドラが記録した計測）。`enabled` で送る条件を絞れる |
| `createHealthCheck(options?)` | function | `/livez`（常に 200）と `/readyz`（チェックを並列実行、失敗・タイムアウトで 503）。`routes()` で `listen({ routes })` に渡す。`setReady(false)` でドレイン |

## @kivin/config

| Export | 種別 | 概要 |
| --- | --- | --- |
| `loadEnv(schema, options?)` | function | 環境変数を schema で検証・変換して型付きで返す（Standard Schema なら adapter 不要）。不正な変数をすべて挙げた `EnvValidationError` を投げ、値はメッセージに含めない。`prefix` で `APP_*` だけを読む |
| `envProvider(token, schema, options?)` | function | 検証済みの環境変数を DI で注入する provider |
| `EnvValidationError`, `EnvIssue` | class / type | 検証エラー（変数名とメッセージ） |

## @kivin/schedule

| Export | 種別 | 概要 |
| --- | --- | --- |
| `Scheduler`, `createScheduler(options?)` | class / function | cron ジョブ。`cron(name, expression, handler, { timeZone, overlap, runOnStart })`、`run(name)`、`list()`、`remove(name)`。provider にすると `app.init()` で開始し、`app.close()` で停止（実行中のジョブを待つ） |
| `parseCron(expression, timeZone?)` | function | cron 式（5 / 6 フィールド、範囲・ステップ・リスト・名前・`@daily` などの別名）を解析し、IANA タイムゾーン（夏時間対応）で次回実行時刻を計算する |

## @kivin/session

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createSessionMiddleware(options)` | function | サーバー側セッション。署名付きのセッション ID Cookie、変更時のみ保存、何か設定されるまでセッションを作らない、`rolling` で期限延長 |
| `getSession(request)` | function | リクエストのセッション（`get` / `set` / `delete` / `has` / `all` / `regenerate()`（固定化攻撃対策）/ `destroy()`） |
| `SessionStore`, `MemorySessionStore` | interface / class | ストアのインターフェース（Redis などを実装できる）とメモリ実装 |

## @kivin/graphql

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createGraphqlRoutes(server, options?)` | function | GraphQL Yoga（または `fetch(request, context)` を持つ GraphQL サーバー）を `listen({ routes })` のネイティブルートとして載せる。`context` で認証済みユーザーや `app.get(...)` のサービスを渡す |
| `createGraphqlHandler(server, options?)` | function | 同じハンドラを単体で返す |

## @kivin/static

| Export | 種別 | 概要 |
| --- | --- | --- |
| `serveStatic(options)` | function | 静的ファイル配信ハンドラ（`listen({ routes })` に渡す）。ETag / 304、Range、事前圧縮、SPA fallback、パストラバーサル対策 |

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

`@StaticResponse()` はハンドラの結果が変わらないことを宣言します。引数を取らない GET ルートの応答を起動時に 1 回だけ計算し（ガード・ミドルウェア・フィルタが無ければ Bun のネイティブルートが直接返す）、毎回ハンドラを呼びません。`return { ok: true };` のように定数リテラルを返すだけのハンドラは `kivin generate` が自動でこの扱いにします。時刻・ストア・可変な設定などを読むハンドラには付けないでください（最初の結果が返り続けます）。

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
| `createRemoteJwks(url, options?)` | function | リモート JWKS エンドポイント用の鍵リゾルバ。取得は遅延・キャッシュされ、未知の `kid` では 1 回だけ再取得する（`refresh()` で手動更新）。`key` に渡す |
| `createLocalJwks(jwks)` | function | 固定の JWKS（設定から読み込んだものなど）用の鍵リゾルバ |
| `JwtError` | class | `code`: `malformed` / `algorithm` / `signature` / `expired` / `not-yet-valid` / `claim` |

---

## @kivin/openapi

| Export | 種別 | 概要 |
| --- | --- | --- |
| `buildOpenApiDocument(input)` | function | manifest から OpenAPI 3.1 ドキュメントを生成する |
| `createDocsHtml(openApiUrl?)` | function | OpenAPI を Swagger UI で表示する docs HTML を生成する（既定 URL は `/openapi.json`）。Swagger UI（`swagger-ui-dist@5.20.0`）は unpkg.com から読み込むため、閲覧側のブラウザから unpkg.com へ到達できる必要があり、CSP を設定している場合は許可が要る |
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

`kivin` CLI。プロジェクトに `bun add -d @kivin/cli` で入れ、`package.json` の scripts（例: `"generate": "kivin generate --entry app.ts --outDir .kivin/generated"`）か `bunx --package @kivin/cli kivin <command>` で実行する。名前が `kivin` だけの npm パッケージは本プロジェクトのものではないため、`bunx kivin` とは書かない。

`kivin --help` / `-h` は使い方を標準出力に、`kivin --version` / `-v` は `@kivin/cli` のバージョンを出力して終了コード 0 で終わる。未知のコマンドは使い方を標準エラーに出し、非 0 で終わる。

### `generate`

manifest・contracts・client・OpenAPI を生成する。`client.ts` はサーバーコードを型としてのみ参照する型付き HTTP クライアント（`createClient` / `KivinClientError` / `Operations`）。`contracts.ts` は型チェック専用のモジュールで、tsconfig に含めると handler と schema の不一致を `tsc` が検出する。

```
generate --entry <app.ts> --outDir <dir> [--title <t>] [--version <v>] [--no-aot]
```

`modules` / `imports` には `@Module` クラス・`defineModule(...)`・オブジェクトリテラルのほか、`createLoggerModule()` のようなファクトリ呼び出し（直接でも `const` に束縛しても可）を書ける。ファクトリ呼び出しの中身は静的解析できないため、ルートを持たない前提で扱い、`generate` が読み込んだ実行時の定義と突き合わせる。コントローラーを宣言するファクトリが見つかった場合は、ルートが黙って消えないようエラーにする（ルートは `@Module` か `defineModule` で宣言する）。

公開型定義と生成クライアントは DOM ライブラリに依存しないため、`bun init` の既定（`lib: ["ESNext"]`）の tsconfig でそのまま型検査できる。

**`generate` はエントリ（`--entry`）とその import 先を実際に実行します。** モジュールのトップレベルで `loadEnv()` など環境変数やネットワークに依存する処理を呼ぶと、シークレットの無いビルド環境で `generate` が失敗します（[production.md](production.md#環境変数kivinconfig)）。また、decorator に渡す schema・guard・middleware は `export` するか式として直接書く必要があります（`export` していないローカル変数は参照できません）。

生成に失敗した場合（解析・OpenAPI 変換のエラーなど）、`--outDir` の以前の成果物は変更されない。生成が済んだ 4 ファイルは最後に 1 つずつ置き換えるため、出力先に同名のディレクトリがあるなど置き換え自体が失敗した場合は、一部だけ新しくなることがある。

### `init`

新しいプロジェクトの雛形を作る。

```
bunx --package @kivin/cli kivin init <dir>
```

### `dev`

ソース変更を監視し、`generate` を実行してから `--main` のサーバーを再起動する。生成に失敗した場合は直前のサーバーを維持する（まだ一度も起動していなければ、そう表示して次の保存を待つ）。

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

`inspect` はエントリから解決される `@kivin/core` 経由でメタデータを読むため、`bunx` やグローバルインストールの CLI でも動く。

`inspect routes` は handler・controller scope・executor mode
（`native-static` / `singleton-runtime` / `context-runtime` / `request-runtime`）・
guard / middleware / filter の scope を表示する。
`inspect modules` は provider / controller scope と app-global な enhancer 配線を表示する。
