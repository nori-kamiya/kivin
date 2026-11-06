# @kivinjs/standard-schema

*English | [日本語](#日本語)*

Standard Schema adapter for kivin: use Zod, ArkType, Valibot or any Standard Schema validator.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/standard-schema zod
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

Install the validator you use (Zod is shown above).

## Usage

```ts
import { defineApplication, defineModule } from '@kivinjs/core';
import { createStandardSchemaAdapter } from '@kivinjs/standard-schema';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

// Works with Zod, ArkType, Valibot, or any other Standard Schema validator
export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createStandardSchemaAdapter(),
});
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinstandard-schema) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)
- [Schema adapter guide](https://github.com/nori-kamiya/kivin/blob/main/docs/schema-adapter.md) (Japanese)

---

## 日本語

kivin 用の Standard Schema adapter です。Zod、ArkType、Valibot など Standard Schema 対応の validator を使えます。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/standard-schema zod
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

使う validator も入れてください（上の例は Zod）。

### 使い方

```ts
import { defineApplication, defineModule } from '@kivinjs/core';
import { createStandardSchemaAdapter } from '@kivinjs/standard-schema';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

// Works with Zod, ArkType, Valibot, or any other Standard Schema validator
export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createStandardSchemaAdapter(),
});
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinstandard-schema)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
- [schema adapter のガイド](https://github.com/nori-kamiya/kivin/blob/main/docs/schema-adapter.md)
