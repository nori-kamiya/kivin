# Performance

## Goal

この framework が single-binary deployment 向けに軽くて速いかを、感覚ではなく再現可能な形で確認します。

## Benchmark policy

比較は次の条件で行います。

- compiled binary 同士で比較する
- 同じ in-memory workload を使う
- startup time と binary size も含める
- request throughput だけでなく latency percentiles も見る

現状は次の runtime を比較対象にしています。

- `examples/benchmark-kivin`: `@kivin/core` の manual manifest を使った最小 runtime app
- `examples/benchmark-hono`: 同等 route を持つ Hono app
- `examples/benchmark-elysia`: 同等 route を持つ Elysia app
- それぞれについて `--compile` 実行と `bun run` 実行を比較する
- `health` / `users` / `patch` を個別 variant として比較する

## Commands

```bash
bun install
bun run bench
bun run bench:extended
bun run bench:health
bun run bench:stack
bun run bench:stack:spot
bun run perf:check
```

`bun run bench` は次を実行します。

- `kivin` benchmark binary build
- `hono` benchmark binary build
- binary size 測定
- runtime ごとに process を再起動しながら execution-phase benchmark を複数回実行
- 各 sample で `/health` readiness までの startup 測定
- 各 sample で `GET /users` read workload
- 各 sample で `PATCH /users/:id` mutation workload
- sample 群の中央値を summary として表示
- JSON 出力には raw sample 配列も含める
- profiling section で in-process `app.fetch` と kivin 内部 microbench も出す
- profiling section では direct handler 実行も出す
- profiling section では `context.json` と plain `Response` の差も出す

default の `bun run bench` は minimal baseline (`health` / `users` / `patch`) に絞ります。validation と disabled-log call を足した比較は `bun run bench:extended` か `BENCH_MODE=extended bun run bench` で明示的に回します。

extended mode では次の variant を追加できます。

- `users-validation`
- `patch-validation`
- `patch-logger`
- `patch-validation-logger`
- `create`
- `create-no-request-id`
- `create-no-guard`
- `create-no-validation`
- `create-bare`

必要な variant だけ回したい時は `BENCH_VARIANTS` を併用します。

```bash
BENCH_MODE=extended BENCH_VARIANTS=patch-validation-logger BENCH_ITERATIONS=1 bun run bench
```

`bun run bench:stack` は middleware / guard / filter / validation を含む app-like workload を `kivin` / `hono` / `elysia` で比較します。minimal runtime benchmark とは別に、実運用寄りの path を見るための suite です。summary は各 metric の `mean` と `median` を両方出します。

`bun run bench:stack:spot` は stack suite のうち特定 variant だけを素早く追うための実行です。既定では `docs,users,create` を `1` iteration で回します。必要なら次のように variant を絞れます。

```bash
BENCH_VARIANTS=docs bun run bench:stack:spot
BENCH_VARIANTS=users,create BENCH_ITERATIONS=3 bun run bench:stack:spot
```

`bun run bench:health` は minimal `GET /health` だけを対象に、`kivin` の `context-json` / `plain-response` / `static-object` 実装差を切り分けて測る suite です。Bun route path 上で何が勝ち、何が負けているかを isolated に確認するために使います。

`bun run perf:check` は release candidate 前の lightweight perf gate です。`bench:health` と `bench:stack` を少ない iteration で再実行し、短時間でも比較的安定している勝ち筋だけを見て退行を止めます。stack 側は noise を減らすため `docs,patch,create` に絞って回します。default は `PERF_GATE_ITERATIONS=5` です。

full benchmark の比較対象は `kivin` / `hono` / `elysia` ですが、`perf:check` は今のところ安定性重視で `kivin` 対 `hono` の regression gate に留めています。Elysia は target/runtime として full benchmark では追いますが、gate 条件にはまだ含めていません。

既定では `BENCH_ITERATIONS=5` です。回数を変えたい場合は次のように実行します。

```bash
BENCH_ITERATIONS=7 bun run bench
BENCH_ITERATIONS=7 bun run bench:health
BENCH_ITERATIONS=7 bun run bench:stack
PERF_GATE_ITERATIONS=5 bun run perf:check
```

cross-framework の順位を更新したい時は `10` iteration を基準にする方が安全です。

```bash
BENCH_ITERATIONS=10 bun run bench:stack > .bench/stack-full-$(date +%Y%m%d%H).txt
BENCH_ITERATIONS=10 bun run bench:stack:delete > .bench/stack-delete-$(date +%Y%m%d%H).txt
```

## Current 10-iteration baseline

2026-03-12 の `10` iteration full stack baseline は [stack-full-20260312k.txt](../.bench/stack-full-20260312k.txt) です。mean / median の両方で傾向はほぼ同じでした。

### Full stack summary

compiled mean:

- `health`: `elysia 77.7k > kivin 69.8k > hono 63.6k`
- `docs`: `kivin 80.4k > elysia 78.0k > hono 67.8k`
- `users`: `kivin 76.2k > elysia 73.0k > hono 62.8k`
- `create`: `kivin 51.0k > elysia 49.7k > hono 48.0k`
- `patch`: `kivin 52.1k > elysia 50.8k > hono 47.4k`
- `delete`: `elysia 57.8k > kivin 57.2k > hono 54.1k`

source mean:

- `health`: `kivin 79.5k > elysia 78.5k > hono 62.4k`
- `docs`: `elysia 78.9k > kivin 78.3k > hono 61.1k`
- `users`: `elysia 73.1k > kivin 70.9k > hono 61.5k`
- `create`: `elysia 51.6k > kivin 49.4k > hono 48.9k`
- `patch`: `kivin 53.3k > hono 50.0k > elysia 42.6k`
- `delete`: `kivin 60.5k > hono 54.1k > elysia 53.5k`

