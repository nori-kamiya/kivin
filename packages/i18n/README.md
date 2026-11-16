# @kivinjs/i18n

*English | [日本語](#日本語)*

Pick each request's language (path prefix, query, cookie or `Accept-Language`, in the order you choose) and translate with typed message catalogs: keys and interpolation params are derived from the default catalog, and numbers, dates and plurals are formatted with `Intl`. Responses get `Content-Language` and `Vary`, and kivin's validation errors can be translated. No npm dependencies.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/i18n
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

## Usage

```ts
import { createI18n, defineMessages, defineTranslation, fromAcceptLanguage, fromPathPrefix, plural } from '@kivinjs/i18n';

const en = defineMessages({
  greeting: 'Hello, {name}',
  cart: { items: plural({ zero: 'Your cart is empty', one: '{count} item', other: '{count} items' }) },
});
const ja = defineTranslation(en, {
  greeting: 'こんにちは、{name}さん',
  cart: { items: plural({ zero: 'カートは空です', other: '{count} 点' }) },
});

export const i18n = createI18n({ messages: { en, ja }, defaultLocale: 'en', detect: [fromPathPrefix(), fromAcceptLanguage()] });

defineApplication({ ..., onRequest: [i18n.onRequest] }); // /ja/cart is routed as /cart

// in a handler, guard or exception filter
i18n.translator(context.request).t('cart.items', { count: 3 }); // "3 点"
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjsi18n) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

リクエストの言語を、パスの接頭辞・クエリ・Cookie・`Accept-Language` から指定した順で決め、型付きのメッセージカタログで翻訳します。キーと補間引数の型は既定言語のカタログから導かれ、数値・日付・複数形は `Intl` で整形します。応答には `Content-Language` と `Vary` が付き、kivin の検証エラーも翻訳できます。npm の依存はありません。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/i18n
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

### 使い方

```ts
import { createI18n, defineMessages, defineTranslation, fromAcceptLanguage, fromPathPrefix, plural } from '@kivinjs/i18n';

const en = defineMessages({
  greeting: 'Hello, {name}',
  cart: { items: plural({ zero: 'Your cart is empty', one: '{count} item', other: '{count} items' }) },
});
const ja = defineTranslation(en, {
  greeting: 'こんにちは、{name}さん',
  cart: { items: plural({ zero: 'カートは空です', other: '{count} 点' }) },
});

export const i18n = createI18n({ messages: { en, ja }, defaultLocale: 'en', detect: [fromPathPrefix(), fromAcceptLanguage()] });

defineApplication({ ..., onRequest: [i18n.onRequest] }); // /ja/cart は /cart としてルーティングされる

// ハンドラ・ガード・例外フィルタで
i18n.translator(context.request).t('cart.items', { count: 3 }); // "3 点"
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjsi18n)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
