# @kivin/decorators

*English | [日本語](#日本語)*

Module / Controller / Route / Enhancer / OpenAPI decorators for kivin, using TC39 standard decorators (do not enable `experimentalDecorators`). There are no parameter decorators: a handler receives one input object.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/decorators valibot
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

Guards and middleware passed to decorators must be exported or written inline, because `kivin generate` reads them statically. Export your schemas too: inline schemas validate at runtime, but `kivin generate` warns and skips their contract checks, and the typed client loses their input types.

## Usage

```ts
import { type RouteInput } from '@kivin/core';
import { Controller, Get, Summary, Tag, UseParamSchema } from '@kivin/decorators';
import * as v from 'valibot';

export const IdParams = v.object({ id: v.string() });

@Controller('/users')
@Tag('Users')
export class UserController {
  @Get('/:id')
  @Summary('Find a user')
  @UseParamSchema(IdParams)
  findById({ params }: RouteInput<{ params: typeof IdParams }>) {
    return { id: params.id };
  }
}
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivindecorators) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin の Module / Controller / Route / Enhancer / OpenAPI デコレータです。TC39 標準デコレータを使います（`experimentalDecorators` は有効にしないでください）。引数デコレータはありません。ハンドラは 1 つの入力オブジェクトを受け取ります。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivin/core @kivin/decorators valibot
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

デコレータに渡す guard と middleware は、`kivin generate` が静的に読むため、`export` するかその場で式として書く必要があります。schema も `export` してください。その場で書いた schema は実行時には検証されますが、`kivin generate` は警告を出して contract の検査を省き、型付きクライアントでも入力型が失われます。

### 使い方

```ts
import { type RouteInput } from '@kivin/core';
import { Controller, Get, Summary, Tag, UseParamSchema } from '@kivin/decorators';
import * as v from 'valibot';

export const IdParams = v.object({ id: v.string() });

@Controller('/users')
@Tag('Users')
export class UserController {
  @Get('/:id')
  @Summary('Find a user')
  @UseParamSchema(IdParams)
  findById({ params }: RouteInput<{ params: typeof IdParams }>) {
    return { id: params.id };
  }
}
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivindecorators)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
