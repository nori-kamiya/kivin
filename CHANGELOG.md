# Changelog

このプロジェクトの主要な変更を記録します。
フォーマットは [Keep a Changelog](https://keepachangelog.com/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

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
