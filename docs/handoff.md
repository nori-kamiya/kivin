# 引き継ぎメモ

kivin の開発を引き継ぐ人向けに、現状・進め方・壊してはいけない設計上の決まりごと・残課題をまとめます（2026-11-13 時点、#81 と issue #61〜#68 の対応まで）。API の詳細は [reference.md](reference.md)、使い方は [production.md](production.md)、性能の記録は [performance.md](performance.md) を見てください。

## 1. 現状

- **段階**: 全パッケージ `0.1.0`。npm への公開準備は完了しているが未公開（ルートは `private: true`）。公開手順とオーナーの作業は [release.md](release.md)。Bun 1.4.0 以上の専用（`Bun.serve` のネイティブルート、`Bun.CryptoHasher`、`Bun.file` などを使う）
- **性能**: CI のペア計測で Hono の 101〜134%、Elysia とは同等（97〜109%、多くの項目で信頼区間が 100% をまたぐ）。詳細は [performance.md](performance.md)
- **機能**: Hono / Elysia の標準ミドルウェア・公式プラグイン相当はほぼ揃っている。意図的に実装しなかったものと理由は §5.1（#68）
- **テスト**: `bun test` で約 800 件（Redis の結合テストは `REDIS_URL` があるときだけ動く）。CI は `Typecheck, test, smoke`（型検査・テスト・single binary の起動確認。Redis のサービスコンテナ付き）、同じ内容の macOS ジョブ（Redis の結合テストはスキップ）、`Performance regression vs base`（性能ゲート）、`Hono / Elysia comparison`（参考値）の 4 ジョブ

## 2. パッケージ構成

core は実行時の中核だけを持ち、独立した機能は領域ごとのパッケージに分けています（#44）。**core はどのプラグインにも依存しません。** プラグインは core（`@kivinjs/static` は `@kivinjs/http` も）にだけ依存します。`@kivinjs/core` は peerDependency なので、プロセス内で必ず 1 つになります（`instanceof HttpError` や `afterResponse` の状態が壊れないように）。

| パッケージ | 役割 | 依存 |
| --- | --- | --- |
| `@kivinjs/core` | ルーティング、DI、モジュール、ライフサイクル、入力検証、Cookie（署名付き含む）/ SSE / WebSocket、CORS、`onRequest` フック、`afterResponse`、`basePath` | — |
| `@kivinjs/decorators` | TC39 デコレータ（`@Controller` / `@Get` / `@UseGuards` / `@StaticResponse` …） | core |
| `@kivinjs/cli` | `kivin generate`（AST → manifest / OpenAPI / contracts / 型付きクライアント / AOT 実行関数）、`dev`、`inspect` | core, openapi, oxc-parser, oxc-resolver |
| `@kivinjs/openapi` | OpenAPI 3.1 生成、Swagger UI の HTML | core |
| `@kivinjs/valibot` / `@kivinjs/standard-schema` | schema adapter | core（valibot は `valibot` も） |
| `@kivinjs/logger` | JSON 構造化ロガー、リクエストロガー | core, decorators |
| `@kivinjs/jwt` | JWT 検証・署名、JWKS、JWT ガード | core |
| `@kivinjs/security` | Basic / Bearer 認証、CSRF、secure headers、レートリミット、IP 制限、`anyGuard` | core |
| `@kivinjs/http` | 圧縮、ETag、タイムアウト、リクエスト ID、ネゴシエーション、ストリーミング、Pretty JSON、Method Override、末尾スラッシュ、プロキシ、HTML テンプレート、リクエストストレージ | core |
| `@kivinjs/static` | 静的ファイル配信 | http（経由で core） |
| `@kivinjs/observability` | Prometheus、OpenTelemetry、Server-Timing、ヘルスチェック | core |
| `@kivinjs/config` | 型付き環境変数 | core |
| `@kivinjs/schedule` | cron ジョブ | なし |
| `@kivinjs/session` | サーバー側セッション | core |
| `@kivinjs/graphql` | GraphQL Yoga のマウント | core |

新しいパッケージを足すときは、`packages/<name>/{package.json,tsconfig.json}`、`tsconfig.base.json` の `paths`、`tsconfig.build.json` の `references`、`bun.lock` の workspace エントリ（`bun install` で更新されるが、手で足す場合は既存の形に合わせる）を揃えます（#49 / #50 が例）。

## 3. 開発の進め方

### コマンド

