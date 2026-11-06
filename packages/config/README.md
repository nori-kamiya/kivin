# @kivinjs/config

*English | [日本語](#日本語)*

Typed, validated environment variables for kivin, using any Standard Schema validator or a schema adapter.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/config valibot
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

Do not call `loadEnv` at the top level of a module reachable from your app entry: `kivin generate` runs it at build time.

## Usage

```ts
import { createToken } from '@kivinjs/core';
import { envProvider, loadEnv } from '@kivinjs/config';
import * as v from 'valibot';

const Env = v.object({
  PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer()), '3000'),
  DATABASE_URL: v.pipe(v.string(), v.url()),
});

// In modules reachable from app.ts, use the DI provider: `kivin generate` imports your app,
// and a top-level loadEnv() there would fail a build that has no secrets.
export const ENV = createToken<v.InferOutput<typeof Env>>('app.env');
export const envProviders = [envProvider(ENV, Env)];

// In main.ts (not reached by generate) a direct call is fine:
export function readEnv() {
  return loadEnv(Env); // { PORT: number; DATABASE_URL: string }
}
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinconfig) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)
- [Environment variables guide](https://github.com/nori-kamiya/kivin/blob/main/docs/production.md#環境変数kivinconfig) (Japanese)

---

## 日本語

kivin 用の型付き・検証済みの環境変数です。Standard Schema 対応の validator か schema adapter を使います。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/config valibot
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

アプリのエントリから辿れるモジュールのトップレベルで `loadEnv` を呼ばないでください。`kivin generate` がビルド時に実行します。

### 使い方

```ts
import { createToken } from '@kivinjs/core';
import { envProvider, loadEnv } from '@kivinjs/config';
import * as v from 'valibot';

const Env = v.object({
  PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer()), '3000'),
  DATABASE_URL: v.pipe(v.string(), v.url()),
});

// In modules reachable from app.ts, use the DI provider: `kivin generate` imports your app,
// and a top-level loadEnv() there would fail a build that has no secrets.
export const ENV = createToken<v.InferOutput<typeof Env>>('app.env');
export const envProviders = [envProvider(ENV, Env)];

// In main.ts (not reached by generate) a direct call is fine:
export function readEnv() {
  return loadEnv(Env); // { PORT: number; DATABASE_URL: string }
}
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinconfig)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
- [環境変数のガイド](https://github.com/nori-kamiya/kivin/blob/main/docs/production.md#環境変数kivinconfig)
