# @kivin/static

*English | [日本語](#日本語)*

Static file serving for kivin on Bun native routes: ETag / 304, Range, precompressed files and SPA fallback.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/static
```

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

`@kivin/http` is installed automatically as a dependency.

## Usage

```ts
import { createApp } from '@kivin/core';
import { serveStatic } from '@kivin/static';
import manifest from '../.kivin/generated/manifest';
import definition from './valibot';

createApp(definition, manifest).listen({
  port: 3000,
  routes: {
    '/app/*': serveStatic({ root: './web/dist', prefix: '/app', fallback: 'index.html' }), // single-page app
  },
});
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinstatic) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

Bun のネイティブルート上で動く kivin 用の静的ファイル配信です。ETag / 304、Range、事前圧縮ファイル、SPA fallback に対応します。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivin/core @kivin/static
```

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

`@kivin/http` は依存として自動で入ります。

### 使い方

```ts
import { createApp } from '@kivin/core';
import { serveStatic } from '@kivin/static';
import manifest from '../.kivin/generated/manifest';
import definition from './valibot';

createApp(definition, manifest).listen({
  port: 3000,
  routes: {
    '/app/*': serveStatic({ root: './web/dist', prefix: '/app', fallback: 'index.html' }), // single-page app
  },
});
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinstatic)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
