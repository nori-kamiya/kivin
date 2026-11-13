# @kivinjs/session

*English | [日本語](#日本語)*

Server-side sessions for kivin: signed session-ID cookie and pluggable stores (an in-memory store is the default).

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/session @kivinjs/decorators
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

The default in-memory store is for development, tests and a single process only; with several instances use `RedisSessionStore` (below).

## Usage

```ts
import { type RouteInput } from '@kivinjs/core';
import { Controller, Post } from '@kivinjs/decorators';
import { createSessionMiddleware, getSession } from '@kivinjs/session';

// Register in defineApplication({ globals: { middleware: [Sessions] } })
export const Sessions = createSessionMiddleware({
  secret: process.env.SESSION_SECRET!,
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

`SESSION_SECRET` must be set in every environment that loads this module, including the `kivin generate` build. Do not fall back to an empty string: a missing secret is a deployment error, and `?? ''` only moves the failure to the first login.

## Several instances: Redis

`RedisSessionStore` keeps sessions in Redis so every instance sees them. It takes Bun's built-in client (`RedisClient` from `bun`, or `Bun.redis`) as is, so no npm dependency is added; any object with `send(command, args)` works.

```ts
import { RedisClient } from 'bun';
import { createSessionMiddleware, RedisSessionStore } from '@kivinjs/session';

export const Sessions = createSessionMiddleware({
  secret: process.env.SESSION_SECRET!,
  cookie: { secure: true },
  store: new RedisSessionStore(new RedisClient(process.env.REDIS_URL), { prefix: 'myapp:sess:' }), // default prefix: kivin:sess:
});
```

Each session is one key holding its JSON data, expiring with the session lifetime (`SET … PX`), so Redis drops expired sessions itself. When Redis cannot be reached, requests that load a session fail with 500.

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinsession) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用のサーバー側セッションです。署名付きのセッション ID Cookie と、差し替え可能なストア（既定はメモリ）を提供します。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/session @kivinjs/decorators
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

既定のメモリストアは、開発・テスト・単一プロセス向けです。複数インスタンスでは `RedisSessionStore`（下記）を使ってください。

### 使い方

```ts
import { type RouteInput } from '@kivinjs/core';
import { Controller, Post } from '@kivinjs/decorators';
import { createSessionMiddleware, getSession } from '@kivinjs/session';

// Register in defineApplication({ globals: { middleware: [Sessions] } })
export const Sessions = createSessionMiddleware({
  secret: process.env.SESSION_SECRET!,
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

`SESSION_SECRET` は、このモジュールを読み込むすべての環境（`kivin generate` を実行するビルドを含む）で設定してください。空文字列にフォールバックしないでください。secret の欠落はデプロイの誤りであり、`?? ''` は失敗を最初のログインまで先送りするだけです。

### 複数インスタンス: Redis

`RedisSessionStore` はセッションを Redis に保存し、すべてのインスタンスから見えるようにします。Bun 組み込みのクライアント（`bun` の `RedisClient`、または `Bun.redis`）をそのまま渡せるので、npm の依存は増えません（`send(command, args)` を持つオブジェクトなら何でも使えます）。

```ts
import { RedisClient } from 'bun';
import { createSessionMiddleware, RedisSessionStore } from '@kivinjs/session';

export const Sessions = createSessionMiddleware({
  secret: process.env.SESSION_SECRET!,
  cookie: { secure: true },
  store: new RedisSessionStore(new RedisClient(process.env.REDIS_URL), { prefix: 'myapp:sess:' }), // default prefix: kivin:sess:
});
```

セッションごとに 1 つのキーへ JSON を保存し、セッションの有効期間をキーの期限にします（`SET … PX`）。期限切れのセッションは Redis が消します。Redis に届かないと、セッションを読むリクエストは 500 になります。

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinsession)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