読み取りは次です。

- full stack では `kivin` は `Hono` をかなり安定して上回る
- `Elysia` は `health` と軽量 path でまだ強いが、`kivin` は app-like route では strongest tier に入っている
- `compiled delete` はもう僅差で、現状の主な remaining gap は minimal health と isolated delete path に寄っている

### Delete-focused summary

2026-03-12 の `10` iteration delete-focused baseline は [stack-delete-20260312e.txt](../.bench/stack-delete-20260312e.txt) です。

compiled mean:

- `delete`: `elysia 56.1k > hono 44.2k > kivin 39.9k`
- `delete-inline`: `elysia 55.5k > kivin 48.3k > hono 46.2k`
- `delete-no-guard`: `elysia 55.6k > kivin 55.1k > hono 44.4k`
- `delete-bare`: `hono 59.4k > elysia 55.4k > kivin 47.1k`

この suite は isolated rerun なので full stack より振れやすいですが、少なくとも次は言えます。

- `delete-no-guard` では `kivin` は `Elysia` にかなり近い
- realistic な `delete` にはまだ guard/filter/middleware の周辺コストが残っている
- recent core work で raw single guard / raw single middleware / raw response-state path は入っており、remaining gap は router / finalization / benchmark environment noise を切り分けながら詰める段階

### Focused create / patch / delete summary

2026-03-12 の canonical `10` iteration focused CRUD baseline は [stack-spot-create-patch-delete-20260312e.txt](../.bench/stack-spot-create-patch-delete-20260312e.txt) です。

compiled mean:

- `create`: `elysia 43.7k > hono 41.0k > kivin 38.5k`
- `patch`: `kivin 53.8k > elysia 49.0k > hono 44.7k`
- `delete`: `kivin 59.5k > elysia 56.0k > hono 54.4k`

source mean:

- `create`: `kivin 46.6k > hono 42.8k > elysia 42.4k`
- `patch`: `kivin 56.3k > hono 48.2k > elysia 47.5k`
- `delete`: `kivin 56.7k > hono 56.9k > elysia 55.5k`

この focused rerun から言えることは次です。

- `patch` は `compiled` / `source` とも strongest tier を維持している
- `delete` は `compiled` では strongest、`source` でもほぼ strongest tier にある
- `create` は `source` では strongest tier を維持するが、`compiled` はまだ `Hono` / `Elysia` が上
- したがって、`@kivin/core` の current position は「最強クラス」であって、「全 workload で絶対首位」とまではまだ言わない方が正確

2026-03-12 の post-optimization rerun として [stack-spot-create-patch-delete-20260312f.txt](../.bench/stack-spot-create-patch-delete-20260312f.txt) と [stack-spot-create-patch-delete-20260312g.txt](../.bench/stack-spot-create-patch-delete-20260312g.txt) もあります。これらは `201 + no response schema` finalizer の route-specific specialization 後の確認用 artifact ですが、3 framework すべてで振れが大きく、特に `Elysia` の `source` / `compiled delete` が大きく崩れているため canonical baseline には昇格させていません。

2026-03-13 の [stack-spot-create-patch-delete-20260313a.txt](../.bench/stack-spot-create-patch-delete-20260313a.txt) は、`@kivin/logger` の lazy fields 対応で disabled `info` log の field object allocation を避けた後の確認用 rerun です。logger 側の disabled-path 無駄は減らせましたが、focused CRUD の順位は変わらず、`compiled create` は `kivin 38.2k < hono 41.5k < elysia 43.5k` に留まりました。そのため canonical baseline は引き続き `20260312e` を維持します。

この 2 本から safely 言えることは次です。

- `compiled create` は依然として `Hono` / `Elysia` が上で、remaining gap の中心である
- route-specific `201` finalizer 追加だけでは `compiled create` を決定的には詰め切れていない
- latest focused CRUD truth を更新する時は、単発 rerun ではなく複数 rerun の安定性も見て baseline を選ぶ方が安全

### kivin create breakdown

2026-03-13 の kivin-only create breakdown artifact は [kivin-create-breakdown-20260313a.txt](../.bench/kivin-create-breakdown-20260313a.txt) です。これは `compiled` / `source` を kivin だけで比較しつつ、`create` を `create-no-request-id` / `create-no-guard` / `create-no-validation` / `create-bare` に分解した targeted benchmark です。

median の読み取りは次です。

- `compiled create`: `27.7k`
- `compiled create-no-request-id`: `30.5k`
- `compiled create-no-guard`: `42.4k`
- `compiled create-no-validation`: `43.7k`
- `compiled create-bare`: `41.1k`
- `source create`: `40.5k`
- `source create-no-request-id`: `44.0k`
- `source create-no-validation`: `41.9k`
- `source create-bare`: `51.8k`

ここから言えることは次です。

- `request-id` middleware はコスト要因ではあるが、`compiled create` の主因ではない
- `ApiKeyGuard` と body validation を外すと `compiled create` は `42k` から `44k` 台まで上がり、remaining gap の中心が create pipeline 前段に寄っていることが見える
- `source` は full create でも `40k` 台に乗る一方、`compiled` は full create だけ大きく落ちるため、Bun compiled path で create-route の guard/validation 前段をさらに疑うべき

2026-03-13 の [kivin-create-breakdown-20260313b.txt](../.bench/kivin-create-breakdown-20260313b.txt) では、同じ command に in-process profile も追加しました。network benchmark 自体はなお run-to-run variance を含みますが、`app.fetch` profile は比較的素直です。

profile request ops/s:

- `kivin.app.fetch.create`: `242.8k`
- `kivin.app.fetch.create.no-request-id`: `281.1k`
- `kivin.app.fetch.create.no-guard`: `300.4k`
- `kivin.app.fetch.create.no-validation`: `315.4k`
- `kivin.app.fetch.create.bare`: `402.4k`

