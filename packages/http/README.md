# @kivin/http

*English | [日本語](#日本語)*

HTTP middleware and helpers for kivin: compression, ETag, timeout, request IDs, content negotiation, streaming, pretty JSON, method override, trailing slashes, reverse proxy and HTML templates.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/http @kivin/valibot valibot
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

## Usage

```ts
import { defineApplication, defineModule } from '@kivin/core';
import { createCompressMiddleware, createEtagMiddleware, createRequestIdMiddleware, createTimeoutMiddleware } from '@kivin/http';
import { createValibotAdapter } from '@kivin/valibot';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
  globals: {
    middleware: [createRequestIdMiddleware(), createCompressMiddleware(), createEtagMiddleware(), createTimeoutMiddleware(10_000)],
  },
});
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinhttp) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用の HTTP ミドルウェアとヘルパーです。圧縮、ETag、タイムアウト、リクエスト ID、コンテンツネゴシエーション、ストリーミング、Pretty JSON、Method Override、末尾スラッシュ、リバースプロキシ、HTML テンプレートを提供します。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivin/core @kivin/http @kivin/valibot valibot
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

### 使い方

```ts
import { defineApplication, defineModule } from '@kivin/core';
import { createCompressMiddleware, createEtagMiddleware, createRequestIdMiddleware, createTimeoutMiddleware } from '@kivin/http';
import { createValibotAdapter } from '@kivin/valibot';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
  globals: {
    middleware: [createRequestIdMiddleware(), createCompressMiddleware(), createEtagMiddleware(), createTimeoutMiddleware(10_000)],
  },
});
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinhttp)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
