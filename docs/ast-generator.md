# AST Generator

## Goal

CLI は decorator metadata を runtime で実行せず、TypeScript source を AST 解析して route manifest を生成します。

ただし `kivin generate` / `openapi` / `inspect` は、AST 解析に加えてエントリ（`app.ts`）を `import()` して `defineApplication` の実体（`schemaAdapter` など）を読み込みます。**エントリとその import 先のトップレベルのコードは、`generate` の間に実際に実行されます。** 環境変数の検証（`loadEnv`）・DB 接続・ネットワークアクセスをモジュールの先頭で行うと、シークレットの無いビルド環境や CI で `generate` が失敗します。そうした処理は DI（`envProvider` など）か `main.ts` に置いてください（[production.md](production.md#環境変数kivinconfig)）。

構文解析は [oxc-parser](https://www.npmjs.com/package/oxc-parser)、module 解決は [oxc-resolver](https://www.npmjs.com/package/oxc-resolver) で行い、`typescript` パッケージには依存しません(利用者の TypeScript のバージョンに左右されない)。

## Why

- デコレータの実行時メタデータ（reflection）に依存しない
- `bun build --compile` 前提でも安定する
- route discovery を build-time に固定できる

## Current flow

1. `app.ts` から `defineApplication({ modules: [...] })` を読む
2. `@Module` の `controllers` と `imports` を再帰的にたどる
3. `@Controller`, `@Get`, `@Post`, `@UseBodySchema`, `@UseGuards`, `@UseFilters` などを集める
4. `manifest.ts` を static import つきで生成する
5. generated `manifest.ts` と `schemaAdapter` から `openapi.json` を作る

## Alias resolution

- nearest `tsconfig.json` を探索する(oxc-resolver の `tsconfig: 'auto'`。`extends` も追う)
- `compilerOptions.baseUrl` と `compilerOptions.paths` を読んで module を解決する
- 解決先は TypeScript source(`.ts` / `.tsx` / `.mts` / `.cts`)だけを採用し、`.d.ts` や npm package の JS は bare specifier のまま残す
- `tsconfig.json` が見つからない場合、bare specifier はまず import 元のディレクトリからの相対として探す
- relative import でなくても app / module / controller graph をたどれる

## Import collision avoidance

generated manifest は複数 controller の schema を 1 ファイルに集約するため、別ファイルで同じ local name が使われていると import 衝突が起きます。

現在は generator 側で import local name を一意化し、式中の identifier も同時に書き換えます。

例:

```ts
import { SharedSchema } from '../feature-a/schemas';
import { SharedSchema as __SharedSchema_0 } from '../feature-b/schemas';
```

## Supported patterns

- `defineApplication({ modules: [UsersModule] })`
- `@Module({ controllers: [...], imports: [...] })`
- controller / route decorators
- handler input の分割代入（`find({ params, context })`）。分割代入したキーだけを manifest の `fields` に記録し、分割代入しない場合は全フィールド
- schema / guard / filter / middleware に imported identifier を渡す書き方

## Current constraints

- `controllers`, `imports`, `modules` は identifier 配列前提
- decorator 引数は literal か import 済み identifier / namespace access 前提
- local non-export symbol を decorator 引数に使う形は未対応。decorator に渡す schema・guard・middleware は `export` するか、その場で式として書く（`const IdSchema = ...` を `export` せずに `@UseParamSchema(IdSchema)` へ渡すと `generate` が失敗する）
