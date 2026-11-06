# @kivin/graphql

*English | [日本語](#日本語)*

Mount GraphQL Yoga (or any fetch-based GraphQL server) on kivin native routes.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/graphql graphql graphql-yoga
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

kivin does not depend on Yoga; install the server you use.

## Usage

```ts
import { createApp } from '@kivin/core';
import { createGraphqlRoutes } from '@kivin/graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import manifest from '../.kivin/generated/manifest';
import definition from './app';

const yoga = createYoga({
  schema: createSchema({
    typeDefs: 'type Query { hello: String }',
    resolvers: { Query: { hello: () => 'world' } },
  }),
});

createApp(definition, manifest).listen({ port: 3000, routes: createGraphqlRoutes(yoga) });
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivingraphql) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

GraphQL Yoga（または fetch ベースの GraphQL サーバー）を kivin のネイティブルートに載せます。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivin/core @kivin/graphql graphql graphql-yoga
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

kivin は Yoga に依存しません。使うサーバーを入れてください。

### 使い方

```ts
import { createApp } from '@kivin/core';
import { createGraphqlRoutes } from '@kivin/graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import manifest from '../.kivin/generated/manifest';
import definition from './app';

const yoga = createYoga({
  schema: createSchema({
    typeDefs: 'type Query { hello: String }',
    resolvers: { Query: { hello: () => 'world' } },
  }),
});

createApp(definition, manifest).listen({ port: 3000, routes: createGraphqlRoutes(yoga) });
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivingraphql)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
