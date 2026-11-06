# @kivin/security

*English | [日本語](#日本語)*

Authentication guards (Basic / Bearer), CSRF protection, secure headers, rate limiting and IP restriction for kivin. Nothing is enabled by default; add what you need.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/security @kivin/valibot valibot
```

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

## Usage

```ts
import { defineApplication, defineModule } from '@kivin/core';
import { createBearerAuthGuard, createRateLimitMiddleware, createSecureHeadersMiddleware } from '@kivin/security';
import { createValibotAdapter } from '@kivin/valibot';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

// Use on a route with @UseGuards(ApiKeyGuard)
export const ApiKeyGuard = createBearerAuthGuard({ tokens: [process.env.API_TOKEN ?? ''] });

export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
  // Nothing is enabled by default: opt in per middleware
  globals: { middleware: [createSecureHeadersMiddleware(), createRateLimitMiddleware({ limit: 100, windowMs: 60_000 })] },
});
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinsecurity) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用の認証ガード（Basic / Bearer）、CSRF 保護、secure headers、レートリミット、IP 制限です。何も既定では有効になりません。必要なものを足してください。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivin/core @kivin/security @kivin/valibot valibot
```

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

### 使い方

```ts
import { defineApplication, defineModule } from '@kivin/core';
import { createBearerAuthGuard, createRateLimitMiddleware, createSecureHeadersMiddleware } from '@kivin/security';
import { createValibotAdapter } from '@kivin/valibot';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

// Use on a route with @UseGuards(ApiKeyGuard)
export const ApiKeyGuard = createBearerAuthGuard({ tokens: [process.env.API_TOKEN ?? ''] });

export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
  // Nothing is enabled by default: opt in per middleware
  globals: { middleware: [createSecureHeadersMiddleware(), createRateLimitMiddleware({ limit: 100, windowMs: 60_000 })] },
});
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinsecurity)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
