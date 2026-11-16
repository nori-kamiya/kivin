# @kivinjs/trpc

*English | [日本語](#日本語)*

Mount a tRPC router on kivin native routes, with kivin's DI (request-scoped providers included) in the tRPC context and kivin's `HttpError` mapped to tRPC errors.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/trpc @trpc/server
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core` and `@trpc/server` (11.x) are peer dependencies of this package, so install them in your project too (the command above includes them). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

## Usage

```ts
import { createApp } from '@kivinjs/core';
import { createTrpcRoutes, httpErrors } from '@kivinjs/trpc';
import { initTRPC } from '@trpc/server';
import manifest from '../.kivin/generated/manifest';
import definition from './app';
import { UserService } from './users';

const t = initTRPC.context<{ users: UserService }>().create();
const procedure = t.procedure.use(httpErrors); // HttpError (e.g. notFound()) -> matching tRPC error

export const appRouter = t.router({
  user: procedure.input((value) => value as { id: number }).query(({ ctx, input }) => ctx.users.find(input.id)),
});

const app = createApp(definition, manifest);
app.listen({
  port: 3000,
  routes: createTrpcRoutes(appRouter, {
    app,
    createContext: ({ requestContext }) => ({ users: requestContext().inject(UserService) }),
  }),
});
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjstrpc) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

tRPC のルーターを kivin のネイティブルートに載せます。tRPC のコンテキストから kivin の DI（request-scoped の provider を含む）を使え、kivin の `HttpError` は対応する tRPC のエラーになります。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/trpc @trpc/server
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core` と `@trpc/server`（11.x）はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

### 使い方

```ts
import { createApp } from '@kivinjs/core';
import { createTrpcRoutes, httpErrors } from '@kivinjs/trpc';
import { initTRPC } from '@trpc/server';
import manifest from '../.kivin/generated/manifest';
import definition from './app';
import { UserService } from './users';

const t = initTRPC.context<{ users: UserService }>().create();
const procedure = t.procedure.use(httpErrors); // HttpError（notFound() など）を対応する tRPC のエラーにする

export const appRouter = t.router({
  user: procedure.input((value) => value as { id: number }).query(({ ctx, input }) => ctx.users.find(input.id)),
});

const app = createApp(definition, manifest);
app.listen({
  port: 3000,
  routes: createTrpcRoutes(appRouter, {
    app,
    createContext: ({ requestContext }) => ({ users: requestContext().inject(UserService) }),
  }),
});
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjstrpc)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
