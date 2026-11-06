# Architecture

## Goal

軽い実行時と、構造化された DX を両立させます。

- runtime: router, context, container, guard, middleware, filter
- build time: TypeScript AST から manifest と OpenAPI を生成
- deployment: Bun single binary

## Package split

全パッケージの一覧と依存関係は [handoff.md](handoff.md#2-パッケージ構成) にあります。core は実行時の中核だけを持ち、独立した機能（認証・HTTP ヘルパー・静的ファイル・観測・設定・cron・セッション・GraphQL）は領域ごとのパッケージに分けています。core はどのプラグインにも依存しません。以下は中核パッケージの詳細です。

### `@kivin/core`

- `defineModule`
- `defineApplication`
- `createApp`
- `Container`
- `Router`
- `RequestContext`
- guard / middleware / exception filter pipeline
- root singleton container と request-local child container

`createApp` 本体は `src/app.ts` に置き、実行時の各責務は `src/runtime/` に分けています。

| file | 責務 |
| --- | --- |
| `runtime/types.ts` | manifest / compiled route / Bun route の型と共有定数 |
| `runtime/manifest.ts` | decorator metadata から `AppManifest` を組み立てる（CLI を使わない経路） |
| `runtime/payload.ts` | schema validation と body / query / path payload の遅延ロード |
| `runtime/arguments.ts` | parameter metadata から handler 引数を組み立てて呼び出す |
| `runtime/results.ts` | handler の戻り値を `Response` に変換し、native static response を事前計算する |
| `runtime/pipeline.ts` | guard / middleware / exception filter のコンパイルと実行 |
| `runtime/routing.ts` | path lookup、allowed methods、Bun native `routes` テーブル |
| `runtime/executor.ts` | route ごとに特化 executor を選んで組み立てる |
| `runtime/aot.ts` | `kivin generate` が出力する AOT executor の実行時部品（`AotRouteRuntime`） |

### `@kivin/decorators`

- `@Module`
- `@Injectable`
- `@Controller`
- `@Get`, `@Head`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`
- handler input: `find({ params, query, body, context }: RouteInput<...>)`（引数デコレータは使わない）
- `@Tag`, `@Summary`, `@Response`
- `@UseBodySchema`, `@UseQuerySchema`, `@UseParamSchema`

### `@kivin/valibot`

- Valibot parse wrapper
- Valibot -> JSON Schema adapter

### `@kivin/openapi`

- generated route manifest を OpenAPI 3.1 に変換
- `openapi.json` と docs page の組み立て

### `@kivin/logger`

- function-based provider で root logger を構成
- request middleware で request-scoped child logger を context に載せる
- JSON line を前提に mutation や error を監査しやすくする

### `@kivin/cli`

- アプリ entry を import
- metadata を走査
- manifest.ts と openapi.json を生成
- manifest route と module graph を inspect する

## Runtime model

リクエスト処理は次の流れです。

1. Bun が Request を受ける
2. Router が method と path を解決する
3. `createApp()` 時に事前コンパイルした route executor を選ぶ
4. `RequestContext` か request-scoped provider が必要な route では request-local child container を作る
5. `RequestContext` を作って request container に登録する
6. path / query / header の schema validation を実行する
7. guard を評価する
8. middleware chain を通す（body の読み取りと validate はガードの後、ハンドラ直前に行う）
9. controller method を呼び出す
10. response schema があれば validate する
11. Response を返す

現時点の request scope は request-local child container から解決される provider 全般を対象にしています。`context.inject(...)` に加えて、明示的に `scope: 'request'` で登録した controller / guard / middleware / filter も per-request で再構築されます。

一方で、singleton fast path は維持しています。request-scoped token を使わない route は従来どおり create-time に解決した singleton instance と precompiled executor を使い、single-binary performance を崩さない方針です。

## HTTP method policy

single binary deployment 前提なので、method も runtime discovery ではなく compile-time に確定させます。

- current: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`
- current runtime behavior: `HEAD` fallback, explicit `HEAD` / `OPTIONS`, `405 Method Not Allowed`, `Allow` header

`PUT` / `PATCH` / `DELETE` は、単に method を通すだけでは不十分なので、次を明示的に扱います。

- idempotency を意識した handler 設計
- `204 No Content` を含む response contract
- not found / conflict / validation failure の標準化
- OpenAPI 上の request/response shape と runtime behavior の一致
- 監査ログや構造化ログで mutation を追えること

## Why this shape

NestJS の重さの原因になりやすい runtime reflection と module discovery を外し、生成済み manifest を実行時入力にすることで Bun compile と相性を合わせています。Hono っぽい軽い pipeline を保ちつつ、NestJS っぽい guard / middleware / filter の責務分離を残す方針です。

そのため、今後の拡張も「実行時に賢くなる」方向ではなく「build 時にグラフを確定して runtime を薄くする」方向で進めます。
