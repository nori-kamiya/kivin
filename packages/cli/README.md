# @kivin/cli

*English | [日本語](#日本語)*

The kivin code generation CLI: `generate` (manifest, contracts, typed client, OpenAPI), `dev` (regenerate and restart on save), `openapi` and `inspect`.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add -d @kivin/cli @kivin/core
```

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

Install it as a dev dependency of your project and call it from `package.json` scripts, for example `"generate": "kivin generate --entry app.ts --outDir .kivin/generated"`. `kivin generate` imports your entry file and everything it imports, so top-level side effects in those modules run during the build.

## Usage

```json
{
  "scripts": {
    "generate": "kivin generate --entry app.ts --outDir .kivin/generated",
    "dev": "kivin dev --entry app.ts --outDir .kivin/generated --main main.ts"
  }
}
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivincli) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)
- [CLI reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivincli) (Japanese)

---

## 日本語

kivin のコード生成 CLI です。`generate`（manifest・contracts・型付きクライアント・OpenAPI）、`dev`（保存のたびに再生成して再起動）、`openapi`、`inspect` を提供します。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add -d @kivin/cli @kivin/core
```

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

プロジェクトの開発依存として入れ、`package.json` の scripts から呼びます（例: `"generate": "kivin generate --entry app.ts --outDir .kivin/generated"`）。`kivin generate` はエントリファイルとその import 先を実際に import するため、それらのモジュールのトップレベルの副作用はビルド時に実行されます。

### 使い方

```json
{
  "scripts": {
    "generate": "kivin generate --entry app.ts --outDir .kivin/generated",
    "dev": "kivin dev --entry app.ts --outDir .kivin/generated --main main.ts"
  }
}
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivincli)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
- [CLI リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivincli)