この profile からは、create path の request-time cost が `request-id` だけでなく guard と validation の双方で段階的に落ちていることがより明確に見えます。特に full create から bare までで約 `1.66x` の差があるため、次の core optimization は response finalization より `canActivateRaw` と body parse/validate の境界を優先して詰める方が妥当です。

2026-03-13 の [kivin-create-breakdown-20260313c.txt](../.bench/kivin-create-breakdown-20260313c.txt) では、`@kivin/core` 側に sync raw guard / raw middleware の promise-check 回避を入れた後の rerun を残しています。cross-run variance はまだありますが、in-process profile の full create は `242.8k -> 260.9k` に上がり、compiled median create もこの rerun では `41.3k` まで戻りました。一方で `no-validation` / `bare` 側は同じ幅では伸びていないため、残差の中心は依然として body parse/validate と request-id 周辺にあります。

同 artifact には direct profile も追加してあります。

- `kivin.guard.raw.create`: `1.22M ops/s`
- `kivin.body.json.parse.create`: `0.91M ops/s`
- `kivin.body.schema.validate.create`: `2.75M ops/s`

この 3 本から、create body route では raw guard 自体より `request.json()` の方が遅く、validation はそれ単体では parse より軽いことが分かります。したがって次の有力手は、guard そのものより body parse と validation の結合境界をさらに薄くすることです。

2026-03-27 の `10` iteration rerun は [kivin-create-breakdown-20260327d.txt](../.bench/kivin-create-breakdown-20260327d.txt) です。今回の median は次でした。

- `compiled create`: `31.4k`
- `compiled create-no-request-id`: `38.7k`
- `compiled create-no-guard`: `37.4k`
- `compiled create-no-validation`: `45.4k`
- `compiled create-bare`: `47.3k`
- `source create`: `40.1k`
- `source create-no-request-id`: `44.0k`
- `source create-no-guard`: `40.0k`
- `source create-no-validation`: `45.5k`
- `source create-bare`: `55.5k`

この rerun では、少なくとも compiled path については以前より一貫した順序が出ています。

- full create から `no-request-id` で約 `1.23x` 改善
- full create から `no-validation` で約 `1.45x` 改善
- full create から `bare` で約 `1.51x` 改善

ここから、現時点では次のように読むのが妥当です。

- `request-id` middleware は依然として無視できないコスト要因
- ただし最大の落ち幅は validation を外した時に出ており、create path の主因は body parse/validate 境界に寄っている
- guard の寄与もあるが、今回の `compiled no-request-id > no-guard` と `source create ~= no-guard` を見る限り、guard 単体を最優先に断定するには弱い

同 artifact の in-process profile もこの読みを支持しています。

- `kivin.app.fetch.create`: `278.9k`
- `kivin.app.fetch.create.no-request-id`: `327.7k`
- `kivin.app.fetch.create.no-guard`: `317.2k`
- `kivin.app.fetch.create.no-validation`: `320.9k`
- `kivin.app.fetch.create.bare`: `427.4k`
- `kivin.guard.raw.create`: `1.47M ops/s`
- `kivin.body.json.parse.create`: `0.96M ops/s`
- `kivin.body.schema.validate.create`: `3.62M ops/s`

raw guard 単体は parse よりかなり軽く、schema validate 単体も parse より軽いままです。したがって、次に詰めるべき場所は guard implementation そのものより、`request.json()` と schema adaptation をまたぐ create 前段の結合コストです。

2026-03-27 の post-response-helper rerun は [kivin-create-breakdown-20260327e.txt](../.bench/kivin-create-breakdown-20260327e.txt) です。`createJsonResponse*` を `Response.json(...)` から direct `JSON.stringify(...) + new Response(...)` fast path に切り替えた後、median は次まで上がりました。

- `compiled create`: `31.4k -> 37.6k`
- `compiled create-no-request-id`: `38.7k -> 53.0k`
- `compiled create-no-guard`: `37.4k -> 55.4k`
- `compiled create-no-validation`: `45.4k -> 56.5k`
- `source create`: `40.1k -> 52.7k`

特に `request-id` 付きの `201 Created` JSON response で改善幅が大きく、queued header + status を通る response finalization が create path の残差に効いていたことが確認できました。とはいえ `compiled create` と `compiled create-bare` の差はまだ約 `1.39x` 残っているため、next bottleneck が create 前段の body parse / schema adaptation 境界にある、という読み自体は変わりません。

2026-03-27 の Elysia-inspired body handoff rerun は [kivin-create-breakdown-20260327k.txt](../.bench/kivin-create-breakdown-20260327k.txt) です。`compileRouteExecutor` は body route でも `request.json()` と schema validate を handler 実行直前まで遅延させるだけでなく、schema adapter が返した validated body をそのまま context cache に handoff するように変わりました。これにより、body parameter と `context.jsonBody()` が同じ transformed object を共有することを core test で固定しています。方向性としては Elysia の `compose.ts` / `dynamic-handle.ts` が parse 後に validator の output を `c.body` へそのまま引き継ぐ設計を参考にしたものです。

この rerun の median は次でした。

- `compiled create`: `35.9k`
- `compiled create-no-request-id`: `49.3k`
- `compiled create-no-guard`: `47.5k`
- `compiled create-no-validation`: `47.1k`
- `compiled create-bare`: `52.7k`
- `source create`: `45.3k`

追加した in-process profile は次でした。

- `kivin.body.json.parse+validate.create`: `762.4k ops/s`
- `kivin.pipeline.local.create.no-finalize`: `740.7k ops/s`
- `kivin.pipeline.local.create`: `438.6k ops/s`

ここから safely 言えることは次です。

