# Decorators: legacy (experimentalDecorators) vs TC39 standard

kivin は現在 TypeScript のレガシーデコレータ（`experimentalDecorators: true`、`emitDecoratorMetadata: false`）を前提にしています。この文書は TC39 標準デコレータへ移行する場合の調査結果と方針です。

## 確認した事実（Bun 1.4 / TypeScript 7）

検証用の最小コード（クラス・メソッド・引数デコレータ）で次を確認しました。

| | レガシー（`experimentalDecorators: true`） | TC39 標準（`false` / 未指定） |
| --- | --- | --- |
| クラスデコレータ | `(target)` | `(value, context)` |
| メソッドデコレータ | `(target, key, descriptor)` | `(value, context)` |
| 引数デコレータ | `(target, key, index)` | **Bun は黙って無視**、`tsc` は `TS1206: Decorators are not valid here` |

- Bun はデコレータの方式を、実行時の **作業ディレクトリの tsconfig** から決めます。リポジトリ直下に `tsconfig.json` が無かった頃は、ルートで `bun test` / `bun run` を実行すると TC39 方式になっていました。その結果、メソッドデコレータと引数デコレータのメタデータが記録されていませんでした。直下に `tsconfig.json` を置いて修正済みです。
- CLI（`kivin generate`）はデコレータを **AST から読む** ため、どちらの方式でも manifest は正しく生成されます。実行時にデコレータへ依存しているのは、ほぼ `@Injectable({ deps })` だけです。これはクラスデコレータなので、両方式で同じように動きます。
- 影響を受けるのは、デコレータのメタデータから manifest を組み立てる経路（`buildManifest()`、`createTestingApp` で manifest を省略した場合）です。

## 移行の障害は引数デコレータ

`@Body()` / `@PathParam('id')` / `@QueryParam()` / `@Context()` は TC39 に存在しない（提案段階）ため、標準デコレータのままでは書けません。ここだけは API の形を変える必要があります。

## 方針案

1. **短期（低リスク、API 互換）**
   - `@kivin/decorators` のクラス・メソッドデコレータを両方式対応にする（引数の形で判定）。
   - TC39 方式で `buildManifest()` が呼ばれ、メタデータが欠けていることを検出したら、黙って空のルートを返さずに明確なエラーにする。
   - アプリ側の tsconfig に `experimentalDecorators: true` が必要なことを README に明記する。
2. **中期（API の追加、レガシーと並存）**
   - 引数デコレータを使わない書き方を追加する。候補は「ハンドラが 1 つの入力オブジェクトを受け取る」形。

     ```ts
     @Get('/:id')
     @UseParamSchema(IdParams)
     find({ params, context }: RouteInput<{ params: typeof IdParams }>) { ... }
     ```

     CLI は AST から分割代入されたキーを読めるので、manifest の `parameters` を生成できます。型は schema から推論されるため、`contracts.ts` で行っているズレ検出の多くが不要になります。
3. **長期**: 2 の形が定着したら、引数デコレータを非推奨にして TC39 標準をデフォルトにする。

2 はユーザーが書くコードの形を変えるので、採用するかどうか、どの形にするかは設計判断が必要です。この PR では調査と方針のまとめにとどめています。
