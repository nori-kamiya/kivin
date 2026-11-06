# @kivin/valibot

*English | [日本語](#日本語)*

Valibot schema adapter for kivin: validates requests with Valibot and converts schemas to OpenAPI.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/valibot valibot
```

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

`valibot` (^1.5.0) is a peer dependency.

## Usage

```ts
import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
});
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinvalibot) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用の Valibot schema adapter です。Valibot でリクエストを検証し、schema を OpenAPI に変換します。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivin/core @kivin/valibot valibot
```

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

`valibot`（^1.5.0）は peer dependency です。

### 使い方

```ts
import { defineApplication, defineModule } from '@kivin/core';
import { createValibotAdapter } from '@kivin/valibot';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
});
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinvalibot)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
