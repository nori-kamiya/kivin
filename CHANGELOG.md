# Changelog

このプロジェクトの主要な変更を記録します。
フォーマットは [Keep a Changelog](https://keepachangelog.com/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

### Added

- `@kivin/cli`: `generate` が `contracts.ts` を出力するようになり、`@Body` / `@QueryParam` / `@PathParam` の引数型と schema、ハンドラの戻り値と 2xx レスポンス schema のズレを `tsc` で検出できるようにした
- `@kivin/decorators`: `@Injectable({ deps })` を型付けし、deps の並び・型・個数がコンストラクタ引数と合わない場合にコンパイルエラーにした
- `@kivin/core`: 型付きトークン `createToken<T>()` / `InjectionToken<T>`、`InferSchemaInput` / `InferSchemaOutput` / `RouteContract` 型を追加
- `@kivin/core`: `app.listen()` が `{ port, hostname, routes }` を受け取り、追加の native route を app のルートと一緒に `Bun.serve` へ載せられるようにした（app のルートと衝突するパスはエラー）
- `@kivin/standard-schema`: Standard Schema 対応 validator（Zod / ArkType / Valibot など）用の schema adapter を追加
- decorators / openapi / valibot / listen のテストと、`tests/types` のコンパイル時テストを追加

### Fixed

- リポジトリ直下に `tsconfig.json` を追加。Bun は作業ディレクトリの tsconfig からデコレータの方式を決めるため、ルートで `bun test` / `bun run` を実行すると TC39 デコレータとして動き、メソッド・引数デコレータのメタデータが記録されていなかった（CLI の AST 経路は影響なし）
- README の Quick start を現行 API（`createApp(definition, manifest)`、必須の `schemaAdapter`、default export の manifest）に合わせた

- `@kivin/core`: クエリ schema を持つルートで、クエリ文字列が無いリクエストが `400 query validation failed` になっていた問題を修正（optional なフィールドだけの schema でも空オブジェクトとして検証する）

### Changed

- `@kivin/core`: 2,400 行あった `app.ts` を `src/runtime/` 以下の責務別モジュールに分割（公開 API は変更なし）
- `@kivin/logger`: `LOGGER` / `LOGGER_OPTIONS` を型付きトークンにした
- example は `/openapi.json` と `/docs` を `app.listen({ routes })` の native route として配信するようにした
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