- body handoff により body-route validation output の再利用 semantics は明確になった
- `parse -> validate -> handler` と `response finalization` の境界が profile 上で分離できるようになった
- 一方で valid create の network throughput は rerun ごとの振れがまだ大きく、`20260327e` を安定して上回る勝ち筋とはまだ言えない

## Current sample

2026-03-10 時点の単発 sample は次でした。

| runtime | startup ms | binary size | scenario | req/s | avg ms | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| kivin | 316.438 | 58.15 MiB | read-users | 27900.770 | 2.274 | 2.012 | 3.732 | 7.461 |
| kivin | 316.438 | 58.15 MiB | patch-user | 27853.300 | 1.123 | 0.996 | 1.974 | 2.513 |
| hono | 161.621 | 58.18 MiB | read-users | 19122.445 | 3.332 | 1.791 | 6.256 | 42.387 |
| hono | 161.621 | 58.18 MiB | patch-user | 33940.331 | 0.936 | 0.888 | 1.487 | 1.920 |

同セッション内の前回 sample では `read-users` が `kivin 28486 req/s` / `hono 29701 req/s` だったため、特に startup と tail latency は run-to-run variance を見込み、単発の 1 回値だけで結論づけない方が安全です。

## Latest 3-way sample

Elysia を benchmark target に追加した直後の `BENCH_ITERATIONS=1` sample は次でした。これは単発値なので gate の基準には使わず、比較対象を最新化した確認用の数字として扱います。

### Minimal suite

| runtime | launch | variant | artifact | startup ms | req/s | avg ms | p95 ms | p99 ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| kivin | compiled | health | 58.16 MiB | 168.749 | 44296.118 | 1.437 | 2.806 | 4.250 |
| kivin | compiled | users | 58.16 MiB | 52.909 | 41635.223 | 1.515 | 2.851 | 3.704 |
| kivin | compiled | patch | 58.16 MiB | 53.843 | 40020.856 | 0.791 | 1.740 | 2.806 |
| hono | compiled | health | 58.18 MiB | 160.093 | 64359.417 | 0.987 | 1.911 | 2.246 |
| hono | compiled | users | 58.18 MiB | 55.158 | 42507.318 | 1.492 | 2.440 | 3.071 |
| hono | compiled | patch | 58.18 MiB | 54.640 | 50010.140 | 0.632 | 1.335 | 1.698 |
| elysia | compiled | health | 58.84 MiB | 160.241 | 56399.193 | 1.129 | 1.982 | 3.312 |
| elysia | compiled | users | 58.84 MiB | 58.033 | 50915.093 | 1.247 | 2.552 | 3.099 |
| elysia | compiled | patch | 58.84 MiB | 55.582 | 57454.297 | 0.552 | 0.899 | 1.741 |

### Stack suite

| runtime | launch | variant | artifact | startup ms | req/s | avg ms | p95 ms | p99 ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| kivin | compiled | health | 58.19 MiB | 172.152 | 43467.807 | 1.458 | 2.646 | 3.995 |
| kivin | compiled | docs | 58.19 MiB | 53.758 | 62496.745 | 1.013 | 1.942 | 2.494 |
| kivin | compiled | users | 58.19 MiB | 54.599 | 50875.137 | 0.936 | 1.795 | 2.037 |
| kivin | compiled | create | 58.19 MiB | 54.850 | 47936.821 | 0.488 | 0.811 | 2.216 |
| kivin | compiled | patch | 58.19 MiB | 54.050 | 55377.832 | 0.429 | 0.717 | 0.976 |
| kivin | compiled | delete | 58.19 MiB | 54.470 | 57056.132 | 0.415 | 0.689 | 1.210 |
| hono | compiled | health | 58.18 MiB | 210.259 | 49477.880 | 1.284 | 2.611 | 4.896 |
| hono | compiled | docs | 58.18 MiB | 55.908 | 62369.941 | 1.019 | 2.155 | 2.569 |
| hono | compiled | users | 58.18 MiB | 55.817 | 61231.175 | 0.774 | 1.498 | 2.088 |
| hono | compiled | create | 58.18 MiB | 55.426 | 43591.344 | 0.540 | 1.264 | 1.481 |
| hono | compiled | patch | 58.18 MiB | 56.333 | 53220.743 | 0.444 | 0.787 | 1.357 |
| hono | compiled | delete | 58.18 MiB | 54.379 | 61637.205 | 0.384 | 0.672 | 1.390 |
| elysia | compiled | health | 58.84 MiB | 211.097 | 57299.065 | 1.111 | 2.646 | 5.225 |
| elysia | compiled | docs | 58.84 MiB | 56.682 | 79932.190 | 0.794 | 1.253 | 2.009 |
| elysia | compiled | users | 58.84 MiB | 56.270 | 68152.002 | 0.698 | 1.283 | 1.560 |
| elysia | compiled | create | 58.84 MiB | 54.838 | 64764.218 | 0.364 | 0.831 | 1.438 |
| elysia | compiled | patch | 58.84 MiB | 55.831 | 65537.671 | 0.362 | 0.801 | 1.231 |
| elysia | compiled | delete | 58.84 MiB | 55.755 | 76208.862 | 0.312 | 0.471 | 1.234 |

この 3-way sample の読み取りは次です。

- minimal では `kivin` は `users` で Hono とほぼ同水準、`patch` では Hono を下回り、今回の単発値では Elysia が strongest でした
- compiled stack では `kivin` は `docs` / `create` / `patch` で Hono を上回りましたが、`users` / `delete` は Hono が強く、Elysia は全 variant でさらに高い値を出しています
- startup は `kivin` と Hono が概ね同水準で、compiled Elysia は binary startup がやや重い一方、request throughput はかなり強いです
- Elysia を benchmark target に追加したことで、今後の性能目標は Hono だけでなく Elysia も含む 3-way 比較で見る前提になりました

