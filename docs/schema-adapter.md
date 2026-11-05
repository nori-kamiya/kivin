# Schema Adapter

## Intent

フレームワーク本体は schema library に依存しません。`SchemaAdapter` を通して validation と OpenAPI 変換を扱います。

```ts
export interface SchemaAdapter<TSchema = unknown> {
  readonly name: string;
  parse<TOutput>(schema: TSchema, input: unknown): ParseResult<TOutput>;
  toOpenApiSchema(schema: TSchema): Record<string, unknown>;
}
```

## Why Valibot first

- 軽量
- tree-shake しやすい
- Bun 単一バイナリでも依存を小さく保ちやすい

## Current implementation

`@kivin/valibot` は次を提供します。

- `parse` は `safeParse` ベース
- `toOpenApiSchema` は `@valibot/to-json-schema` を利用

## Standard Schema adapter

`@kivin/standard-schema` は [Standard Schema](https://standardschema.dev) に対応した任意の validator（Zod / ArkType / Valibot など）をそのまま使えるアダプタです。

```ts
import { createStandardSchemaAdapter } from '@kivin/standard-schema';

export default defineApplication({
  modules: [UsersModule],
  schemaAdapter: createStandardSchemaAdapter(),
});
```

- `parse` は `schema['~standard'].validate` を呼びます。kivin はリクエスト経路で同期的に検証するため、`validate` が Promise を返す schema（async refinement など）はエラーにします。
- `toOpenApiSchema` は schema が [Standard JSON Schema](https://standardschema.dev/json-schema) を実装していれば `~standard.jsonSchema.input({ target: 'draft-2020-12' })` を使います（Zod 4.2+ / ArkType はそのまま、Valibot は `@valibot/to-json-schema` の `toStandardJsonSchema()` 経由）。実装していない schema は `{}` になるので、`createStandardSchemaAdapter({ toJsonSchema })` で変換関数を渡してください。
- ルート引数と schema の型整合チェック（`kivin generate` が出力する `contracts.ts`）も Standard Schema の型情報で行うため、どの validator でも同じように効きます。

## Swap strategy

core は `SchemaAdapter` にしか依存しないので、validator を替えてもアプリ側は `schemaAdapter` を差し替えるだけです。
