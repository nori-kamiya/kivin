# Architecture

## Goal

軽い実行時と、構造化された DX を両立させます。

- runtime: router, context, container, guard, middleware, filter
- build time: TypeScript AST から manifest と OpenAPI を生成
- deployment: Bun single binary

## Package split

### `@kivin/core`

- `defineModule`
- `defineApplication`
- `createApp`
- `Container`
- `Router`
- `RequestContext`
- guard / middleware / exception filter pipeline
- root singleton container と request-local child container

### `@kivin/decorators`

- `@Module`
- `@Injectable`
- `@Controller`
- `@Get`, `@Head`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`
- `@PathParam`, `@QueryParam`, `@Body`
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
6. schema validation を実行する
7. guard を評価する
8. middleware chain を通す
9. controller method を呼び出す
10. response schema があれば validate する
11. Response を返す

現時点の request scope は request-local child container から解決される provider 全般を対象にしています。`context.inject(...)` に加えて、明示的に `scope: 'request'` で登録した controller / guard / middleware / filter も per-request で再構築されます。

一方で、singleton fast path は維持しています。request-scoped token を使わない route は従来どおり create-time に解決した singleton instance と precompiled executor を使い、single-binary performance を崩さない方針です。

## HTTP method policy

single binary deployment 前提なので、method も runtime discovery ではなく compile-time に確定させます。

- current: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`
- current runtime behavior: `HEAD` fallback, explicit `HEAD` / `OPTIONS`, `405 Method Not Allowed`, `Allow` header
- next focus: `PUT` / `PATCH` / `DELETE` を production 向けに使うための周辺 contract を固める

特に `PUT` / `PATCH` / `DELETE` については、単に method を通すだけでは不十分です。single-binary 向け framework としては次を明示的に扱う必要があります。

- idempotency を意識した handler 設計
- `204 No Content` を含む response contract
- not found / conflict / validation failure の標準化
- OpenAPI 上の request/response shape と runtime behavior の一致
- 監査ログや構造化ログで mutation を追えること

## Why this shape

NestJS の重さの原因になりやすい runtime reflection と module discovery を外し、生成済み manifest を実行時入力にすることで Bun compile と相性を合わせています。Hono っぽい軽い pipeline を保ちつつ、NestJS っぽい guard / middleware / filter の責務分離を残す方針です。

そのため、今後の拡張も「実行時に賢くなる」方向ではなく「build 時にグラフを確定して runtime を薄くする」方向で進めます。