## 2026-03-27 3-iteration sample

2026-03-27 の short rerun artifact は次です。

- minimal baseline: [minimal-3way-20260327.txt](../.bench/minimal-3way-20260327.txt)
- stack main routes: [stack-main-20260327.txt](../.bench/stack-main-20260327.txt)
- minimal extended: [minimal-extended-20260327.txt](../.bench/minimal-extended-20260327.txt)

これは `3` iteration の確認用 sample であり、canonical baseline の置き換えではありません。ただし、現時点の 3-way relative position を把握するには十分使えます。

### Minimal baseline median

single-binary target を主眼に、compiled median だけ抜くと次でした。

| runtime | health req/s | users req/s | patch req/s | startup ms |
| --- | ---: | ---: | ---: | ---: |
| kivin | 51343.071 | 77669.316 | 61753.597 | 52.780-53.955 |
| hono | 76957.264 | 75850.953 | 70484.028 | 54.160-55.233 |
| elysia | 77424.999 | 75036.111 | 73380.733 | 56.044-57.040 |

この sample では次が見えます。

- `users` は `kivin` が 3-way で首位
- `patch` はまだ `elysia > hono > kivin`
- `health` は `hono` と `elysia` が強く、`kivin` は最小 route path の改善余地が残る
- startup は `kivin` が最も軽く、差は小さいが single-binary の立ち上がりではまだ競争力がある

### Stack main-route median

app-like path の compiled median は次でした。

| runtime | docs req/s | users req/s | create req/s | patch req/s | delete req/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| kivin | 47161.909 | 64441.502 | 52351.452 | 22965.558 | 27281.904 |
| hono | 64023.817 | 61280.644 | 52480.237 | 54890.165 | 52339.213 |
| elysia | 75981.347 | 75842.802 | 65121.303 | 59769.885 | 49074.697 |

この rerun では前回 canonical baseline よりも `kivin compiled patch/delete` がかなり低く出ています。一方で `kivin compiled users` は Hono を上回っており、`create` も Hono とほぼ同水準です。この時点では、現時点の compiled stack を次のように暫定解釈していました。

- `kivin` は `users` と `create` では Hono と戦える
- `patch` と `delete` はこの rerun では大きく崩れており、再現確認が必要
- `elysia` は 5 variant 全体で strongest tier を維持している

`kivin source patch/delete` は同 artifact で `39.9k / 51.2k` まで戻っているため、今回の大きな落ち込みは compiled path 寄りの現象として切り分ける価値があります。

### Focused patch / delete rerun

上の崩れが再現するかを確認するため、2026-03-27 に `patch,delete` だけを `10` iteration で再測定した artifact を追加しました: [stack-patch-delete-20260327b.txt](../.bench/stack-patch-delete-20260327b.txt)

compiled median:

| runtime | patch req/s | delete req/s | startup ms |
| --- | ---: | ---: | ---: |
| kivin | 45794.902 | 51717.113 | 53.223-53.665 |
| hono | 47353.012 | 55244.429 | 55.740-55.755 |
| elysia | 45549.250 | 57036.670 | 55.874-55.946 |

source median:

| runtime | patch req/s | delete req/s | startup ms |
| --- | ---: | ---: | ---: |
| kivin | 52071.805 | 56306.181 | 52.134-52.421 |
| hono | 48383.823 | 51545.452 | 54.156-54.264 |
| elysia | 49722.682 | 55350.749 | 54.650-54.709 |

この focused rerun から言えることは次です。

- `kivin compiled patch/delete` の 3-iteration 崩れは再現しなかった
- `compiled patch` は `kivin` と `elysia` がほぼ同水準で、`hono` との差も小さい
- `compiled delete` は `elysia > hono > kivin` だが、3-iteration sample のような極端な落ち込みではない
- `source patch/delete` はどちらも `kivin` が首位で、stack path 自体の実装が壊れているわけではない

したがって、2026-03-27 の full stack 3-iteration sample に見えた `kivin compiled patch/delete` の大崩れは、現時点では regression 断定ではなく run-to-run variance か sample interaction の可能性が高いと扱うのが妥当です。

### Focused 3-way create rerun

create だけを `10` iteration で再測定した artifact を追加しました: [stack-create-20260327d.txt](../.bench/stack-create-20260327d.txt)

compiled median:

| runtime | create req/s | startup ms |
| --- | ---: | ---: |
| kivin | 37564.126 | 53.537 |
| hono | 42999.007 | 56.117 |
| elysia | 37060.705 | 56.048 |

source median:

| runtime | create req/s | startup ms |
| --- | ---: | ---: |
| kivin | 45822.121 | 52.374 |
| hono | 43907.164 | 54.063 |
| elysia | 41762.724 | 54.782 |

この rerun からの読みは次です。

- `source create` は `kivin` が Hono/Elysia を上回った
- `compiled create` は今回の rerun では `hono` が最も高く、`kivin` と `elysia` は近い
- したがって body handoff 変更後の 3-way create はまだ勝ち筋が安定したとは言えず、canonical create baseline を置き換えるには追加 rerun が必要

### Extended create / validation median

minimal extended の compiled median を抜くと次でした。

| runtime | users-validation | patch-validation | patch-logger | patch-validation-logger | create |
| --- | ---: | ---: | ---: | ---: | ---: |
| kivin | 49421.256 | 54050.727 | 62627.648 | 58758.913 | 51949.401 |
| hono | 71638.156 | 61718.025 | 68588.413 | 53910.940 | 37843.668 |
| elysia | 70081.929 | 64139.455 | 37344.825 | 44588.614 | 42712.454 |

create breakdown の `kivin compiled` は次でした。

| variant | req/s |
| --- | ---: |
| create | 51949.401 |
| create-no-request-id | 51413.113 |
| create-no-guard | 48722.358 |
| create-no-validation | 50620.201 |
| create-bare | 44155.959 |

