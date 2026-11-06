# Changelog

このプロジェクトの主要な変更を記録します。
フォーマットは [Keep a Changelog](https://keepachangelog.com/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

### Added

- `@kivin/core`: 署名付き Cookie を追加。`context.setSignedCookie` / `context.signedCookie` と、単体の `signCookieValue` / `verifyCookieValue` / `getSignedCookie` / `serializeSignedCookie`。HMAC-SHA256（Web Crypto、定数時間の検証）で、署名は Cookie 名と値の両方にかかる。鍵の配列を渡すとローテーションできる
- `@kivin/core`: `createRequestIdMiddleware` と `getRequestId` を追加（受信した ID は形式を検証し、不正なら UUID を発行。`@kivin/logger` の requestId にも反映）
- `@kivin/core` / `@kivin/decorators`: ルート単位のボディサイズ制限 `@BodyLimit(bytes)` とアプリ全体の既定 `defineApplication({ bodyLimit })` を追加（413。Content-Length が超えていれば読まずに返し、チャンク転送は読みながら打ち切る）

- `@kivin/core`: `createTimeoutMiddleware`（時間切れで 504）、`createRateLimitMiddleware`（固定ウィンドウ、429 / Retry-After / RateLimit-* ヘッダ、キーは既定でクライアントアドレス）、`getClientAddress(request)` を追加

- `@kivin/core`: `createCompressMiddleware`（brotli / gzip。Accept-Encoding の q 値で選択、閾値・型フィルタ・`no-transform`・SSE 除外、NDJSON はストリーム圧縮、brotli 品質は既定 4）と `createEtagMiddleware`（ボディのハッシュから弱い ETag、If-None-Match に 304）を追加

- `@kivin/core`: `serveStatic` を追加。Bun のネイティブルートで静的ファイルを配信する（ETag / Last-Modified と 304、Range、HEAD、index.html、SPA fallback、`.br` / `.gz` の事前圧縮、Cache-Control）。パストラバーサル（エンコード含む）・NUL・ドットファイルは 404
- `@kivin/core`: `createBasicAuthGuard` / `createBearerAuthGuard`（定数時間比較、`WWW-Authenticate` 付き 401）と `createCsrfMiddleware`（Go 1.25 の CrossOriginProtection と同じ Sec-Fetch-Site / Origin 判定で 403）を追加

- `@kivin/core`: `globals` やルートで指定したガード / ミドルウェア / フィルタのクラスは、モジュールの `providers` に書かなくても自動で登録されるようにした（依存はモジュールから解決）。`globals` の `guards` / `middleware` / `filters` は個別に省略できる

- `@kivin/cli`: `generate` が `contracts.ts` を出力するようになり、ハンドラの入力型と schema、ハンドラの戻り値と 2xx レスポンス schema のズレを `tsc` で検出できるようにした
- `@kivin/decorators`: `@Injectable({ deps })` を型付けし、deps の並び・型・個数がコンストラクタ引数と合わない場合にコンパイルエラーにした
- `@kivin/core`: 型付きトークン `createToken<T>()` / `InjectionToken<T>`、`InferSchemaInput` / `InferSchemaOutput` / `RouteContract` 型を追加
- `@kivin/core`: `app.listen()` が `{ port, hostname, routes }` を受け取り、追加の native route を app のルートと一緒に `Bun.serve` へ載せられるようにした（app のルートと衝突するパスはエラー）
- `@kivin/standard-schema`: Standard Schema 対応 validator（Zod / ArkType / Valibot など）用の schema adapter を追加
- decorators / openapi / valibot / listen のテストと、`tests/types` のコンパイル時テストを追加
- `@kivin/cli`: `generate` が型付き HTTP クライアント `client.ts` を出力するようにした（サーバーコードは型としてのみ参照）
- `@kivin/cli`: `dev` コマンドを追加。保存のたびに再生成してサーバーを再起動し、生成に失敗した場合は直前のサーバーを維持する
- CI（GitHub Actions）と、base ref と同一マシンで比較する性能劣化ゲート `bun run perf:regression` を追加
- `@kivin/core`: `defineApplication({ cors })` で CORS ヘッダと preflight 自動応答（404 / 405 にもヘッダを付与）
- `@kivin/core`: `RequestContext` に Cookie（`cookie` / `cookies` / `setCookie` / `deleteCookie`）、`formData` / `form`、`sse` を追加。`ResponseState.appendResponseHeader` で複数の `Set-Cookie` に対応
- `@kivin/core`: `listen({ websockets })` と `defineWebSocket` で Bun ネイティブの WebSocket ルートを追加
- `@kivin/core`: `app.close()` による graceful shutdown と `onApplicationShutdown` フック、`listen({ shutdownSignals, maxRequestBodySize, idleTimeout })`、`app.get(token)`
- `@kivin/core`: provider を差し替えてポートを開かずに呼べる `createTestingApp`
- `@kivin/jwt`: Web Crypto ベースの `verifyJwt` / `signJwt` と `createJwtGuard`
- `@kivin/jwt`: JWKS 対応。`createRemoteJwks(url)`（TTL / `Cache-Control` キャッシュ、未知の `kid` での rate limit 付き再取得、取得失敗時は直前の鍵を継続）と `createLocalJwks`。`key` に鍵リゾルバ関数を渡せるようにし、JWKS が取得できない場合ガードは 503 を返す
- `@kivin/decorators`: `@Consumes('multipart/form-data' | 'application/x-www-form-urlencoded')` で入力オブジェクトの `body` にフォーム（`File` を含む）を検証して渡せるようにした。OpenAPI は該当 media type で出力し、生成クライアントは `FormData` で送信する
- `@kivin/core`: 起動時フック `onModuleInit` / `onApplicationBootstrap` と `app.init()` を追加。フックを持つ provider があるのに `init()` 前に `listen()` するとエラーにして、フックが黙って実行されないようにした。`createTestingApp().request()` は自動で `init()` する
- `@kivin/cli`: 生成クライアントで `@UseHeaderSchema` のルートのヘッダ名と値を型付けした（`createClient({ headers })` で毎回送れるよう呼び出しごとには任意）。schema なしクエリの型を `string | string[] | undefined` にしてサーバ側と揃えた
- `@kivin/decorators` / `@kivin/core`: `@UseHeaderSchema` と入力オブジェクトの `headers` を追加。リクエストヘッダ（小文字名）を検証・型付けしてハンドラに渡し、OpenAPI に `in: header` として出力する。`headers` を読まない・schema の無いルートには一切コストがかからない
- `@kivin/valibot`: `v.file()` / `v.blob()` を OpenAPI で `{ type: 'string', format: 'binary' }` として出力
- `@kivin/cli`: `generate` が manifest の各ルートに AOT executor（`aot` ファクトリ）を出力するようにした。実行時コンパイラが汎用パスを選ぶルートを、引数に特化した直線的な関数で置き換える（context-json +25%、delete +19%、request-scoped +19%、他は変化なし）。`--no-aot` / `KIVIN_AOT=0` で無効化できる

### Fixed

- `@kivin/core`（セキュリティ）: ガードが 1 つだけのルートで、そのガードの `canActivateRaw` が `async` 宣言ではない通常のメソッドで Promise を返す場合（`canActivateRaw(req) { return this.auth.check(req); }`）、Promise が真値として扱われて**全リクエストが許可されていた**問題を修正（#38）

- `@kivin/core`: フィルタで処理されなかった例外は 500 になるだけでどこにも記録されず、`@kivin/logger` を入れていないアプリでは原因が失われていた。`console.error('[kivin] Unhandled error', error)` に 1 回出すようにした（`HttpError` とフィルタで処理された例外は出さない。`@kivin/logger` の `RequestLoggerMiddleware` が記録した例外は二重に出さない）。他のロガーからは `markErrorReported(error)` で同様に抑止できる
- `@kivin/core`: WebSocket の `upgrade` の例外が Bun の既定エラーページ（development ではスタックトレースを表示）まで漏れていた問題と、`open` / `message` / `close` / `drain` の例外が未処理 reject になっていた（プロセスの終了コードが 1 になる）問題を修正。`upgrade` は 500 を返し、ハンドラの例外は新しい `error` フックか `console.error` に渡す。`open` の失敗時は 1011 で閉じる。`listen()` に Bun.serve の `error` ハンドラを既定で設定した
- `@kivin/core`: `setCookie` / `serializeCookie` の `path` / `domain` / `sameSite` / `priority` に `;` や改行を含む値を渡すと、属性の注入（`path: '/; Domain=evil'`）やヘッダ分割ができた問題を修正。不正な値は `TypeError` にする

- `@kivin/openapi`: OpenAPI の `paths` がルート定義のまま `/users/:id` になっており、OpenAPI のパステンプレート（`/users/{id}`）として解釈されなかった（Swagger UI の Try it out・コード生成・バリデータでパスパラメータが置換されない／不整合エラー）問題を修正。末尾スラッシュも落とす（`/users/` → `/users`）
- `@kivin/openapi`: param schema の無いルートでパス変数が `parameters` に宣言されず、`@ApiResponse` の無いルートが空の `responses` になって OpenAPI として不正だった問題を修正（パス変数は必須の string として補い、レスポンス未宣言なら `200` を出す）
- `@kivin/core`: 同じメソッドと形のパスを持つルート（`GET /x` と `GET /x/`、`/u/:id` と `/u/:name` など）が黙って両方登録され、`app.fetch` と Bun の native routes とで別のハンドラが選ばれていた問題を修正。起動時に両方のルートを示すエラーにする
- `@kivin/core`: provider の循環依存が `RangeError: Maximum call stack size exceeded` になっていたのを、`Circular dependency: A -> B -> C -> A` と経路を示すエラーにした。未登録 provider のエラーにも `(required by Repo <- Service)` と依存元を付けた

- `@kivin/core`: パスパラメータやクエリに不正なパーセントエンコーディング（`/users/%ZZ`、`?q=50%`）があると `URIError` がルーターから投げられ、`app.fetch` が例外になる（HTTP では 500）問題を修正。デコードできない部分は元の文字列のまま渡す
- `@kivin/core`: ハンドラが `Bun.file()` / `Blob` / `ReadableStream` / `ArrayBuffer` / typed array を返すと JSON 化されて `{}`（typed array は添字のオブジェクト）が返っていた問題を修正。ボディとしてそのまま送り、Content-Type は Blob の型（ファイルは拡張子から）か `application/octet-stream` にする
- `@kivin/core`: 何も返さない（`undefined` を返す）ハンドラが常に 500 になっていた問題を修正。空ボディとルートの既定ステータス（GET 200 / POST 201 / 既定 204 のルートは 204）で応答する

- `@kivin/core`: CORS を有効にしたとき、検証エラー（400）・ガードの拒否（403）・ハンドラの例外・フィルタの応答に CORS ヘッダが付かず、ブラウザがエラー本文を読めなかった問題を修正。ヘッダが変更不可のレスポンス（`fetch` の結果をそのまま返す場合など）でも 500 にならないようにした

- **`@kivin/core`: 引数を取らず定数を返す GET ルートで、app 全体（`globals`）の guard / middleware / filter と CORS が適用されていなかった問題を修正**。このようなルートは静的レスポンスを事前計算して pipeline を丸ごと省略していたが、判定がルート自身の enhancer しか見ていなかったため、たとえば global の認証 guard がそのルートでは素通りしていた。global を含めて enhancer が 1 つでもあれば事前計算しないようにした
- リポジトリ直下に `tsconfig.json` を追加。Bun は作業ディレクトリの tsconfig からデコレータの方式を決めるため、ルートで `bun test` / `bun run` を実行すると TC39 デコレータとして動き、メソッド・引数デコレータのメタデータが記録されていなかった（CLI の AST 経路は影響なし）
- README の Quick start を現行 API（`createApp(definition, manifest)`、必須の `schemaAdapter`、default export の manifest）に合わせた
- `contracts.ts` の入力チェックで、`Pick<RouteInput<...>>` 同士の比較が型パラメータの variance で素通りしうる問題を、構造的な比較に変えて修正

- `@kivin/core`: クエリ schema を持つルートで、クエリ文字列が無いリクエストが `400 query validation failed` になっていた問題を修正（optional なフィールドだけの schema でも空オブジェクトとして検証する）

### Changed

- `@kivin/core`: リクエスト処理の promise の段数と割り当てを削減した。raw executor（app 全体 / ルートの raw middleware・raw guard・exception filter を使うルート）は body の読み込み・検証・ハンドラ呼び出しを 1 段の `.then` で行い、リクエスト毎の状態をクロージャではなくクラスで持つ。promise でない値は `await` しない。AOT 生成コードのミドルウェア `next` も async を挟まない。`HttpError` の応答生成も軽量化。in-process のペア計測で幾何平均 +5.9%（param +20%、filter 経由の 404 +23%、guard + body +15%、app 全体の middleware + body +8%、403 +6%）。なお raw executor のルートで body を読まないルートの exception filter が `context.jsonBody()` を呼ぶと、以前は `undefined` が返る場合があったが、実際のリクエストボディを読むようになった

- core とプラグインを分離した（破壊的変更）。`@kivin/core` には実行時の中核（ルーティング・DI・ライフサイクル・入力検証・Cookie / SSE / WebSocket・CORS・クライアントアドレス）だけを残し、独立したミドルウェアを領域ごとのパッケージに移した: `@kivin/security`（`createBasicAuthGuard` / `createBearerAuthGuard` / `createCsrfMiddleware` / `createSecureHeadersMiddleware` / `SecureHeadersMiddleware` / `createRateLimitMiddleware` など）、`@kivin/http`（`createCompressMiddleware` / `createEtagMiddleware` / `createTimeoutMiddleware` / `createRequestIdMiddleware` / `getRequestId` / `acceptsEncoding`）、`@kivin/static`（`serveStatic`）。import 元を変更してください。`@kivin/logger` はリクエスト ID をコンテキストの `requestId` から読む

- `@kivin/core`: 検証エラー（400）の `issues` を `{ path, message }` の配列に正規化した。valibot の生 issue は各要素に `input` と親オブジェクト全体を含むため、パスワードなどリクエストボディ全体がエラーレスポンスに複製されていた。形式も schema adapter によらず同じになる。`toValidationIssues` を export

- `@kivin/core`: クエリで同じキーが繰り返された場合（`?tag=a&tag=b`）に最後の値だけを残していたのを、配列にするようにした（Express / Fastify と同じ）。生成クライアントは配列のクエリを繰り返しキーで送るため、これまでは `v.array()` の schema が通らず、schema なしでは最後の値しか届かなかった。schema なしの `query` の型は `Record<string, string | string[] | undefined>` になる

- `@kivin/core`: 不正な JSON ボディ（空ボディを含む）を 500 ではなく `400 { message: 'Invalid JSON body' }` で返すようにした（クライアントの誤りでありサーバーエラーではないため。フィルタで `HttpError` として扱える）

- `@kivin/core`: 引数を取らない GET ルートに global の guard / middleware がある場合も、ハンドラの結果を起動時に一度だけ計算して再利用するようにした（pipeline 自体は毎回実行）。global middleware 付きの `/health` 相当で約 +20%
- **TC39 標準デコレータへ移行（破壊的変更）**。`experimentalDecorators` は不要になった（有効にしない）。TC39 に引数デコレータが無いため `@Body` / `@PathParam` / `@QueryParam` / `@Context` を廃止し、ハンドラは 1 つの入力オブジェクト `find({ params, query, body, context }: RouteInput<{ params: typeof S }>)` を受け取る形にした。CLI は分割代入したフィールドだけを manifest に記録し、実行時もそのフィールドだけを計算する。`contracts.ts` は `RouteInput` の型と schema デコレータのズレを検出する。古い書き方は `kivin generate` が置き換え方を示すエラーで止める
- **JSON レスポンスの `content-type` を `application/json; charset=utf-8` から `application/json;charset=utf-8`（空白なし、Bun の `Response.json()` と同じ表記）に変更**。HTTP の意味は同じだが、ヘッダを文字列で完全一致比較しているテストなどは更新が必要。ハンドラの戻り値・`context.json()`・エラー（400 / 404 / 405 / 426 / 500 / `HttpError`）のすべてで表記をそろえ、`JSON_CONTENT_TYPE` 定数も同じ値にした。JSON レスポンスは `Response.json()` で生成するようになり、in-process で JSON を返すルートが 8〜19% 速くなった（幾何平均 +6.9%）
- `@kivin/core`: 2,400 行あった `app.ts` を `src/runtime/` 以下の責務別モジュールに分割（公開 API は変更なし）
- `@kivin/logger`: `LOGGER` / `LOGGER_OPTIONS` を型付きトークンにした
- example は `/openapi.json` と `/docs` を `app.listen({ routes })` の native route として配信するようにした
- 性能劣化ゲートのベンチアプリをデコレータで書いたソースにし、比較する両側でそれぞれの `kivin generate` を使って manifest を生成するようにした
- `perf:check`（Hono / Elysia 比較）を固定閾値の判定から、3 つの compiled binary を同時に起動して交互に計測するペア計測（中央値と 95% CI）に置き換えた。数値では失敗せず、job summary に結果を出す
- 依存関係を更新（hono 4.13 / elysia 1.4.30 / valibot 1.5 ほか）。`@kivin/valibot` の valibot 下限を `^1.5.0` に引き上げ
- `@kivin/cli`: AST 解析と module 解決を TypeScript Compiler API から oxc-parser / oxc-resolver に置き換え、`typescript` への依存を削除。生成される manifest / OpenAPI は従来と同一で、生成は約 5 倍速い（example で 310ms → 64ms）
- 開発用の TypeScript を 7.0（ネイティブ版 `tsc`）に更新。出力される JS は同一で、`.d.ts` は推論型のプロパティ順などの表記差のみ

## [0.0.1] - 2026-06-29

初回公開リリース。

### Added

- コンパイル時にルートグラフを生成する `@kivin/cli`（`generate` / `openapi` / `inspect`）
- 薄い実行時コア `@kivin/core`（`createApp` / DI コンテナ / request-scoped context）
- NestJS 風の宣言的 API `@kivin/decorators`（Module / Controller / Route / Parameter / Enhancer / OpenAPI メタデータ）
- Valibot スキーマアダプタ `@kivin/valibot`
- OpenAPI 3.1 ドキュメント生成 `@kivin/openapi`（docs HTML 生成つき）
- 構造化ロガー `@kivin/logger`（request logger ミドルウェア）
- `GET` / `HEAD` / `POST` / `PUT` / `PATCH` / `DELETE` / `OPTIONS` と、`405` / `Allow` の取り扱い
- 標準化された `HttpError` ヘルパーと `204 No Content` レスポンス
- 既定の secure-headers ミドルウェア（設定可能）
- Bun single-binary ビルドと smoke 実行による検証

[0.0.1]: https://github.com/nori-kamiya/kivin/releases/tag/v0.0.1