```bash
bun install
bun run check          # generate + 型検査（examples と contracts.ts を含む）
bun test
bun run example:smoke  # examples/basic を single binary にして起動確認
bun run release:pack && bun run release:verify && bun run pack:smoke   # 公開用 tarball の検査（release:check には含めない。手順は release.md）
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
| HTTP レベルのサーバー CPU 時間 | `scripts/perf/http-cpu/` | サーバーを `taskset` で 1 コアに固定し、リクエストあたりの CPU 時間を交互に計測して比を取る。スループットより安定する（[performance.md](performance.md)「HTTP レベルの promise のコスト」） |

注意:

- 性能ゲートのシナリオ（`scripts/perf/bench-app.ts`）は current 側のものが base 側にも使われます。シナリオを足すのは自由ですが、ベンチアプリが base の `@kivinjs/*` に無い export を import すると base 側のビルドが壊れます
- 2 コアの共有 VM（CI ランナーや作業用コンテナ）では、HTTP 経由のスループットは同じコード同士でも ±10〜20% ぶれます。数 % の差を HTTP のスループットで判断しないこと。インプロセスのペア計測を正とし、HTTP レベルで確かめたいときは `scripts/perf/http-cpu/` で CPU 時間を比べる（#65）
- 残りのオーバーヘッドと、見送った案（raw ルートの AOT 化）の計測は [performance.md](performance.md)「フレームワーク自体のオーバーヘッドの削減」（#66）

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
- **同期的に終わったルートの結果を保留中の promise にしない**: Bun はネイティブルートの戻り値が保留中の promise だと CPU を約 10% 多く使う。解決済みの promise を `.then` でつなぐ所は `thenNow`、promise かもしれない値は `settledValue`（どちらも `Bun.peek`）を使う（#65）
- **使わない機能はコストゼロ**: `onRequest` フックは未設定なら一切ラップしない。`afterResponse` は使われるまで真偽値の確認 1 回だけ（#51）。プラグインは core のホットパスに手を入れない
- **ハンドラの結果を勝手に固定しない**: 起動時に 1 回だけ計算するのは、定数リテラルを返すだけのハンドラ（CLI が判定）と `@StaticResponse()` だけ（#52）
- **コンテキストミドルウェアの `next()` は常に promise を返す**（契約）。raw ミドルウェアの `next()` は同期の `Response` を返すことがある
- **例外フィルタはミドルウェアの外側で動く**。ミドルウェアからは、ハンドラの例外が最終的に何のステータスになったか分からないので、最終レスポンスが必要なもの（メトリクス・トレース・Server-Timing）は `afterResponse` を使う
- **派生リクエスト**: kivin が作り直したリクエスト（ボディ制限、`onRequest` の書き換え）は `linkDerivedRequest` で元のリクエストに紐づける。`getClientAddress` と `afterResponse` はこれで元をたどる
- **エラー**: `HttpError` はそのステータスで応答、それ以外は 500 と 1 回だけのログ（`markErrorReported`）。不正な JSON は 400
- **JSON の content-type** は `application/json;charset=utf-8`（Bun の `Response.json()` と同じ表記）で統一
- **安全側の既定**: IP 制限は不明なアドレスを拒否、署名付き Cookie は名前も署名、セッション ID はクライアントの値を使わない、末尾スラッシュのリダイレクトは `//` 始まりにしない

## 5.1 Hono / Elysia との差分の判断（#68）

Hono / Elysia の標準ミドルウェア・ヘルパー・公式プラグインのうち、最後まで残っていたものの扱いです。

| 機能 | 判断 | 理由 / 代替 |
| --- | --- | --- |
| JSX レンダラー（Hono `jsxRenderer`） | ランタイムは同梱しない。`htmlResponse` が `ReadableStream` を受け取るようにした | Bun は `.tsx` をそのまま実行でき、React / Preact のサーバーレンダラーで足りる。独自の JSX ランタイム（型定義や属性の扱い）を保守するコストに見合わない。使い方は [production.md](production.md)「JSX」 |
| SSG（Hono `ssg`） | 実装しない | API フレームワークとしての優先度が低い。静的ページは別のツールで作り、`@kivinjs/static` で配信する |
| Cache（Hono `cache`） | 実装しない | Bun には Web Cache API が無い。共有のレスポンスキャッシュは Vary・認証付きレスポンス・無効化の設計が要り、誤るとユーザー間で応答が混ざる。ETag（`@kivinjs/http`）と `Cache-Control` + CDN / リバースプロキシで代替する。要望が出たら別 issue にする |
| `combine` の `every` / `except` | 実装した | `everyGuard` / `exceptGuard`（`@kivinjs/security`）。`anyGuard` と同じく DI で合成する（#62） |
| tRPC（Elysia `@elysiajs/trpc`） | アダプタは作らない | `fetchRequestHandler` を `listen({ routes: { '/trpc/*': … } })` に載せるだけで動く（バッチ呼び出し、`onRequest` フックを実物で確認）。[production.md](production.md)「tRPC」 |
| Apollo Server（Elysia `@elysiajs/apollo`） | パッケージは作らない | fetch 用の公式インテグレーションが無いが、`executeHTTPGraphQLRequest` を呼ぶ 30 行ほどの関数で載る（v5 で確認）。fetch ネイティブな GraphQL Yoga を推奨。[production.md](production.md)「Apollo Server」 |
| i18n | 実装しない | 言語の選択は `acceptsLanguage` で足りる。メッセージカタログはアプリ側の関心 |

## 6. 既知の制約

| 内容 | 参照 |
| --- | --- |
| 共有ストアは Redis（Bun 組み込みのクライアント）のみ同梱。cron の分散ロックは「1 tick を 1 回」で、インスタンスをまたいだ重複実行（長いジョブの次の tick）は防がない | [production.md](production.md)「定期実行」（#61） |
| raw ガード / raw ミドルウェア付きのルートは AOT の生成コードを使わない（特化 executor のまま）。効果の上限を測って見送った | [performance.md](performance.md)「フレームワーク自体のオーバーヘッドの削減」（#66） |
| `kivin generate` はエントリとその import 先を実行する（プロバイダとフックは実行しない）。DB クライアントは DI で作る | [production.md](production.md)「データベース接続」 |

## 7. 残課題

2026-11-13 時点でオープンな issue はありません。次に手を付ける候補（優先度は目安）:

| 優先度 | 内容 |
| --- | --- |
| 低 | raw ルートの AOT 化（§6。再検討するなら performance.md の上限の計測から） |
| 低 | `docs/reference.md` の目次とパッケージ README のアンカー（`#kivincore` など）が `@kivinjs` への改名後のものになっていない |
| 判断 | Cache ミドルウェアなど、§5.1 で見送ったものの要望が出たとき |

## 8. 最近の変更（#38〜#81 と issue #61〜#68 の対応）

| PR | 内容 |
| --- | --- |
| #38 | 非 async の raw ガードが promise を返したとき許可扱いになっていた認証バイパスの修正 |
| #39〜#42 | Basic / Bearer 認証・CSRF、本番構成の結合テスト、ボディサイズ制限、リクエスト ID |
| #44 | core とプラグインの分離（`@kivinjs/security` / `@kivinjs/http` / `@kivinjs/static`）。破壊的変更 |
| #45 | promise の段数とリクエスト毎の割り当ての削減（インプロセス幾何平均 +5.9%） |
| #46 | 署名付き Cookie |
| #47 | `onRequest` フック、ネゴシエーション、ストリーミング、Pretty JSON、Method Override、末尾スラッシュ |
| #48 | IP 制限 |
| #49 | `@kivinjs/observability` と `afterResponse` |
| #50 | `@kivinjs/config` / `@kivinjs/schedule` / `@kivinjs/session` / `@kivinjs/graphql` |
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
| #77 | npm 公開の準備（peerDependency 化、リリース基盤、英語 README、パッケージ README） |
| #78 | `kivin init` |
| #79 | `0.1.0` への更新と CHANGELOG の整理 |
| #80 | リリース候補の受け入れ検証で見つかった 20 件の修正（Bun のバージョン確認、インライン schema の警告など） |
| #81 | スコープを `@kivinjs` に変更（npm で `kivin` を取得できなかったため） |
| #61 | `RedisSessionStore` / `RedisRateLimitStore`、cron の分散ロック（`SchedulerOptions.lock`、`createRedisJobLock`）、CI の Redis サービスコンテナ |
| #62 | `anyGuard` の DI 対応（`composesEnhancers`）、`everyGuard` / `exceptGuard` |
| #63 | `handleUnmatched` と、メトリクスの `route="(unmatched)"` |
| #65 | 保留中の promise のコストの計測（`scripts/perf/http-cpu/`）と、`Bun.peek` による同期化（CORS のルートで CPU −9〜11%） |
| #66 | ミドルウェアの無い raw ルートで状態を作らない、raw の状態と `ResponseState` の統合（in-process 幾何平均 +2.1%） |
| #68 | 残りの差分の判断（§5.1）、`htmlResponse` のストリーム対応、JSX / tRPC / Apollo の載せ方 |
| — | `kivin generate` などがトップレベルで開かれたハンドルのせいで終了しない不具合の修正、DB 接続の設計の指針 |

それ以前の変更は `CHANGELOG.md` を見てください。

## 9. 作業環境についての注意

これまでの作業の一部は、npm レジストリに接続できないクラウドの作業環境で行いました。その環境では `hono` / `elysia` / `oxc-parser` 等をインストールできず、`kivin generate` の AST 解析には代替の簡易実装を使っていました。そのため、

- 実際の `oxc-parser` での動作は CI で確認している（CI は通常どおり `bun install --frozen-lockfile`）
- そうした環境で `bun install` を実行すると依存が壊れることがある（ローカルで npm に接続できるなら問題ない）

通常の開発環境（npm に接続できる）では、`bun install` から §3 のコマンドがそのまま使えます。
