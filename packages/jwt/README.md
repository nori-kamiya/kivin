# @kivinjs/jwt

*English | [日本語](#日本語)*

JWT verification and signing (Web Crypto), JWKS key resolvers (remote and local) and an auth guard for kivin.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/jwt @kivinjs/decorators
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

`algorithms` is required, and `exp` is required by default.

## Usage

```ts
import { type RouteInput } from '@kivinjs/core';
import { Controller, Get, UseGuards } from '@kivinjs/decorators';
import { createJwtGuard, createRemoteJwks, getJwtPayload } from '@kivinjs/jwt';

export const AuthGuard = createJwtGuard({
  key: createRemoteJwks('https://auth.example.com/.well-known/jwks.json'),
  algorithms: ['RS256'], // required: the token does not get to choose
  issuer: 'https://auth.example.com',
  audience: 'api',
});

@Controller('/me')
export class MeController {
  @Get('/')
  @UseGuards(AuthGuard)
  me({ context }: RouteInput) {
    return getJwtPayload(context);
  }
}
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjwt) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用の JWT の検証・署名（Web Crypto）、JWKS の鍵リゾルバ（リモート / ローカル）、認証 guard です。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/jwt @kivinjs/decorators
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

`algorithms` は必須で、`exp` も既定で必須です。

### 使い方

```ts
import { type RouteInput } from '@kivinjs/core';
import { Controller, Get, UseGuards } from '@kivinjs/decorators';
import { createJwtGuard, createRemoteJwks, getJwtPayload } from '@kivinjs/jwt';

export const AuthGuard = createJwtGuard({
  key: createRemoteJwks('https://auth.example.com/.well-known/jwks.json'),
  algorithms: ['RS256'], // required: the token does not get to choose
  issuer: 'https://auth.example.com',
  audience: 'api',
});

@Controller('/me')
export class MeController {
  @Get('/')
  @UseGuards(AuthGuard)
  me({ context }: RouteInput) {
    return getJwtPayload(context);
  }
}
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjwt)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
