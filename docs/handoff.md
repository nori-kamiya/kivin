# 引き継ぎメモ

kivin の開発を引き継ぐ人向けに、現状・進め方・壊してはいけない設計上の決まりごと・残課題をまとめます（2026-11-06 時点、`main` = #76 まで）。API の詳細は [reference.md](reference.md)、使い方は [production.md](production.md)、性能の記録は [performance.md](performance.md) を見てください。

## 1. 現状

- **段階**: 全パッケージ `0.0.1`、npm 未公開（ルートは `private: true`）。Bun 専用（`Bun.serve` のネイティブルート、`Bun.CryptoHasher`、`Bun.file` などを使う）。公開準備は [#57](https://github.com/nori-kamiya/kivin/issues/57)
- **性能**: CI のペア計測で Hono より約 10〜34% 速く、Elysia とは同等（97〜109%、多くの項目で信頼区間が 100% をまたぐ）。詳細は [performance.md](performance.md)
- **機能**: Hono / Elysia の標準ミドルウェア・公式プラグイン相当はほぼ揃っている。意図的に未実装のものと要否は [#68](https://github.com/nori-kamiya/kivin/issues/68)
- **テスト**: `bun test` で約 620 件。CI は `Typecheck, test, smoke`（型検査・テスト・single binary の起動確認）、同じ内容の macOS ジョブ、`Performance regression vs base`（性能ゲート）、`Hono / Elysia comparison`（参考値）の 4 ジョブ

## 2. パッケージ構成

core は実行時の中核だけを持ち、独立した機能は領域ごとのパッケージに分けています（#44）。**core はどのプラグインにも依存しません。** プラグインは core（`@kivin/static` は `@kivin/http` も）にだけ依存します。

| パッケージ | 役割 | 依存 |
| --- | --- | --- |
| `@kivin/core` | ルーティング、DI、モジュール、ライフサイクル、入力検証、Cookie（署名付き含む）/ SSE / WebSocket、CORS、`onRequest` フック、`afterResponse`、`basePath` | — |
| `@kivin/decorators` | TC39 デコレータ（`@Controller` / `@Get` / `@UseGuards` / `@StaticResponse` …） | core |
| `@kivin/cli` | `kivin generate`（AST → manifest / OpenAPI / contracts / 型付きクライアント / AOT 実行関数）、`dev`、`inspect` | core, openapi, oxc-parser, oxc-resolver |
| `@kivin/openapi` | OpenAPI 3.1 生成、Swagger UI の HTML | core |
| `@kivin/valibot` / `@kivin/standard-schema` | schema adapter | core（valibot は `valibot` も） |
| `@kivin/logger` | JSON 構造化ロガー、リクエストロガー | core, decorators |
| `@kivin/jwt` | JWT 検証・署名、JWKS、JWT ガード | core |
| `@kivin/security` | Basic / Bearer 認証、CSRF、secure headers、レートリミット、IP 制限、`anyGuard` | core |
| `@kivin/http` | 圧縮、ETag、タイムアウト、リクエスト ID、ネゴシエーション、ストリーミング、Pretty JSON、Method Override、末尾スラッシュ、プロキシ、HTML テンプレート、リクエストストレージ | core |
| `@kivin/static` | 静的ファイル配信 | http（経由で core） |
| `@kivin/observability` | Prometheus、OpenTelemetry、Server-Timing、ヘルスチェック | core |
| `@kivin/config` | 型付き環境変数 | core |
| `@kivin/schedule` | cron ジョブ | なし |
| `@kivin/session` | サーバー側セッション | core |
| `@kivin/graphql` | GraphQL Yoga のマウント | core |

新しいパッケージを足すときは、`packages/<name>/{package.json,tsconfig.json}`、`tsconfig.base.json` の `paths`、`tsconfig.build.json` の `references`、`bun.lock` の workspace エントリ（`bun install` で更新されるが、手で足す場合は既存の形に合わせる）を揃えます（#49 / #50 が例）。

## 3. 開発の進め方

### コマンド

```bash
bun install
bun run check          # generate + 型検査（examples と contracts.ts を含む）
bun test
bun run example:smoke  # examples/basic を single binary にして起動確認
bun run perf:regression                                # main との性能比較（CI と同じ判定）
PERF_SKIP_NETWORK=1 PERF_SCENARIOS=get-param,patch-global-mw bun run perf:regression   # 速く・絞って
bun run perf:check     # Hono / Elysia との比較（参考値）
```

### PR の作り方（これまでの約束事）

- ブランチを切って PR にし、CI が通ってからマージする。`main` のブランチ保護で `Typecheck, test, smoke` と `Performance regression vs base` を必須にしている
- 性能ゲートが落ちた PR はマージしない（判定は §4）
- 不具合修正には「修正前に失敗するテスト」を付ける
- 利用者に見える変更は `CHANGELOG.md` の `[Unreleased]`（Added / Fixed / Changed、日本語）と、`docs/reference.md` / `docs/production.md` / `README.md` の該当箇所を同じ PR で更新する
- PR の本文は日本語
- サプライチェーン対策のため依存を最小に保つ。npm 依存は原則追加せず、Bun 組み込みや自前実装を先に検討する（結合テスト用の devDependencies は例外として判断した）

### 生成物とスナップショット

- `examples/*/.kivin/generated`、`scripts/perf/generated` は生成物（gitignore 済み）。`bun run check` / `bun run bench:stack:generate` / `bun packages/cli/src/bin.ts generate ...` で作る
- `kivin generate` の出力を変えたら `packages/cli/tests/__snapshots__/` の更新が必要。スナップショットは `buildManifestSourceFromAst({ entry, outFile })` の `source` をそのままファイルに書いたもの（専用の更新コマンドは無い。#45 / #52 で手で再生成した）

## 4. 性能の測り方

| 目的 | 道具 | 備考 |
| --- | --- | --- |
| 自分の変更で遅くならないか | `bun run perf:regression` | base と current の 2 つのアプリを 1 プロセスに読み込み、交互に計測して比を取る。シナリオ 1 つが 4% 以上、または幾何平均が 1.5% 以上遅く、かつ 95% 信頼区間が 1 を下回ると失敗 |
| どこに時間を使っているか | `scripts/perf/profile.ts` + `scripts/perf/summarize-profile.ts` | `ONLY=<シナリオ> bun --cpu-prof --cpu-prof-dir=/tmp/prof scripts/perf/profile.ts` → `bun scripts/perf/summarize-profile.ts /tmp/prof`。自己時間と、TS ソースの包含時間を出す |
| フレームワーク自体のオーバーヘッド | `scripts/perf/floor.ts` | Hono / Elysia 比較用の Stack アプリを、Bun のネイティブルートが呼ぶハンドラとして直接実行し、手書きの最小実装との差（ns）を出す。先に `bun run bench:stack:generate` |
| Hono / Elysia との比較 | `bun run perf:check` | 3 つのバイナリを同時に起動して Latin square で交互に計測。CI では参考値 |

注意:

- 性能ゲートのシナリオ（`scripts/perf/bench-app.ts`）は current 側のものが base 側にも使われます。シナリオを足すのは自由ですが、ベンチアプリが base の `@kivin/*` に無い export を import すると base 側のビルドが壊れます
- 2 コアの共有 VM（CI ランナーや作業用コンテナ）では、HTTP 経由の計測は同じコード同士でも ±10〜20% ぶれます。数 % の差を HTTP で判断しないこと（[#65](https://github.com/nori-kamiya/kivin/issues/65)）。インプロセスのペア計測を正とする
- 現在の残りのオーバーヘッドと削り方の案は [#66](https://github.com/nori-kamiya/kivin/issues/66)

## 5. 設計上の決まりごと（壊さないこと）

### リクエストの実行経路

`app.listen()` は各ルートを Bun のネイティブ `routes` に載せ、ルートごとにコンパイルした実行関数を直接呼びます（`app.fetch` はフォールバックとテスト用）。実行関数はルートの形に合わせて次の順に選ばれます（`packages/core/src/runtime/executor.ts`）。

1. **静的レスポンス**: 引数なしの GET で `docs.staticResponse === true` のもの。ガード等が無ければ Bun が直接返す
2. **特化した raw 実行関数**: raw ガード 1 つ / raw ミドルウェア 1 つ / body の有無 / パスパラメータ等の組み合わせごとに用意。`RequestContext` を作らない
3. **raw パイプライン**: ガード・ミドルウェアがすべて raw 対応（`canActivateRaw` / `handleRaw`）
4. **AOT 実行関数**: `kivin generate` が manifest に出力した、ルート専用の直線的なコード
5. **汎用経路**: request-scoped provider を使うルートなど

ガード・ミドルウェアは `canActivateRaw` / `handleRaw` を実装すると、コンテキストを作らない速い経路に乗ります。新しいミドルウェアは原則両方（`handle` と `handleRaw`）を実装してください。

### 守っている性質

- **promise の段数を増やさない**: 値が promise の時だけ `await` する（`await` は同期値でも microtask を消費する）。body は `request.json().then(validate, rethrowJsonBodyError)` の 1 段で読む（#45）
- **使わない機能はコストゼロ**: `onRequest` フックは未設定なら一切ラップしない。`afterResponse` は使われるまで真偽値の確認 1 回だけ（#51）。プラグインは core のホットパスに手を入れない
- **ハンドラの結果を勝手に固定しない**: 起動時に 1 回だけ計算するのは、定数リテラルを返すだけのハンドラ（CLI が判定）と `@StaticResponse()` だけ（#52）
- **コンテキストミドルウェアの `next()` は常に promise を返す**（契約）。raw ミドルウェアの `next()` は同期の `Response` を返すことがある
- **例外フィルタはミドルウェアの外側で動く**。ミドルウェアからは、ハンドラの例外が最終的に何のステータスになったか分からないので、最終レスポンスが必要なもの（メトリクス・トレース・Server-Timing）は `afterResponse` を使う
- **派生リクエスト**: kivin が作り直したリクエスト（ボディ制限、`onRequest` の書き換え）は `linkDerivedRequest` で元のリクエストに紐づける。`getClientAddress` と `afterResponse` はこれで元をたどる
- **エラー**: `HttpError` はそのステータスで応答、それ以外は 500 と 1 回だけのログ（`markErrorReported`）。不正な JSON は 400
- **JSON の content-type** は `application/json;charset=utf-8`（Bun の `Response.json()` と同じ表記）で統一
- **安全側の既定**: IP 制限は不明なアドレスを拒否、署名付き Cookie は名前も署名、セッション ID はクライアントの値を使わない、末尾スラッシュのリダイレクトは `//` 始まりにしない

## 6. 既知の制約

| 内容 | issue |
| --- | --- |
| セッション・レートリミットはメモリストアのみ同梱。cron は全インスタンスで実行される | [#61](https://github.com/nori-kamiya/kivin/issues/61) |
| `anyGuard` はコンストラクタ依存を持つガードを合成できない | [#62](https://github.com/nori-kamiya/kivin/issues/62) |
| メトリクスはルートに一致しなかったリクエストを数えない | [#63](https://github.com/nori-kamiya/kivin/issues/63) |

## 7. 残課題（issue）

優先度は目安です。

| 優先度 | issue | 内容 |
| --- | --- | --- |
| 高 | [#57](https://github.com/nori-kamiya/kivin/issues/57) | npm 公開の準備（特に `@kivin/core` を peerDependency にすること） |
| 中 | [#58](https://github.com/nori-kamiya/kivin/issues/58) | `kivin init`（#57 の後） |
| 中 | [#61](https://github.com/nori-kamiya/kivin/issues/61) | Redis ストアと cron の分散ロック |
| 低 | [#62](https://github.com/nori-kamiya/kivin/issues/62), [#63](https://github.com/nori-kamiya/kivin/issues/63) | `anyGuard` の DI 対応、未マッチリクエストのメトリクス |
| 低 | [#65](https://github.com/nori-kamiya/kivin/issues/65), [#66](https://github.com/nori-kamiya/kivin/issues/66) | さらなる性能改善（計測環境の用意から） |
| 判断 | [#68](https://github.com/nori-kamiya/kivin/issues/68) | Hono / Elysia との残りの差分（JSX・SSG・Cache・tRPC など）の要否 |

## 8. 最近の変更（#38〜#76）

| PR | 内容 |
| --- | --- |
| #38 | 非 async の raw ガードが promise を返したとき許可扱いになっていた認証バイパスの修正 |
| #39〜#42 | Basic / Bearer 認証・CSRF、本番構成の結合テスト、ボディサイズ制限、リクエスト ID |
| #44 | core とプラグインの分離（`@kivin/security` / `@kivin/http` / `@kivin/static`）。破壊的変更 |
| #45 | promise の段数とリクエスト毎の割り当ての削減（インプロセス幾何平均 +5.9%） |
| #46 | 署名付き Cookie |
| #47 | `onRequest` フック、ネゴシエーション、ストリーミング、Pretty JSON、Method Override、末尾スラッシュ |
| #48 | IP 制限 |
| #49 | `@kivin/observability` と `afterResponse` |
| #50 | `@kivin/config` / `@kivin/schedule` / `@kivin/session` / `@kivin/graphql` |
| #51 | 書き換えたリクエストでの `afterResponse` 修正と、判定のインライン化 |
| #52 | 定数でないハンドラの結果を起動時に固定していた不具合の修正、`@StaticResponse()` |
| #53 | リバースプロキシ、HTML テンプレート、リクエストストレージ、`anyGuard`、レートリミットの共有ストア |
| #54 | Hono / Elysia との最新比較 |
| #55 | `defineApplication({ basePath })` |
| #56 | セッション ID の遅延生成 |
| #71 | プロセス起動直後のリクエストで `afterResponse` が呼ばれない不具合の修正、`enableAfterResponse()` |
| #72 | CI の macOS ジョブ |
| #73 | 実物の OpenTelemetry SDK との結合テスト |
| #74 | 実物の GraphQL Yoga との結合テストと、`createGraphqlRoutes` の型の修正 |
| #75 | `listen({ onShutdownStart, shutdownDelayMs })` |
| #76 | `graphql-ws` の結合テストと配線例 |

それ以前の変更は `CHANGELOG.md` を見てください。

## 9. 作業環境についての注意

これまでの作業の一部は、npm レジストリに接続できないクラウドの作業環境で行いました。その環境では `hono` / `elysia` / `oxc-parser` 等をインストールできず、`kivin generate` の AST 解析には代替の簡易実装を使っていました。そのため、

- 実際の `oxc-parser` での動作は CI で確認している（CI は通常どおり `bun install --frozen-lockfile`）
- そうした環境で `bun install` を実行すると依存が壊れることがある（ローカルで npm に接続できるなら問題ない）

通常の開発環境（npm に接続できる）では、`bun install` から §3 のコマンドがそのまま使えます。
