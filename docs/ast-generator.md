# AST Generator

## Goal

CLI は decorator metadata を runtime で実行せず、TypeScript source を AST 解析して route manifest を生成します。

## Why

- Bun の TS 直実行で legacy decorators metadata に依存しない
- `bun build --compile` 前提でも安定する
- route discovery を build-time に固定できる

## Current flow

1. `app.ts` から `defineApplication({ modules: [...] })` を読む
2. `@Module` の `controllers` と `imports` を再帰的にたどる
3. `@Controller`, `@Get`, `@Post`, `@UseBodySchema`, `@UseGuards`, `@UseFilters` などを集める
4. `manifest.ts` を static import つきで生成する
5. generated `manifest.ts` と `schemaAdapter` から `openapi.json` を作る

## Alias resolution

- nearest `tsconfig.json` を探索する
- `compilerOptions.baseUrl` と `compilerOptions.paths` を読んで module を解決する
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
- parameter decorators `@Context`, `@Body`, `@PathParam`, `@QueryParam`
- schema / guard / filter / middleware に imported identifier を渡す書き方

## Current constraints

- `controllers`, `imports`, `modules` は identifier 配列前提
- decorator 引数は literal か import 済み identifier / namespace access 前提
- local non-export symbol を decorator 引数に使う形は未対応

## Next step

より Hono / NestJS に近い実用性へ進めるなら、次が候補です。

- tsconfig path alias 解決の強化
- local symbol rewrite の追加
- OpenAPI operationId / securitySchemes の生成
