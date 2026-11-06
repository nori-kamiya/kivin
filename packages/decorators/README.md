# @kivin/decorators

*English | [日本語](#日本語)*

Module / Controller / Route / Enhancer / OpenAPI decorators for kivin, using TC39 standard decorators (do not enable `experimentalDecorators`). There are no parameter decorators: a handler receives one input object.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/decorators
```

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

Schemas passed to decorators must be exported or written inline, because `kivin generate` reads them statically.

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
bun add @kivin/core @kivin/decorators
```

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

デコレータに渡す schema は、`kivin generate` が静的に読むため、`export` するかその場で式として書く必要があります。

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