この 3-iteration sample だけを見る限り、create breakdown は以前の `2026-03-13` artifact ほど素直に単調減少しません。したがって、今回の数字から「request-id が主因」「guard が主因」のような強い結論はまだ出さない方が安全です。ここで確実に言えるのは次です。

- `kivin compiled create` 自体は今回 `hono` と `elysia` を上回った
- `kivin compiled patch-logger` と `patch-validation-logger` は Hono/Elysia と十分競れる帯にいる
- `users-validation` と `patch-validation` ではまだ Hono/Elysia が上で、validation path の最適化余地が残る
- create path の causal analysis を更新するには、kivin-only breakdown を `5-10` iteration で rerun して variance を潰すべき

## Current median result

2026-03-11 時点の現行 benchmark は `5` 回の execution-phase sample の中央値で次でした。

| runtime | launch | variant | artifact | startup ms | scenario | req/s | avg ms | p95 ms | p99 ms |
| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| kivin | compiled | health | 58.15 MiB | 53.864 | health | 67234.612 | 0.944 | 1.825 | 2.282 |
| kivin | compiled | users | 58.15 MiB | 53.786 | read-users | 78253.895 | 0.808 | 1.454 | 2.034 |
| kivin | compiled | patch | 58.15 MiB | 53.885 | patch-user | 66793.450 | 0.473 | 0.888 | 1.341 |
| kivin | source | health | source | 52.759 | health | 76241.740 | 0.835 | 1.584 | 1.922 |
| kivin | source | users | source | 52.982 | read-users | 72117.264 | 0.878 | 1.551 | 1.952 |
| kivin | source | patch | source | 52.424 | patch-user | 65410.423 | 0.485 | 0.741 | 1.556 |
| hono | compiled | health | 58.18 MiB | 55.255 | health | 79679.846 | 0.799 | 1.464 | 2.069 |
| hono | compiled | users | 58.18 MiB | 54.639 | read-users | 78252.109 | 0.812 | 1.526 | 2.007 |
| hono | compiled | patch | 58.18 MiB | 54.664 | patch-user | 68783.016 | 0.458 | 0.768 | 1.244 |
| hono | source | health | source | 53.276 | health | 79923.753 | 0.797 | 1.310 | 1.985 |
| hono | source | users | source | 53.857 | read-users | 75422.997 | 0.839 | 1.611 | 1.995 |
| hono | source | patch | source | 53.722 | patch-user | 67615.663 | 0.466 | 0.793 | 1.383 |

## Current profiling result

同時に in-process profiling も取っています。2026-03-11 時点の sample は次でした。

| metric | ops/s | iterations |
| --- | ---: | ---: |
| kivin.router.match.static | 20273012.606 | 100000 |
| kivin.router.match.param | 6208175.522 | 100000 |
| kivin.response.plain.json | 1937271.160 | 50000 |
| kivin.handler.direct.read-users | 9332675.442 | 100000 |
| hono.handler.direct.read-users | 8587284.379 | 100000 |
| kivin.app.fetch.health.context-json | 703403.856 | 10000 |
| kivin.app.fetch.health.plain-response | 1340624.723 | 10000 |
| kivin.app.fetch.read-users | 531674.509 | 10000 |
| kivin.app.fetch.patch.no-body.no-guard | 481288.907 | 10000 |
| kivin.app.fetch.patch.json-only.no-guard | 435412.859 | 10000 |
| kivin.app.fetch.patch.schema.no-guard | 421001.668 | 10000 |
| kivin.app.fetch.patch.schema.context-guard | 352639.885 | 10000 |
| kivin.app.fetch.patch.schema.raw-guard | 373412.995 | 10000 |
| hono.app.fetch.read-users | 391015.114 | 10000 |
| hono.app.fetch.patch | 304687.619 | 10000 |

現時点の読み取りとしては次です。

- binary size は `kivin` と `hono` でほぼ同等
- startup は variant 別でもほぼ同等で、中央値はどちらも概ね `53ms` 台から `54ms` 台に収まっている
- `users` は compiled/source とも今回の sample では `kivin` が Hono を上回った
- `patch` は compiled/source とも今回の sample では `kivin` が Hono を上回った
- `health` は compiled では `kivin` が Hono を上回った一方、source ではまだ Hono がわずかに強い
- 単発 sample より中央値の方が安定しており、今後はこの値を主に見るべき
- raw sample 配列も JSON に出るので、中央値だけでなく outlier の混入も追える
- `router.match.static` は `20M ops/s` を超え、single-param fast path で `router.match.param` も `6.2M ops/s` まで改善した
- direct handler 実行でも `kivin` が `hono` を上回っており、純粋な handler ロジックはボトルネックではなさそう
- in-process `app.fetch` でも `kivin` が `hono` を上回っており、network benchmark の差は binary/server integration 側にも要因がある可能性が高い
- `kivin.app.fetch.health.plain-response` は `kivin.app.fetch.health.context-json` より約 `90%` 高速で、最小 route では `context.json` の overhead が非常に大きいことが分かる
- `kivin.app.fetch.patch.no-body.no-guard` から `kivin.app.fetch.patch.json-only.no-guard` への落ち幅は約 `11%` で、PATCH の主コストはまず JSON body parse にある
- `kivin.app.fetch.patch.json-only.no-guard` と `kivin.app.fetch.patch.schema.no-guard` はほぼ同等で、現在の passthrough schema adapter では schema parse 自体の上乗せは小さい
- `kivin.app.fetch.patch.schema.context-guard` は `kivin.app.fetch.patch.schema.raw-guard` より約 `6%` 遅く、raw guard fast path は効いているが、guard 自体を完全に消すほどではない
- `kivin.app.fetch.patch.schema.raw-guard` は `hono.app.fetch.patch` を大きく上回っており、route core ではすでに優位に立てている

