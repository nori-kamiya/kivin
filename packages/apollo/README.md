# @kivinjs/apollo

*English | [日本語](#日本語)*

Mount Apollo Server on kivin native routes, with kivin's DI (request-scoped providers included) in the GraphQL context, Apollo's start / stop tied to the app lifecycle, and kivin's error handling in `formatError`.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/apollo @apollo/server graphql@16
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core`, `@apollo/server` (5.x) and `graphql` (16.x) are peer dependencies of this package, so install them in your project too (the command above includes them). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

## Usage

```ts
import { ApolloServer } from '@apollo/server';
import { apolloLifecycle, createApolloRoutes, formatApolloError } from '@kivinjs/apollo';
import { createApp, defineApplication, defineModule } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import manifest from '../.kivin/generated/manifest';
import { UserService } from './users';

const apollo = new ApolloServer<{ users: UserService }>({ typeDefs, resolvers, formatError: formatApolloError });

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [UserService, apolloLifecycle(apollo)], controllers: [], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), manifest);
await app.init(); // starts Apollo

app.listen({
  port: 3000,
  routes: createApolloRoutes(apollo, { app, context: ({ requestContext }) => ({ users: requestContext().inject(UserService) }) }),
  shutdownSignals: true, // app.close() stops Apollo
});
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjsapollo) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

Apollo Server を kivin のネイティブルートに載せます。GraphQL のコンテキストから kivin の DI（request-scoped の provider を含む）を使え、Apollo の起動・停止をアプリのライフサイクルに合わせられます。`formatError` には kivin のエラーの扱いを使えます。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/apollo @apollo/server graphql@16
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core`、`@apollo/server`（5.x）、`graphql`（16.x）はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

### 使い方

```ts
import { ApolloServer } from '@apollo/server';
import { apolloLifecycle, createApolloRoutes, formatApolloError } from '@kivinjs/apollo';
import { createApp, defineApplication, defineModule } from '@kivinjs/core';
import { createValibotAdapter } from '@kivinjs/valibot';
import manifest from '../.kivin/generated/manifest';
import { UserService } from './users';

const apollo = new ApolloServer<{ users: UserService }>({ typeDefs, resolvers, formatError: formatApolloError });

const app = createApp(defineApplication({
  modules: [defineModule({ providers: [UserService, apolloLifecycle(apollo)], controllers: [], imports: [] })],
  schemaAdapter: createValibotAdapter(),
}), manifest);
await app.init(); // Apollo を起動する

app.listen({
  port: 3000,
  routes: createApolloRoutes(apollo, { app, context: ({ requestContext }) => ({ users: requestContext().inject(UserService) }) }),
  shutdownSignals: true, // app.close() で Apollo を停止する
});
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjsapollo)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
