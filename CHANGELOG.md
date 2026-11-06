# Changelog

このプロジェクトの主要な変更を記録します。
フォーマットは [Keep a Changelog](https://keepachangelog.com/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [0.1.0] - Unreleased

npm への最初の公開です。v0.0.1 はソースのみのタグで、npm には公開していません。Bun 1.4.0 以上が必要で、Node では動きません。

### Added

- `@kivinjs/core`: Bun のネイティブルートへ直接コンパイルするルーティング、モジュールと DI（`createToken`、request-scoped provider、`onModuleInit` / `onApplicationBootstrap` / `onApplicationShutdown`、`app.init()` / `app.close()`）、入力検証、Cookie（署名付き含む）、SSE、WebSocket（`defineWebSocket`）、CORS、`onRequest` フック、`afterResponse` / `enableAfterResponse`、`basePath`、`bodyLimit`、`createRequestIdMiddleware`、`getClientAddress`、`createTestingApp`、`listen({ shutdownSignals, onShutdownStart, shutdownDelayMs })`
- `@kivinjs/cli`: `kivin init` / `generate` / `dev` / `openapi` / `inspect`。`generate` は manifest、`contracts.ts`（ハンドラと schema のズレを `tsc` で検出）、型付きクライアント `client.ts`、OpenAPI、AOT 実行関数を出力する
- `@kivinjs/decorators`: TC39 標準デコレータ（`@Controller` / `@Get` など、`@UseGuards`、`@BodyLimit`、`@Consumes`、`@StaticResponse`、`@UseHeaderSchema`、型付きの `@Injectable({ deps })`）
- `@kivinjs/openapi`: OpenAPI 3.1 の生成と Swagger UI の HTML
- `@kivinjs/valibot` / `@kivinjs/standard-schema`: schema adapter
- `@kivinjs/logger`: JSON 構造化ロガーとリクエストロガー
- `@kivinjs/jwt`: Web Crypto ベースの JWT 検証・署名、JWKS、JWT ガード
- `@kivinjs/security`: Basic / Bearer 認証、CSRF、secure headers、レートリミット（ストア差し替え可）、IP 制限、`anyGuard`
- `@kivinjs/http`: 圧縮、ETag、タイムアウト、ネゴシエーション、ストリーミング、Pretty JSON、Method Override、末尾スラッシュ、リバースプロキシ、HTML テンプレート、リクエストストレージ
- `@kivinjs/static`: 静的ファイル配信（ETag、Range、SPA fallback、事前圧縮、パストラバーサル対策）
- `@kivinjs/observability`: Prometheus メトリクス、OpenTelemetry の SERVER スパン、Server-Timing、`/livez` / `/readyz`
- `@kivinjs/config`: 型付き環境変数（`loadEnv` / `envProvider`）
- `@kivinjs/schedule`: cron ジョブ（IANA タイムゾーン、重複実行の抑止、`app.close()` 連動）
- `@kivinjs/session`: サーバー側セッション（署名付き Cookie、ストア差し替え可）
- `@kivinjs/graphql`: GraphQL Yoga などの fetch ベースのサーバーをネイティブルートに載せる。`graphql-ws` の配線例は `docs/production.md`
- CI の性能ゲート `bun run perf:regression`、Hono / Elysia とのペア計測 `bun run perf:check`
- リリース基盤 `bun run release:pack` / `release:verify` / `pack:smoke` と `.github/workflows/release.yml`（手順は `docs/release.md`）

### Changed（v0.0.1 からの破壊的変更）

- パッケージのスコープを `@kivin` から `@kivinjs` に変更した（npm で `kivin` を取得できなかったため）。CLI のコマンド名は `kivin` のまま
- TC39 標準デコレータへ移行した。`experimentalDecorators` は有効にしない。引数デコレータ（`@Body` / `@PathParam` / `@QueryParam` / `@Context`）を廃止し、ハンドラは入力オブジェクト 1 つを受け取る
- 認証・CSRF・secure headers・レートリミットは `@kivinjs/security`、圧縮・ETag・タイムアウトなどは `@kivinjs/http`、静的ファイルは `@kivinjs/static` へ `@kivinjs/core` から分離した
- `@kivinjs/core` は peerDependency になった。プラグインと同じバージョンをプロジェクトに入れる
- `@kivinjs/valibot` の `valibot` は peerDependency で、`^1.5.0` が必要
- JSON レスポンスの `content-type` は `application/json;charset=utf-8`（空白なし）
- 検証エラーの `issues` は `{ path, message }` の配列に正規化した
- 繰り返されたクエリキーは最後の値ではなく配列になる
- 不正な JSON ボディは 500 ではなく `400 { message: 'Invalid JSON body' }` を返す
- `@kivinjs/cli` の AST 解析を TypeScript Compiler API から oxc へ置き換えた。`typescript` への依存はなく、`oxc-parser` / `oxc-resolver` は完全一致に固定している

### Security

- ガードが 1 つのルートで、`canActivateRaw` が `async` 宣言でない関数として Promise を返すと、全リクエストが許可されていた問題を修正（#38）
- 引数なしで定数を返す GET ルートで、`globals` の guard / middleware / filter と CORS が適用されていなかった問題を修正
- `setCookie` / `serializeCookie` の属性インジェクションとヘッダ分割を防いだ
- 検証エラーの応答にリクエストボディ全体が複製されていた問題を修正
- WebSocket の `upgrade` の例外が Bun の既定エラーページへ漏れ、development でスタックトレースを表示していた問題を修正

### Fixed

- `afterResponse` のコールバックがプロセス起動直後のリクエストで呼ばれず、`http_requests_in_flight` が戻らなかった問題を修正
- 公開型定義と生成クライアントが DOM 限定の型名を使い、`lib: ["ESNext"]` で黙って `any` になっていた問題を修正
- `kivin generate` が途中で失敗すると成果物の一部だけ更新されていた問題を修正
- 実物の GraphQL Yoga で `createGraphqlRoutes(yoga, { context })` が型エラーになっていた問題を修正
- OpenAPI のパス（`/users/{id}`）、パス変数の宣言、空の `responses` を修正
- ハンドラが返す `Blob` / `ReadableStream` / `ArrayBuffer` などの扱い、`undefined` を返すハンドラの 500、不正なパーセントエンコーディングの 500、CORS 有効時のエラー応答のヘッダ、重複ルートの検出、DI の循環依存エラーを修正
- Bun 1.4.0 未満で起動すると、`createApp` と CLI が `kivin requires Bun 1.4.0 or later (running X)` で止まるようにした。以前は警告なしに動き、チャンク転送のボディ、WebSocket のエラー処理、ヘルスチェックが誤動作した
- インライン schema（`@UseQuerySchema(v.object(...))` など）を持つハンドラが、`contracts.ts` で型エラーになっていた問題を修正。そのルートは契約チェックの対象外にし、`kivin generate` が stderr に警告（ルート名と schema を export する案内）を出す
- `kivin openapi --output X` が X の隣の `manifest.ts` を上書きして残していた問題を修正。X だけを書く
- `kivin init` のひな形に `typecheck`（`tsc`）スクリプトを追加
- 生成物を実行時に import するエントリで、クリーンチェックアウトの `kivin generate` が `Cannot find module` で止まるとき、エントリは生成物を実行時に import してはならず `main.ts` で import するという案内を出す
- `listen({ shutdownSignals })` で `onApplicationShutdown` が例外を投げたとき、ログも出さず終了コード 0 になっていた問題を修正。`[kivin] app.close failed` を出力して終了コード 1 にする
- `kivin dev`: 存在しない `--watch` ディレクトリは何も起動する前にエラーにする。シグナルで終了したサーバーを「実行中」と報告しない。`kivin inspect routes` の一時ファイルでサーバーが再起動しない

## [0.0.1] - 2026-06-29

初回のソース公開（タグのみ。npm には未公開）。

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

[0.1.0]: https://github.com/nori-kamiya/kivin/releases/tag/v0.1.0
[0.0.1]: https://github.com/nori-kamiya/kivin/releases/tag/v0.0.1