## Current benchmark method

現在の benchmark は単発値ではなく、実行フェーズを複数回回して平均値と中央値を併記する方式です。

- build は benchmark 開始時に 1 回だけ行う
- startup は各 sample で process を再起動して測る
- throughput / latency も各 sample で再計測する
- summary は平均値と中央値を両方出す
- launch mode は `compiled` と `source` の両方を測る
- route variant は `health` / `users` / `patch` を個別に測る

これにより、build 時間を runtime 比較に混ぜず、単発 run のばらつきも抑えます。

補足として、raw sample を見ると最初の startup sample だけ大きく外れることがあります。中央値はこの cold-start outlier を summary に過大反映させないために重要で、平均値は regression の総量を見るために併記しています。

profiling を見る限り、次に疑うべき点は router 本体よりも compiled runtime と Bun server の噛み合わせ、あるいは `--compile` 時の server path です。

## Follow-up minimal result

exact static route fast path を追加した後、minimal suite を `5` sample で再測定した結果は次でした。

| runtime | launch | variant | artifact | startup ms | scenario | req/s | avg ms | p95 ms | p99 ms |
| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| kivin | compiled | health | 58.15 MiB | 53.453 | health | 62130.260 | 1.027 | 1.894 | 2.451 |
| kivin | compiled | users | 58.15 MiB | 53.185 | read-users | 66281.498 | 0.954 | 1.697 | 1.968 |
| kivin | compiled | patch | 58.15 MiB | 52.905 | patch-user | 68513.354 | 0.461 | 0.822 | 1.588 |
| kivin | source | health | source | 52.023 | health | 77067.332 | 0.825 | 1.354 | 2.106 |
| kivin | source | users | source | 52.270 | read-users | 78168.257 | 0.811 | 1.552 | 1.937 |
| kivin | source | patch | source | 51.873 | patch-user | 73530.161 | 0.429 | 0.725 | 1.252 |
| hono | compiled | health | 58.18 MiB | 54.881 | health | 80655.623 | 0.788 | 1.494 | 1.986 |
| hono | compiled | users | 58.18 MiB | 54.746 | read-users | 77842.044 | 0.810 | 1.515 | 2.041 |
| hono | compiled | patch | 58.18 MiB | 54.271 | patch-user | 70481.544 | 0.446 | 0.761 | 1.243 |
| hono | source | health | source | 53.322 | health | 80007.467 | 0.795 | 1.397 | 1.870 |
| hono | source | users | source | 53.436 | read-users | 67254.709 | 0.944 | 1.597 | 2.251 |
| hono | source | patch | source | 53.544 | patch-user | 69029.389 | 0.456 | 0.799 | 1.300 |

この follow-up では `kivin` は source `users` / `patch` で引き続き優位でしたが、minimal `health` は compiled/source ともまだ Hono に届いていません。exact static route fast path 自体は挙動回帰を防ぎつつ dispatch の allocation を減らせていますが、minimal health の勝ち筋としてはまだ十分ではなく、Bun native route path の詰めが残っています。

## Health implementation benchmark

minimal `health` の差を route 実装ごとに切り分けた `3` sample median は次でした。

| runtime | launch | health mode | artifact | startup ms | req/s | avg ms | p95 ms | p99 ms |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| kivin | compiled | context-json | 58.15 MiB | 53.889 | 51304.327 | 1.242 | 2.377 | 3.397 |
| kivin | compiled | plain-response | 58.15 MiB | 54.080 | 80623.705 | 0.789 | 1.418 | 1.846 |
| kivin | compiled | static-object | 58.15 MiB | 53.567 | 81845.674 | 0.777 | 1.218 | 1.728 |
| kivin | source | context-json | source | 52.332 | 83029.526 | 0.767 | 1.222 | 1.814 |
| kivin | source | plain-response | source | 52.195 | 81356.098 | 0.782 | 1.313 | 1.888 |
| kivin | source | static-object | source | 51.942 | 83351.161 | 0.763 | 1.216 | 1.718 |
| hono | compiled | baseline | 58.18 MiB | 54.395 | 72336.262 | 0.880 | 1.573 | 2.408 |
| hono | source | baseline | source | 53.289 | 82923.323 | 0.765 | 1.174 | 1.748 |

読み取りとしては次です。

- compiled では `kivin` の `plain-response` と `static-object` はどちらも Hono baseline を上回る
- compiled で遅い主因は `context-json` 実装で、minimal route では context construction と helper path の重さがそのまま出る
- source では `kivin static-object` と Hono baseline はほぼ同水準で、remaining gap は runtime core というより Bun source execution の揺れに近い
- `static-object` が最良だったので、minimal health で勝つための勝ち筋は context を避けた precomputed static response path にある

## Stack benchmark

app-like suite を `docs` / `create` / `delete` まで広げた `3` sample median は次でした。

