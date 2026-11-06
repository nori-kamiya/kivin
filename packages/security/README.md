# @kivinjs/security

*English | [日本語](#日本語)*

Authentication guards (Basic / Bearer), CSRF protection, secure headers, rate limiting and IP restriction for kivin. Nothing is enabled by default; add what you need.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/decorators @kivinjs/security @kivinjs/valibot valibot
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

## Usage

```ts
// guards.ts
import { createBearerAuthGuard } from '@kivinjs/security';

export const ApiKeyGuard = createBearerAuthGuard({ tokens: [process.env.API_TOKEN!] });
```

```ts
// items.controller.ts
import { Controller, Get, UseGuards } from '@kivinjs/decorators';
import { ApiKeyGuard } from './guards';

@Controller('/items')
export class ItemsController {
  @Get('/')
  @UseGuards(ApiKeyGuard)
  list() {
    return [];
  }
}
```

```ts
// app.ts
import { defineApplication, defineModule } from '@kivinjs/core';
import { createRateLimitMiddleware, createSecureHeadersMiddleware } from '@kivinjs/security';
import { createValibotAdapter } from '@kivinjs/valibot';
import { ItemsController } from './items.controller';

const AppModule = defineModule({ controllers: [ItemsController], providers: [], imports: [] });

export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
  // Nothing is enabled by default: opt in per middleware
  globals: { middleware: [createSecureHeadersMiddleware(), createRateLimitMiddleware({ limit: 100, windowMs: 60_000 })] },
});
```

**Order matters.** Guards run before middleware, so `createRateLimitMiddleware` runs after the guards: a request a guard rejects (a wrong token, a failed login) never reaches it and is not counted, so guessing credentials is not rate limited. To limit authentication attempts, rate limit in front of kivin (reverse proxy or WAF), or put a guard of your own before the auth guard that calls `RateLimitStore.increment` (`MemoryRateLimitStore` is exported) for the client address. The same goes for `createSecureHeadersMiddleware`: it does not add headers to guard rejections.

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinsecurity) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用の認証ガード（Basic / Bearer）、CSRF 保護、secure headers、レートリミット、IP 制限です。何も既定では有効になりません。必要なものを足してください。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/decorators @kivinjs/security @kivinjs/valibot valibot
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

### 使い方

```ts
// guards.ts
import { createBearerAuthGuard } from '@kivinjs/security';

export const ApiKeyGuard = createBearerAuthGuard({ tokens: [process.env.API_TOKEN!] });
```

```ts
// items.controller.ts
import { Controller, Get, UseGuards } from '@kivinjs/decorators';
import { ApiKeyGuard } from './guards';

@Controller('/items')
export class ItemsController {
  @Get('/')
  @UseGuards(ApiKeyGuard)
  list() {
    return [];
  }
}
```

```ts
// app.ts
import { defineApplication, defineModule } from '@kivinjs/core';
import { createRateLimitMiddleware, createSecureHeadersMiddleware } from '@kivinjs/security';
import { createValibotAdapter } from '@kivinjs/valibot';
import { ItemsController } from './items.controller';

const AppModule = defineModule({ controllers: [ItemsController], providers: [], imports: [] });

export default defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
  // Nothing is enabled by default: opt in per middleware
  globals: { middleware: [createSecureHeadersMiddleware(), createRateLimitMiddleware({ limit: 100, windowMs: 60_000 })] },
});
```

**順序に注意してください。** ガードはミドルウェアより前に実行されるため、`createRateLimitMiddleware` はガードの後に動きます。ガードが拒否したリクエスト（誤ったトークン、失敗したログインなど）はこのミドルウェアに届かず、数えられません。つまり認証情報の総当たりは制限されません。認証の試行回数を制限するには、kivin の手前（リバースプロキシや WAF）で制限するか、認証ガードの前に、クライアントアドレスに対して `RateLimitStore.increment`（`MemoryRateLimitStore` が export されています）を呼ぶ独自ガードを置いてください。`createSecureHeadersMiddleware` も同様で、ガードの拒否レスポンスにはヘッダを付けません。

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinsecurity)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
