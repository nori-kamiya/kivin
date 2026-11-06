# @kivin/session

*English | [日本語](#日本語)*

Server-side sessions for kivin: signed session-ID cookie and pluggable stores (an in-memory store is the default).

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/session @kivin/decorators
```

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

The default in-memory store is for development, tests and a single process only.

## Usage

```ts
import { type RouteInput } from '@kivin/core';
import { Controller, Post } from '@kivin/decorators';
import { createSessionMiddleware, getSession } from '@kivin/session';

// Register in defineApplication({ globals: { middleware: [Sessions] } })
export const Sessions = createSessionMiddleware({
  secret: process.env.SESSION_SECRET ?? '',
  cookie: { secure: true },
});

@Controller('/auth')
export class AuthController {
  @Post('/login')
  login({ context }: RouteInput) {
    const session = getSession<{ userId: string }>(context.request);
    session.regenerate(); // new session id on login
    session.set('userId', 'u1');
    return { ok: true };
  }
}
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinsession) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用のサーバー側セッションです。署名付きのセッション ID Cookie と、差し替え可能なストア（既定はメモリ）を提供します。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivin/core @kivin/session @kivin/decorators
```

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

既定のメモリストアは、開発・テスト・単一プロセス向けです。

### 使い方

```ts
import { type RouteInput } from '@kivin/core';
import { Controller, Post } from '@kivin/decorators';
import { createSessionMiddleware, getSession } from '@kivin/session';

// Register in defineApplication({ globals: { middleware: [Sessions] } })
export const Sessions = createSessionMiddleware({
  secret: process.env.SESSION_SECRET ?? '',
  cookie: { secure: true },
});

@Controller('/auth')
export class AuthController {
  @Post('/login')
  login({ context }: RouteInput) {
    const session = getSession<{ userId: string }>(context.request);
    session.regenerate(); // new session id on login
    session.set('userId', 'u1');
    return { ok: true };
  }
}
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinsession)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
