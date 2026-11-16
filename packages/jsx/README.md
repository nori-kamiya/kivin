# @kivinjs/jsx

*English | [日本語](#日本語)*

A dependency-free JSX runtime for kivin. Renders to an HTML string or a stream, awaits async components, streams `<Suspense>` content after the page, and wraps pages in route layouts that can read kivin's DI. Text and attribute values are always escaped; raw HTML only goes in through `raw()`, `jsonScript()` or `dangerouslySetInnerHTML`.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/jsx
bun add -d @types/bun typescript
```

In `tsconfig.json`, set `"jsx": "react-jsx"` and `"jsxImportSource": "@kivinjs/jsx"` (Bun reads the same settings). kivin's type declarations need `"moduleResolution": "bundler"`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

## Usage

```tsx
import { createJsxRenderer, render, useRequestContext } from '@kivinjs/jsx';

const Layout = createJsxRenderer<{ title?: string }>(({ title, children }) => (
  <html><head><title>{title}</title></head><body>{children}</body></html>
));

const CurrentUser = () => <p>{useRequestContext().inject(UserService).name()}</p>;

@Controller('/')
class PageController {
  @Get('/')
  @UseMiddleware(Layout)
  home({ context }: RouteInput) {
    return render(context, <CurrentUser />, { props: { title: 'Home' } });
  }
}
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjsjsx) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用の、npm の依存が無い JSX ランタイムです。HTML の文字列またはストリームに描画します。非同期コンポーネントを待ち、`<Suspense>` の中身はページの後からストリームで送ります。ページはルートのレイアウトで包め、レイアウトやコンポーネントから kivin の DI を参照できます。テキストと属性値は常にエスケープします。生の HTML を入れられるのは `raw()`、`jsonScript()`、`dangerouslySetInnerHTML` だけです。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/jsx
bun add -d @types/bun typescript
```

`tsconfig.json` に `"jsx": "react-jsx"` と `"jsxImportSource": "@kivinjs/jsx"` を設定します（Bun も同じ設定を読みます）。kivin の型定義は `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

### 使い方

```tsx
import { createJsxRenderer, render, useRequestContext } from '@kivinjs/jsx';

const Layout = createJsxRenderer<{ title?: string }>(({ title, children }) => (
  <html><head><title>{title}</title></head><body>{children}</body></html>
));

const CurrentUser = () => <p>{useRequestContext().inject(UserService).name()}</p>;

@Controller('/')
class PageController {
  @Get('/')
  @UseMiddleware(Layout)
  home({ context }: RouteInput) {
    return render(context, <CurrentUser />, { props: { title: 'Home' } });
  }
}
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinjsjsx)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
