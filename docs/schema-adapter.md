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

## Swap strategy

将来 `@kivin/zod` を追加しても core の API は変えずに差し替えられます。
