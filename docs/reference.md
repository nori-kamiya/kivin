# API Reference

kivin の公開 API を package ごとにまとめたリファレンスです。詳細な設計背景は各専用ドキュメント（[architecture](./architecture.md) ほか）を参照してください。

- [@kivinjs/core](#kivinjscore)
- [@kivinjs/security](#kivinjssecurity)
- [@kivinjs/http](#kivinjshttp)
- [@kivinjs/observability](#kivinjsobservability)
- [@kivinjs/config](#kivinjsconfig)
- [@kivinjs/schedule](#kivinjsschedule)
- [@kivinjs/session](#kivinjssession)
- [@kivinjs/graphql](#kivinjsgraphql)
- [@kivinjs/trpc](#kivinjstrpc)
- [@kivinjs/apollo](#kivinjsapollo)
- [@kivinjs/i18n](#kivinjsi18n)
- [@kivinjs/jsx](#kivinjsjsx)
- [@kivinjs/static](#kivinjsstatic)
- [@kivinjs/decorators](#kivinjsdecorators)
- [@kivinjs/valibot](#kivinjsvalibot)
- [@kivinjs/standard-schema](#kivinjsstandard-schema)
- [@kivinjs/jwt](#kivinjsjwt)
- [@kivinjs/openapi](#kivinjsopenapi)
- [@kivinjs/logger](#kivinjslogger)
- [@kivinjs/cli](#kivinjscli)

---

## @kivinjs/core

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
| `originalRequest(request)` | function | サーバーが受け取ったリクエスト。`onRequest` フックの書き換えやボディ上限のための複製で作られたリクエストでも元のオブジェクトを返す。リクエストごとの状態を `WeakMap` などでフレームワークの外に持つときのキーに使う |
| `afterResponse(request, callback)` | function | そのリクエストの最終レスポンス（例外フィルタ・CORS の後、クライアントが受け取るもの）でコールバックを呼ぶ。`Response` を返すと差し替え。メトリクスやトレースのミドルウェアが正しいステータスを記録するのに使う |
| `enableAfterResponse()` | function | `afterResponse` を最初のリクエストから有効にする。ガード（同期・非同期を問わない）などの `await` の後ろで走るミドルウェアが `afterResponse` を使うなら、最初のリクエストより前に 1 回呼ぶ（`@kivinjs/observability` のミドルウェアは生成時に呼ぶ） |
| `app.init()` | method | 起動時フック（`onModuleInit` → `onApplicationBootstrap`）を実行。フックがあるアプリは `listen` 前に必須 |
| `app.get(token)` | method | root container から provider を取り出す |
| `app.createRequestContext(request, params?)` | method | コントローラのルート以外（ネイティブルート、tRPC / GraphQL のコンテキストなど）で使う `RequestContext` を、専用の request container 付きで作る。`inject(...)` で request-scoped の provider を呼び出しごとに 1 つ解決でき、`RequestContext` を注入する provider もこのコンテキストを受け取る。設定したレスポンスヘッダはネイティブルートの応答には反映されない |
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
`InjectableMetadata`（`deps`、ガードを合成するクラス用の `composesEnhancers`）,
`ParseResult` / `ParseSuccess` / `ParseFailure`,
および metadata 系の型（`ModuleDefinition`, `ControllerMetadata`, `RouteMetadata`,
`ProviderScope`, `ParameterMetadata` ほか）。

グローバルミドルウェア（`globals.middleware` の singleton）が `handleUnmatched(request, response)` を持つと、ルートに一致しなかったリクエスト（404、405、自動の `OPTIONS` / CORS プリフライト）と `onRequest` フックが返した応答で呼ばれます。`Response` を返すと差し替え、例外はログに出して無視します。使わなければ 404 / 405 の経路で配列の長さを見るだけです。

---

## @kivinjs/security

認証ガード・CSRF・セキュリティヘッダ・レートリミット。

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createSecureHeadersMiddleware(options)` | function | secure-headers ミドルウェアを生成する |
| `SecureHeadersMiddleware` | class | デフォルト設定の secure-headers ミドルウェア |
| `SecureHeadersOptions` | type | secure-headers 設定 |
| `createRateLimitMiddleware(options)` | function | 固定ウィンドウのレートリミット（429 / Retry-After / RateLimit-* ヘッダ）。`store` で共有ストア（`RedisRateLimitStore` など）に差し替え可能 |
| `RateLimitStore`, `MemoryRateLimitStore` | interface / class | レートリミットのカウンタストア（既定はプロセス内メモリ） |
| `RedisRateLimitStore(client, { prefix? })` | class | Redis のカウンタストア（複数インスタンスで上限を共有）。`INCR` と `PEXPIRE` を Lua スクリプト 1 回（`EVAL`）で原子的に行い、ウィンドウの終わりは Redis の `PTTL` から求める。既定の prefix は `kivin:rl:` |
| `RedisCommandClient` | interface | `RedisRateLimitStore` が受け取るクライアントの型（`send(command, args)`）。Bun の `RedisClient` / `Bun.redis` がそのまま当てはまる |
| `createBasicAuthGuard(options)` | function | HTTP Basic 認証ガード（定数時間比較、`verify` で独自検証） |
| `createBearerAuthGuard(options)` | function | `Authorization: Bearer` の静的トークン / 独自検証ガード |
| `createCsrfMiddleware(options)` | function | Sec-Fetch-Site / Origin によるクロスサイトリクエスト拒否（403） |
| `readBasicCredentials(request)` / `readBearerToken(request)` | function | 認証ヘッダの読み取り |
| `createIpRestrictionGuard(options)` | function | IP の許可 / 拒否リストのガード（拒否優先、許可リスト外は 403、不明なアドレスは既定で拒否）。アドレス・CIDR（IPv4 / IPv6）・`*`・判定関数 |
| `createIpRestriction(options)`, `createIpMatcher(rules)`, `parseIpAddress(text)` | function | IP 制限の判定関数（`onRequest` フック用）、ルール照合、アドレスのパース（IPv4-mapped は IPv4 扱い） |
| `anyGuard(...guards)` | function | いずれかのガードが通れば許可（Bearer または Basic など）。全拒否なら最初の `HttpError`、なければ 403。合成するガードはアプリのコンテナが作る（コンストラクタ依存可、`providers` への記載不要） |
| `everyGuard(...guards)` | function | すべてのガードが通れば許可（最初の拒否で停止）。`anyGuard` の中での組み合わせ用 |
| `exceptGuard(exempt, ...guards)` | function | `exempt`（ルートのテンプレート `'/health'` / `'/public/*'`、その配列、または `(request, route) => boolean`）に一致するルートではガードを実行しない。パスの判定はルートごとに 1 回 |
| `GuardClass`, `ComposedGuardClass`, `GuardExemption` | type | 合成するガードクラス、合成したガードクラス、`exceptGuard` の除外条件 |

## @kivinjs/http

HTTP レベルのミドルウェアとヘルパー。

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createTimeoutMiddleware(ms, options)` | function | 時間内に終わらないリクエストに 504 を返すミドルウェア |
| `createCompressMiddleware(options)` | function | gzip / brotli 圧縮ミドルウェア（Accept-Encoding の交渉、閾値、型フィルタ、NDJSON はストリーム圧縮） |
| `createEtagMiddleware(options)` | function | ボディのハッシュから弱い ETag を付け、If-None-Match に 304 を返すミドルウェア |
| `createResponseCache({ store?, key?, statusHeader? })` | function | 共有のレスポンスキャッシュ（Hono の `cache`）。`middleware(options?)` でルートに付けるミドルウェア、`invalidate(urlOrRequest)` でその URL の全バリアント、`invalidateTag(tag)` でタグの付いた応答を消す。キーの既定はリクエストの完全な URL |
| `cache.middleware({ ttl?, tags?, statuses?, maxSize?, vary? })` | method | GET の応答を保存し、GET / HEAD に返す（ヒット時は `Age` を付け、保存した ETag と `If-None-Match` が一致すれば 304）。TTL は `ttl`（秒）、無ければ `Cache-Control` の `s-maxage` → `max-age`。どれも無ければ保存しない。`Authorization` / `Cookie` 付きのリクエストは素通し、`Set-Cookie`・`Cache-Control: private / no-store / no-cache`・`Vary: *`・SSE / NDJSON・`statuses`（既定 `[200]`）以外・`maxSize`（既定 1 MiB）超は保存しない。応答の `Vary`（と `vary` に挙げたリクエストヘッダ。`@kivinjs/i18n` のようにミドルウェアの外で `Vary` を付けるものと組み合わせるときに使う）のヘッダ値ごとに別のエントリにする |
| `MemoryCacheStore({ maxEntries?, maxBytes? })` | class | プロセス内の LRU ストア（既定 1000 件 / 64 MiB） |
| `RedisCacheStore(client, { prefix? })` | class | Redis のストア（複数インスタンスで共有）。エントリは JSON（ボディは base64）を `SET … PX`、タグは集合で、保存とタグ登録・タグの削除はそれぞれ Lua スクリプト 1 回。既定の prefix は `kivin:cache:`。`client` は Bun の `RedisClient` / `Bun.redis` |
| `ResponseCacheStore`, `CacheRecord`, `CacheOptions` | interface / type | 自作のストア（`get` / `set(key, record, ttlMs, tags)` / `deleteTag`）と関連の型 |
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
| `html`, `raw`, `htmlResponse`, `escapeHtml`, `HtmlString` | function / class | 自動エスケープする HTML テンプレート（Hono の `html`）と `text/html` レスポンス。`htmlResponse` は文字列・`html` の結果・`ReadableStream`（`react-dom/server` の `renderToReadableStream` など JSX の描画結果）を受け取る。`@kivinjs/jsx` を使うなら同パッケージの `render` |
| `createRequestStorageMiddleware()`, `getCurrentRequest()`, `getRequestValue(key)`, `setRequestValue(key, value)` | function | AsyncLocalStorage で現在のリクエストと値をどこからでも参照する（Hono の `contextStorage`） |

## @kivinjs/observability

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createMetrics(options?)` | function | Prometheus メトリクス。`middleware`（`globals.middleware` 用）、`handler`（`/metrics` のネイティブルート用）、`registry` を返す。`http_requests_total` / `http_request_duration_seconds`（`method` / `route` テンプレート / `status`）、`http_requests_in_flight`、プロセスメトリクス。ルートに一致しなかったリクエストと `onRequest` フックの応答は `route="(unmatched)"` で `http_requests_total` にだけ数える（`unmatchedRoute` でラベル変更、`false` で無効） |
| `MetricsRegistry`, `Counter`, `Gauge`, `Histogram` | class | 依存なしのメトリクスレジストリ（ラベル付き、テキスト形式 0.0.4 で出力） |
| `createTracingMiddleware(options)` | function | OpenTelemetry の SERVER スパン（`@opentelemetry/api` の `tracer` / `propagation` / `context` を渡す。依存なし）。HTTP セマンティック規約の属性、`traceparent` からの継続、5xx は ERROR + 例外記録 |
| `createServerTimingMiddleware(options?)`, `serverTiming(request)` | function | `Server-Timing` ヘッダ（total とハンドラが記録した計測）。`enabled` で送る条件を絞れる |
| `createHealthCheck(options?)` | function | `/livez`（常に 200）と `/readyz`（チェックを並列実行、失敗・タイムアウトで 503）。`routes()` で `listen({ routes })` に渡す。`setReady(false)` でドレイン |

## @kivinjs/config

| Export | 種別 | 概要 |
| --- | --- | --- |
| `loadEnv(schema, options?)` | function | 環境変数を schema で検証・変換して型付きで返す（Standard Schema なら adapter 不要）。不正な変数をすべて挙げた `EnvValidationError` を投げ、値はメッセージに含めない。`prefix` で `APP_*` だけを読む |
| `envProvider(token, schema, options?)` | function | 検証済みの環境変数を DI で注入する provider |
| `EnvValidationError`, `EnvIssue` | class / type | 検証エラー（変数名とメッセージ） |

## @kivinjs/schedule

| Export | 種別 | 概要 |
| --- | --- | --- |
| `Scheduler`, `createScheduler(options?)` | class / function | cron ジョブ。`cron(name, expression, handler, { timeZone, overlap, runOnStart, lock, lockTtlMs })`、`run(name)`、`list()`、`remove(name)`。provider にすると `app.init()` で開始し、`app.close()` で停止（実行中のジョブを待つ）。options は `{ timeZone, onError, shutdownTimeoutMs, unref, lock, lockTtlMs }` |
| `JobLock` | interface | `SchedulerOptions.lock` に渡す分散ロック（`acquire(key, ttlMs)`）。スケジュールどおりの各回で `<ジョブ名>:<予定時刻のミリ秒>` を取れたインスタンスだけが実行する。ロックは解放せず `lockTtlMs`（既定 60 秒。インスタンス間の時計のずれより長くする）で期限切れになる。`run(name)` / `runOnStart` / `lock: false` のジョブは対象外 |
| `createRedisJobLock(client, { prefix? })` | function | Redis の `JobLock`（`SET key token NX PX ttl`）。既定の prefix は `kivin:job:`。`client` は Bun の `RedisClient` / `Bun.redis` など `send(command, args)` を持つもの（`RedisCommandClient`） |
| `JobLockError` | class | ロックの取得に失敗した（例外・reject）ときに `onError` へ渡すエラー。その回はそのインスタンスでは実行しない（`cause` が元のエラー、`job` がジョブ名） |
| `parseCron(expression, timeZone?)` | function | cron 式（5 / 6 フィールド、範囲・ステップ・リスト・名前・`@daily` などの別名）を解析し、IANA タイムゾーン（夏時間対応）で次回実行時刻を計算する |

## @kivinjs/session

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createSessionMiddleware(options)` | function | サーバー側セッション。署名付きのセッション ID Cookie、変更時のみ保存、何か設定されるまでセッションを作らない、`rolling` で期限延長 |
| `getSession(request)` | function | リクエストのセッション（`get` / `set` / `delete` / `has` / `all` / `regenerate()`（固定化攻撃対策）/ `destroy()`） |
| `SessionStore`, `MemorySessionStore` | interface / class | ストアのインターフェース（DB などを実装できる）とメモリ実装（開発・単一プロセス向け） |
| `RedisSessionStore(client, { prefix? })` | class | Redis のセッションストア（複数インスタンスで共有）。セッションごとに JSON を `SET … PX` で保存し、`rolling` の延長は `PEXPIRE`、削除は `DEL`。既定の prefix は `kivin:sess:` |
| `RedisCommandClient` | interface | `RedisSessionStore` が受け取るクライアントの型（`send(command, args)`）。Bun の `RedisClient` / `Bun.redis` がそのまま当てはまる |

## @kivinjs/graphql

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createGraphqlRoutes(server, options?)` | function | GraphQL Yoga（または `fetch(request, context)` を持つ GraphQL サーバー）を `listen({ routes })` のネイティブルートとして載せる。`context` で認証済みユーザーや `app.get(...)` のサービスを渡す |
| `createGraphqlHandler(server, options?)` | function | 同じハンドラを単体で返す |

## @kivinjs/trpc

`@trpc/server` 11 を peer dependency に持ちます。

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createTrpcRoutes(router, options?)` | function | tRPC のルーターを `listen({ routes })` のネイティブルート（`<endpoint>/*` の GET / POST）として載せる。`endpoint` の既定は `/trpc`。`fetchRequestHandler` の他のオプション（`responseMeta`、`allowBatching` など）はそのまま渡る |
| `options.app` / `options.createContext({ req, resHeaders, info, requestContext })` | option | `createContext` は HTTP リクエストごとに 1 回呼ばれる（バッチ内の手続きは同じコンテキストを共有）。`requestContext()` は `app.createRequestContext(req)` の結果（初回呼び出し時に作る。`app` が必要）。`HttpError` を投げると対応する tRPC のエラー、`Response` を投げるとその応答をそのまま返す |
| `options.cors` | option | このルートの CORS（プリフライトと応答ヘッダ）。アプリの `cors` 設定はコントローラのルートにだけ効き、ネイティブルートには効かない |
| `options.onError` | option | tRPC の `onError`。これとは別に、`INTERNAL_SERVER_ERROR` の原因は `[kivin] Unhandled error` として 1 回だけ出力する（`HttpError` と `markErrorReported` 済みのものは出さない。`createContext` が `Response` を投げたときは `onError` も呼ばない） |
| `httpErrors` | tRPC middleware | `t.procedure.use(httpErrors)`。手続きが投げた `HttpError` を対応する tRPC のエラーにし、想定外の例外はメッセージを `Internal Server Error` に置き換えてクライアントに返す（使わないと、`HttpError` は `INTERNAL_SERVER_ERROR` になり、想定外の例外のメッセージはそのまま返る） |
| `toTRPCError(error)` | function | `HttpError` を同じステータスの tRPC のエラーに変換する。tRPC にコードが無いステータスは 4xx → `BAD_REQUEST`、5xx → `INTERNAL_SERVER_ERROR` |
| `createTrpcHandler(router, options?)` | function | 同じハンドラを単体で返す |

サブスクリプション（SSE、`Accept: text/event-stream`）の要求は、`listen({ idleTimeout })` で切られないように、その接続だけ Bun のアイドルタイムアウトを外します。

## @kivinjs/apollo

`@apollo/server` 5 と `graphql` 16 を peer dependency に持ちます。

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createApolloRoutes(server, options?)` | function | Apollo Server を `listen({ routes })` のネイティブルート（`path` の GET / POST。既定は `/graphql`）として載せる。JSON のボディを読んで `executeHTTPGraphQLRequest` に渡し、incremental delivery（`@defer` / `@stream`）の応答はストリームで返す。不正な JSON は 400 |
| `options.app` / `options.context({ req, requestContext })` | option | リクエストごとに 1 回、Apollo を呼ぶ前にコンテキストを作る。`requestContext()` は `app.createRequestContext(req)` の結果（初回呼び出し時に作る。`app` が必要）。`HttpError` や `Response` を投げると、その応答をそのまま返す |
| `options.cors` | option | このルートの CORS（プリフライトと応答ヘッダ）。アプリの `cors` 設定はネイティブルートには効かない |
| `apolloLifecycle(server)` | function | `onModuleInit` で `server.start()`、`onApplicationShutdown` で `server.stop()` を呼ぶ provider。`providers` に入れる |
| `formatApolloError` | function | `new ApolloServer({ formatError: formatApolloError })`。リゾルバの `HttpError` はメッセージを保ち、`extensions.code`（`unauthorized()` → `UNAUTHENTICATED`、`forbidden()` → `FORBIDDEN` など）と `extensions.status` を付ける。想定外の例外は `Internal Server Error` だけを返し、原因を `[kivin] Unhandled error` として 1 回だけ出力する（`markErrorReported` 済みなら出さない）。`GraphQLError` はそのまま |
| `createApolloHandler(server, options?)` | function | 同じハンドラを単体で返す |

## @kivinjs/i18n

npm の依存はありません（`Intl` を使います）。

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createI18n({ messages, defaultLocale, detect?, formats?, validation? })` | function | 言語ごとのカタログ（`{ en, ja }`）から i18n を作る。カタログは起動時に検査する（不正なプレースホルダ、未定義のスタイル、既定カタログに無いキーや引数、文字列と複数形の食い違いは `TypeError`） |
| `defineMessages(catalog)` | function | 既定言語のカタログ。キー（入れ子は `cart.items` のようにドット区切り）とプレースホルダから `t(...)` の型を導く |
| `defineTranslation(base, catalog)` | function | 他言語のカタログ。`base` と同じキーでないと型エラー |
| `plural({ zero?, one?, two?, few?, many?, other })` | function | 複数形。`count` 引数で `Intl.PluralRules` が形を選ぶ（`zero` はどの言語でも 0 のときにも使う） |
| プレースホルダ | syntax | `{name}`（文字列か数値）、`{n, number}`、`{d, date}`、`{d, time}`。3 つ目にスタイル名を書ける（数値は `integer` / `percent`、日時は `short` / `medium` / `long` / `full` が組み込み。`formats.number` / `formats.date` で追加）。引数が無いときは `{name}` のまま出す |
| `i18n.translator(locale \| request)` | method | `Translator`（`t(key, params)`、`locale`、`number(value, options?)`、`date(value, options?)`）。訳の無いキーは既定言語で答える |
| `i18n.locale(request)` | method | リクエストの言語。リクエストごとに 1 回検出し、フックが書き換えたリクエストでも同じ結果を返す |
| `i18n.onRequest` | hook | `defineApplication({ onRequest: [i18n.onRequest] })`。ルーティング前に言語を決め、`fromPathPrefix()` があれば `/ja/users` を `/users` としてルーティングする。ルートの応答（ガード・例外フィルタ・検証エラーの応答を含む）に `Content-Language`（ハンドラが付けたものは残す）を付け、検出器が見るヘッダ（`Accept-Language`、`Cookie`）を `Vary` に追加する。ルートに一致しなかった 404 / 405 には付けない |
| `i18n.token` / `i18n.provider` | token / provider | request-scoped の `Translator`。`providers: [i18n.provider]` に入れ、`container.resolve(i18n.token)` や `@Injectable({ deps: [i18n.token] })` で受け取る |
| `options.detect` | option | 順に試す検出器（既定は `[fromAcceptLanguage()]`）。最初に対応言語と一致したものを使い、どれも一致しなければ `defaultLocale`。値は対応言語に照合してから使うので、未対応の値がヘッダに出ることはない |
| `fromPathPrefix({ strip? })` / `fromQuery(name?)` / `fromCookie(name?)` / `fromAcceptLanguage()` | function | 検出器。パスの最初のセグメント、`?lang=`、`lang` Cookie、`Accept-Language`。`strip: false` にするとパスを書き換えない（ルート側に `:lang` を置く） |
| `matchLocale(candidate, locales)` | function | 候補を対応言語に照合する（大文字小文字を無視した完全一致、次に `ja-JP` → `ja` / `en` → `en-US` の言語一致） |
| `options.validation.issue(issue, { t, locale, label })` / `.message(label, { t, locale })` | option | 検証エラーの 400 の `issues[].message` と `message` を翻訳する（`issue` はスキーマライブラリの生の issue。`undefined` を返すと元のまま）。`onRequest` フックが必要 |
| `LocaleDetector` | interface | 自作の検出器（`detect(request, locales)`、`vary?`、`rewrite?(request, locales)`） |

## @kivinjs/jsx

npm の依存はありません。`tsconfig.json` の `"jsx": "react-jsx"` と `"jsxImportSource": "@kivinjs/jsx"` で使います（`@kivinjs/jsx/jsx-runtime` と `@kivinjs/jsx/jsx-dev-runtime` を提供）。

| Export | 種別 | 概要 |
| --- | --- | --- |
| `render(contextOrRequest, node, { props?, status?, headers?, stream?, docType?, nonce? })` | function | ルートのレイアウトで包んだ HTML の `Response`（`text/html; charset=utf-8`、既定で `<!DOCTYPE html>` を前置）。`RequestContext` を渡すとコンポーネントから `useRequestContext()` が使える |
| `createJsxRenderer(layout, { stream?, docType?, nonce? })` | function | レイアウトを登録するミドルウェア（Hono の `jsxRenderer`）。複数あれば外側が内側を包み、設定は内側のものが優先される。`layout` は `children` と `render` の `props` を受け取る |
| `useRequestContext()` | function | 描画中のリクエストの `RequestContext` |
| `renderToString(node)` | function | HTML 文字列（非同期コンポーネントと `<Suspense>` の中身を待つ） |
| `renderToReadableStream(node, { prefix?, nonce? })` | function | HTML のストリーム。シェルを描画してから resolve し（シェルの例外は reject）、`<Suspense>` の中身は描画でき次第、`<template>` とインラインスクリプトで差し込む。中身の例外はフォールバックを残して `[kivin] Suspense boundary failed` を出力する |
| `Suspense` | component | `fallback` を先に送り、`children` を後からストリームで送る境界。文字列への描画では `children` を待つ |
| `createContext(defaultValue)` / `useContext(context)` | function | ツリーを通して値を渡す（`<Context.Provider value>`）。非同期コンポーネントでは最初の `await` より前に呼ぶ |
| `raw(html)`, `jsonScript(value)` | function | エスケープせずに書く HTML（信頼できるものだけ）と、`<script>` に安全に埋め込める JSON（`<` `>` `&` U+2028 / U+2029 を `\u` エスケープ） |
| `escapeHtml(text)` | function | `& < > " '` のエスケープ |
| 描画の規則 | — | テキストと属性値は常にエスケープ（`<script>` / `<style>` の中も）。`class` / `className` は文字列・配列・`{ name: boolean }` を結合、`style` はオブジェクトなら camelCase を kebab-case にする（数値はそのまま）、`htmlFor` は `for`。`true` は値なしの属性、`false` / `null` / `undefined` と関数は書かない（`aria-*` / `data-*` の真偽値は `"true"` / `"false"`）。`dangerouslySetInnerHTML={{ __html }}` は中身をそのまま書く。void 要素は閉じタグなし。不正な要素名・属性名は例外 |
| `JSX.IntrinsicElements`, `HTMLAttributes`, `Child`, `Component`, `JSXElement` | type | HTML 要素と属性の型（主な要素の固有属性、ARIA / `data-*`、SVG、`my-widget` 形式のカスタム要素）。非同期コンポーネントも使える |

## @kivinjs/static

| Export | 種別 | 概要 |
| --- | --- | --- |
| `serveStatic(options)` | function | 静的ファイル配信ハンドラ（`listen({ routes })` に渡す）。ETag / 304、Range、事前圧縮、SPA fallback、パストラバーサル対策 |

## @kivinjs/decorators

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
- メソッドのメタデータは `Class[Symbol.metadata]` に保存されます。`Symbol.metadata` が無い実行環境では `@kivinjs/core` が well-known symbol を補います。

### Validation schemas

`@UseBodySchema(schema)`, `@UseQuerySchema(schema)`, `@UseParamSchema(schema)`, `@UseHeaderSchema(schema)`。`@BodyLimit(bytes)` はルートのボディ上限（413。アプリ全体の既定は `defineApplication({ bodyLimit })`）。ヘッダは小文字の名前（`'x-api-version'` など）で検証され、schema にあるキーだけが `headers` に渡ります（schema が無ければ全ヘッダの文字列レコード）。ヘッダの検証はガードやミドルウェアより前に行われ、失敗は `400 headers validation failed` です。クエリで同じキーが繰り返されると（`?tag=a&tag=b`、生成クライアントが配列を送る形）配列になります。`v.array(...)` で受けられ、単一値の schema に繰り返しキーが来た場合は 400 です。OpenAPI には `in: header` のパラメータとして出力されます。`@Consumes('multipart/form-data' | 'application/x-www-form-urlencoded' | 'application/json')` はボディの形式（フォームなら `FormData` を読んでオブジェクトにしてから検証。OpenAPI と生成クライアントにも反映）。

`@StaticResponse()` はハンドラの結果が変わらないことを宣言します。引数を取らない GET ルートの応答を起動時に 1 回だけ計算し（ガード・ミドルウェア・フィルタが無ければ Bun のネイティブルートが直接返す）、毎回ハンドラを呼びません。`return { ok: true };` のように定数リテラルを返すだけのハンドラは `kivin generate` が自動でこの扱いにします。時刻・ストア・可変な設定などを読むハンドラには付けないでください（最初の結果が返り続けます）。

検証に失敗すると `400 { message: '<body|query|params|headers> validation failed', issues: [{ path: ['tags', 1, 'name'], message: '...' }] }` を返します。`issues` は schema ライブラリに関係なく `path` と `message` だけで、リクエストの値そのもの（ライブラリの生 issue に含まれる `input` など）は返しません。ただしライブラリ既定のメッセージには値が含まれることがあるので（valibot の `email` / `regex` など）、パスワード等の機微なフィールドにはメッセージを指定してください。フィルタで独自の形式にする場合は `toValidationIssues(rawIssues)` が使えます。

`getValidationFailure(response)` は、この 400 の元になった `{ label, issues }`（`issues` はスキーマライブラリの生の issue。valibot なら `type` や `requirement` を持つ）を返します。それ以外の応答では `undefined` です。`afterResponse` や例外フィルタでメッセージを翻訳するのに使い、生の issue はクライアントに返さないでください（`@kivinjs/i18n` の `validation` オプションはこれを使います）。

### OpenAPI metadata

`@Tag(tag)`, `@Summary(text)`, `@Description(text)`, `@OperationId(id)`,
`@Security(scheme, scopes?)`, `@Response(status, schemaOrDescription?, description?)`
（別名 `@ApiResponse`）。

---

## @kivinjs/valibot

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createValibotAdapter()` | function | Valibot スキーマを `SchemaAdapter` として使えるアダプタを生成する |
| `ValibotSchema` | type | アダプタが受け付ける Valibot スキーマ型 |

---

## @kivinjs/standard-schema

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createStandardSchemaAdapter(options?)` | function | Standard Schema 対応 validator（Zod / ArkType / Valibot など）用の `SchemaAdapter`。`options.toJsonSchema` / `options.target` で OpenAPI 変換を調整できる |
| `StandardSchema`, `StandardSchemaAdapterOptions`, `JsonSchemaTarget` | type | アダプタ関連の型 |

---

## @kivinjs/jwt

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createJwtGuard(options)` | function | Bearer（または Cookie）の JWT を検証する guard。失敗時 401 + `WWW-Authenticate`、`authorize` が false なら 403 |
| `getJwtPayload(context)` | function | guard が検証した payload |
| `verifyJwt(token, options)`, `signJwt(payload, options)` | function | HS* / RS* / PS* / ES* / EdDSA。`algorithms` は必須、`exp` は既定で必須 |
| `createRemoteJwks(url, options?)` | function | リモート JWKS エンドポイント用の鍵リゾルバ。取得は遅延・キャッシュされ、未知の `kid` では 1 回だけ再取得する（`refresh()` で手動更新）。`key` に渡す |
| `createLocalJwks(jwks)` | function | 固定の JWKS（設定から読み込んだものなど）用の鍵リゾルバ |
| `JwtError` | class | `code`: `malformed` / `algorithm` / `signature` / `expired` / `not-yet-valid` / `claim` |

---

## @kivinjs/openapi

| Export | 種別 | 概要 |
| --- | --- | --- |
| `buildOpenApiDocument(input)` | function | manifest から OpenAPI 3.1 ドキュメントを生成する |
| `createDocsHtml(openApiUrl?)` | function | OpenAPI を Swagger UI で表示する docs HTML を生成する（既定 URL は `/openapi.json`）。Swagger UI（`swagger-ui-dist@5.20.0`）は unpkg.com から読み込むため、閲覧側のブラウザから unpkg.com へ到達できる必要があり、CSP を設定している場合は許可が要る |
| `OpenApiInfo` | type | `info` セクションの型 |

---

## @kivinjs/logger

| Export | 種別 | 概要 |
| --- | --- | --- |
| `createLoggerModule(options?)` | function | ロガーを提供する `ModuleDefinition` を生成する |
| `createLogger(options?)` | function | スタンドアロンの構造化ロガーを生成する |
| `getRequestLogger(context)` | function | `RequestContext` からリクエストスコープのロガーを取得する |
| `RequestLoggerMiddleware` | class | リクエストログを出力するミドルウェア |
| `LOGGER`, `LOGGER_OPTIONS` | `InjectionToken` | 型付き DI トークン |
| `Logger`, `LogLevel`, `LogFields`, `LogRecord`, `LoggerModuleOptions` | type | ロガー関連の型 |

---

## @kivinjs/cli

`kivin` CLI。プロジェクトに `bun add -d @kivinjs/cli` で入れ、`package.json` の scripts（例: `"generate": "kivin generate --entry app.ts --outDir .kivin/generated"`）か `bunx --package @kivinjs/cli kivin <command>` で実行する。名前が `kivin` だけの npm パッケージは本プロジェクトのものではないため、`bunx kivin` とは書かない。

`kivin --help` / `-h` は使い方を標準出力に、`kivin --version` / `-v` は `@kivinjs/cli` のバージョンを出力して終了コード 0 で終わる。未知のコマンドは使い方を標準エラーに出し、非 0 で終わる。

### `init`

新しいプロジェクトの雛形を生成する。依存のインストールもスクリプトの実行もしない。

```
init <dir>
```

- `<dir>` が存在して空でない場合（ファイル、シンボリックリンクを含む）は、何も書かずに非 0 で終わる。既存のファイルを上書きすることはない。空のディレクトリは使える。
- パッケージ名は `<dir>` の最後の要素から決まり、小文字・数字・`.`・`_`・`-` だけで先頭が英小文字か数字であることを検証する（満たさなければエラー）。`<dir>` は引数として明示された相対・絶対パスをそのまま解決し、テンプレートの値からパスをたどることはない。
- 生成物: `package.json`（`dev` / `generate` / `build` / `typecheck` / `test`）、`tsconfig.json`（TC39 デコレータ、`experimentalDecorators` なし、`types: ["bun"]`、`lib: ["ESNext"]`、strict）、`.gitignore`、`README.md`、`src/app.ts`、`src/main.ts`、`src/greeting.{module,controller,service,schemas}.ts`（valibot による検証つき）、`src/greeting.test.ts`。
- `@kivinjs/*` の範囲は実行中の CLI のバージョンから `^<version>` で決まる。`valibot` / `typescript` / `@types/bun` の範囲は `packages/cli/src/init.ts` の `TEMPLATE_RANGES` にあり、`valibot` が `@kivinjs/valibot` の peer 範囲と一致することをテストが検査する。
- 生成直後に `bun install` だけで `bun run dev` と `bun test` が動く。テストは `createTestingApp` を使うため `.kivin/generated` を必要としない。
- `bun run typecheck`（`tsc`）で、`generate` が出力する `contracts.ts` による handler と schema の不一致検査が走る。先に `bun run generate`（または `dev` / `build`）で `.kivin/generated` を作っておく。

### `generate`

manifest・contracts・client・OpenAPI を生成する。`client.ts` はサーバーコードを型としてのみ参照する型付き HTTP クライアント（`createClient` / `KivinClientError` / `Operations`）。`contracts.ts` は型チェック専用のモジュールで、tsconfig に含めると handler と schema の不一致を `tsc` が検出する。

```
generate --entry <app.ts> --outDir <dir> [--title <t>] [--version <v>] [--no-aot]
```

`modules` / `imports` には `@Module` クラス・`defineModule(...)`・オブジェクトリテラルのほか、`createLoggerModule()` のようなファクトリ呼び出し（直接でも `const` に束縛しても可）を書ける。ファクトリ呼び出しの中身は静的解析できないため、ルートを持たない前提で扱い、`generate` が読み込んだ実行時の定義と突き合わせる。コントローラーを宣言するファクトリが見つかった場合は、ルートが黙って消えないようエラーにする（ルートは `@Module` か `defineModule` で宣言する）。

公開型定義と生成クライアントは DOM ライブラリに依存しないため、`bun init` の既定（`lib: ["ESNext"]`）の tsconfig でそのまま型検査できる。

**`generate` はエントリ（`--entry`）とその import 先を実際に実行します。** モジュールのトップレベルで `loadEnv()` など環境変数やネットワークに依存する処理を呼ぶと、シークレットの無いビルド環境で `generate` が失敗します（[production.md](production.md#環境変数kivinconfig)）。DI のプロバイダ（`useFactory`・コンストラクタ）とライフサイクルフックは実行しないので、DB クライアントなどはそこで作ります（[production.md](production.md#データベース接続kysely-など)）。`generate` / `openapi` / `inspect` は完了後に明示的に終了するので、トップレベルで開かれたハンドルが残っていてもビルドは止まりません。また、decorator に渡す schema・guard・middleware は `export` するか式として直接書く必要があります（`export` していないローカル変数は参照できません）。ただし schema は `export` してください。式として直接書いた（インラインの）schema は実行時には検証されますが、`generate` は警告を出して contracts の検査を省き、型付きクライアントの入力型もゆるくなります。

**エントリは生成ファイル（`.kivin/generated/*`）を実行時に import してはいけません。** `generate` はエントリを実行するため、まだ存在しない生成ファイルを import すると、クリーンチェックアウトでは失敗します。生成物の import は `main.ts` など、エントリから辿れない場所で行ってください。

生成に失敗した場合（解析・OpenAPI 変換のエラーなど）、`--outDir` の以前の成果物は変更されない。生成が済んだ 4 ファイルは最後に 1 つずつ置き換えるため、出力先に同名のディレクトリがあるなど置き換え自体が失敗した場合は、一部だけ新しくなることがある。

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

`inspect` はエントリから解決される `@kivinjs/core` 経由でメタデータを読むため、`bunx` やグローバルインストールの CLI でも動く。

`inspect routes` は handler・controller scope・executor mode
（`native-static` / `singleton-runtime` / `context-runtime` / `request-runtime`）・
guard / middleware / filter の scope を表示する。
`inspect modules` は provider / controller scope と app-global な enhancer 配線を表示する。
