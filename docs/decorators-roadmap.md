# Decorators: TC39 standard

kivin は TC39 標準デコレータ（TypeScript 5+ の既定、Bun の既定）で動きます。`experimentalDecorators` は不要で、有効にしないでください。

## 移行の経緯（レガシー → TC39）

旧版はレガシーデコレータ（`experimentalDecorators: true`）を前提にしていました。移行前の調査では、次のことを確認しています（Bun 1.4 / TypeScript 7）。

| | レガシー | TC39 標準 |
| --- | --- | --- |
| クラスデコレータ | `(target)` | `(value, context)` |
| メソッドデコレータ | `(target, key, descriptor)` | `(value, context)` |
| 引数デコレータ | `(target, key, index)` | **Bun は黙って無視**、`tsc` は `TS1206` |

- Bun はデコレータの方式を、実行時の作業ディレクトリの tsconfig から決めます（プロセス単位）。レガシー前提のコードは、tsconfig の置き場所次第で黙って壊れる状態でした。
- TC39 には引数デコレータが無いため、`@Body()` / `@PathParam()` / `@QueryParam()` / `@Context()` を廃止しました。ハンドラは 1 つの入力オブジェクトを受け取る形に変えています。

## 現在の仕組み

- **ハンドラの形**: `find({ params, query, body, context }: RouteInput<{ params: typeof S }>)`
  - CLI は AST から分割代入されたキーを読み、manifest の `parameters` に `{ source: 'input', fields: [...] }` として記録します。実行時は、そのフィールドだけを計算します。
  - 分割代入しない（`find(input)`）場合は全フィールドを渡します。
- **メタデータの保存先**:
  - メソッドデコレータは `context.metadata`（= `Class[Symbol.metadata]`）に、クラスデコレータはクラス自体に保存します。
  - Bun は `Symbol.metadata` をまだ持たないため、`@kivin/core` が well-known symbol（`Symbol.for('Symbol.metadata')`）を補います。
- **型チェック**:
  - 型付き `@Injectable({ deps })` はクラスデコレータなので、そのまま型チェックが効きます。
  - `contracts.ts` は、`RouteInput<...>` の型と `@UseParamSchema` / `@UseQuerySchema` / `@UseBodySchema` のズレを検出します。
- **CLI を使わない経路**: `buildManifest()` のように AST が無い場合は分割代入が見えないので、引数を宣言しているハンドラには全フィールドを渡します。
- **古い書き方の検出**: 引数デコレータが残っているコードは、`kivin generate` が置き換え方を示すエラーで止めます。