| runtime | launch | variant | artifact | startup ms | scenario | req/s | avg ms | p95 ms | p99 ms |
| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| kivin | compiled | health | 58.18 MiB | 55.045 | health | 56012.472 | 1.137 | 2.152 | 2.487 |
| kivin | compiled | docs | 58.18 MiB | 53.608 | docs-html | 77563.223 | 0.820 | 1.508 | 1.850 |
| kivin | compiled | users | 58.18 MiB | 53.929 | read-users | 58027.415 | 0.822 | 1.576 | 2.092 |
| kivin | compiled | create | 58.18 MiB | 53.653 | create-user | 55006.257 | 0.430 | 0.759 | 1.282 |
| kivin | compiled | patch | 58.18 MiB | 53.818 | patch-user | 57411.435 | 0.413 | 0.709 | 1.324 |
| kivin | compiled | delete | 58.18 MiB | 54.168 | delete-user | 58928.097 | 0.404 | 0.810 | 1.130 |
| kivin | source | health | source | 52.904 | health | 73226.098 | 0.868 | 1.623 | 2.108 |
| kivin | source | docs | source | 52.707 | docs-html | 78113.939 | 0.815 | 1.349 | 1.896 |
| kivin | source | users | source | 53.163 | read-users | 65631.009 | 0.722 | 1.319 | 1.783 |
| kivin | source | create | source | 52.145 | create-user | 59828.740 | 0.394 | 0.684 | 1.243 |
| kivin | source | patch | source | 52.686 | patch-user | 61415.000 | 0.384 | 0.686 | 1.183 |
| kivin | source | delete | source | 53.264 | delete-user | 55258.491 | 0.430 | 0.855 | 1.125 |
| hono | compiled | health | 58.18 MiB | 56.126 | health | 62040.713 | 1.017 | 2.012 | 2.772 |
| hono | compiled | docs | 58.18 MiB | 55.284 | docs-html | 62503.418 | 1.015 | 1.963 | 2.612 |
| hono | compiled | users | 58.18 MiB | 55.648 | read-users | 61489.145 | 0.770 | 1.521 | 1.965 |
| hono | compiled | create | 58.18 MiB | 54.988 | create-user | 54708.210 | 0.431 | 0.751 | 1.382 |
| hono | compiled | patch | 58.18 MiB | 55.191 | patch-user | 47132.314 | 0.503 | 0.851 | 1.105 |
| hono | compiled | delete | 58.18 MiB | 55.656 | delete-user | 54065.258 | 0.439 | 0.836 | 0.952 |
| hono | source | health | source | 54.368 | health | 61504.241 | 1.031 | 1.784 | 2.226 |
| hono | source | docs | source | 53.835 | docs-html | 66846.131 | 0.947 | 1.839 | 2.430 |
| hono | source | users | source | 54.169 | read-users | 62288.996 | 0.760 | 1.481 | 1.924 |
| hono | source | create | source | 54.020 | create-user | 52382.418 | 0.450 | 0.854 | 1.375 |
| hono | source | patch | source | 54.676 | patch-user | 46822.765 | 0.503 | 0.857 | 1.256 |
| hono | source | delete | source | 54.677 | delete-user | 51035.423 | 0.468 | 0.942 | 1.204 |

この expanded suite では次が見えます。

- `kivin` は source の全 variant で Hono を上回った
- compiled では `docs` / `create` / `patch` / `delete` で `kivin` が優位、`health` と `users` はまだ Hono が強い
- docs-read のような static text/html path でも `kivin` の app-like pipeline は十分競争力がある
- mutation 系は `create` も含めて `kivin` が安定して強く、guard + validation + filter を通す route core はかなり仕上がってきている

## Hot path notes

`read-users` の差を詰めるため、core runtime には次の最適化を入れています。

- `RequestContext` を route ごとに lazy に生成する
- parameter 解決を request 時ではなく route compile 時に前計算する
- query object が不要な route では `Object.fromEntries(url.searchParams)` を避ける
- middleware が無い route は middleware dispatcher を経由せず直接 handler を呼ぶ
- body parameter は schema が無くても request body を受け取れるように修正する
- JSON / text / no-content response 生成を shared helper に寄せて fast path を共通化する
- named query parameter は URL object を作らず直接読む fast path を使う
- raw で判定できる guard は `RequestContext` を作らずに通せる fast path を使う
- raw single guard + raw single middleware + context-free handler には straight-line executor を使う
- raw single middleware only route も dedicated executor で処理する
- executor 側で先に body を読んだ場合も `context.jsonBody()` が同じ値を再利用する
- static route は regex matcher ではなく method+path の直引きで解決する
- fetch path の pathname 抽出では `new URL()` を避け、文字列 slice で処理する
- `context` が必要でも request-scoped provider を使わない route では request child container を eager に作らず、`context.inject(...)` で request scope が必要になった時だけ遅延作成する
- Bun 実行時の `listen()` は compiled route から `Bun.serve({ routes })` を組み立て、native route matcher を優先して使う
- JSON response は direct `JSON.stringify(...) + new Response(...)` fast path を使い、queued status/header 付き success response でも余計な helper overhead を避ける
- 単一 path param route は prefix/suffix match で regex を避ける
- path param decode は `%` を含む時だけ `decodeURIComponent` を実行する
- 引数なしで pure に評価できる `GET` route は precomputed native static response として Bun routes に直接載せる
- `context` を使わない route は compile 時に separate executor を生成し、RequestContext の遅延構築自体を消す
- schema-backed query object は `URLSearchParams` / `Object.fromEntries(...)` を使わず lightweight parser で組み立てる
- request logger middleware は log level が実際に emit しない場合、request child logger と URL object を eager に作らない

この最適化で `read-users` の hot path から無駄な object 生成と分岐をいくつか外しています。現在は benchmark 側も複数回実行の中央値集計に変えてあるため、単発 run より比較しやすくなっています。

## Reading results

最低限見るべき指標は次です。

- startup ms: single-binary process が listen 可能になるまで
- binary size: deployment artifact の重さ
- req/s: sustained throughput
- p50/p95/p99: tail latency

single-binary 特化の方針では、平均値だけでなく startup と tail latency を重視します。

## Caveats

- 現在の benchmark は runtime overhead 比較に寄せた最小 app です
- decorator/AST/OpenAPI/logger を全部乗せた比較ではありません
- まずは runtime core の軽さを見るための baseline として扱います
- 実行環境ノイズはまだあるので、重要な比較では iterations を増やして見るべきです

production 判断では、この baseline に加えて example app や実アプリ相当 workload でも別途測るべきです。