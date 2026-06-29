# Testing

## Current coverage

- runtime pipeline: guard / middleware / filter / validation
- runtime validation failure: body / query / path params
- runtime HTTP method edge case: HEAD fallback / OPTIONS / 405
- runtime HTTP helper contract: `HttpError` / `204 No Content`
- runtime composition order: multi-layer global / route middleware nesting and filter pass-through precedence
- runtime request scope: request-scoped providers plus request-scoped controller / guard / middleware / filter resolution
- AST generator: route and enhancer extraction
- AST generator: tsconfig path alias resolution and import collision avoidance
- AST generator: generated manifest importability and stable import rendering
- OpenAPI contract alignment: manifest request/response/security/tags/summary docs stay semantically aligned with generated OpenAPI operations
- smoke test: Bun single binary build, boot, and endpoint verification
- example mutation flow: `PUT` / `PATCH` / `DELETE` and conflict handling
- generated manifest snapshot
- generated OpenAPI snapshot

## Commands

```bash
bun run check
bun test
bun run example:smoke
bun run perf:check
bun run release:check
BENCH_ITERATIONS=10 bun run bench:stack
BENCH_ITERATIONS=10 bun run bench:stack:delete
BENCH_ITERATIONS=10 bun run bench:kivin:create
```

## Strategy

runtime test は decorator metadata に依存させず、explicit manifest を使って core behavior を固定しています。

理由:

- Bun test では legacy decorators metadata に依存したテストが不安定になりやすい
- core の責務は `createApp()` と pipeline の正しさにある

一方で decorator / AST は CLI test 側で別に押さえています。

snapshot test は次を固定しています。

- example app の generated manifest
- path alias fixture の generated manifest
- example app の generated OpenAPI JSON

## Release gate

production に近づけるため、最低でも次を毎回通す前提にします。

- `bun run check`
- `bun test`
- `bun run example:smoke`

日常運用ではこれらを個別に叩くより、`bun run release:check` を canonical な release gate として使う想定です。

性能退行も見たい場合は `bun run perf:check` を supplement として追加します。これは full benchmark より軽く、`bench:health` と `bench:stack` の一部比較だけを使って、短時間で meaningful な退行を検知するための gate です。default は `PERF_GATE_ITERATIONS=5` にして、少ない iteration で出やすかった cold-start と run-to-run noise を抑えています。

cross-framework の現状確認や docs 更新に使う基準値を作るなら、`5` iteration より `10` iteration の `bench:stack` / `bench:stack:delete` を優先します。2026-03-12 の `10` iteration rerun では full stack で `kivin` が `Hono` を安定して上回り、`Elysia` とは `health` と一部 delete path を除く main routes で strongest tier を維持しました。

focused CRUD を更新する時は次も使います。

```bash
BENCH_VARIANTS=create,patch,delete BENCH_ITERATIONS=10 bun run bench:stack:spot > .bench/stack-spot-create-patch-delete-$(date +%Y%m%d%H).txt
```

2026-03-12 の canonical focused CRUD baseline は [stack-spot-create-patch-delete-20260312e.txt](../.bench/stack-spot-create-patch-delete-20260312e.txt) です。`kivin` は `patch` で `compiled` / `source` とも strongest tier、`delete` も strongest tier を維持しました。一方で `compiled create` はまだ `Hono` / `Elysia` が上で、全 route で無条件に首位とは言わない方が正確です。

同日の post-optimization rerun [stack-spot-create-patch-delete-20260312f.txt](../.bench/stack-spot-create-patch-delete-20260312f.txt) と [stack-spot-create-patch-delete-20260312g.txt](../.bench/stack-spot-create-patch-delete-20260312g.txt) は、`201` no-schema finalizer の route-specific specialization 後の確認用です。ただし framework 横断で振れが大きく canonical baseline には不向きだったため、docs 更新の基準値としては `e` を優先します。

[stack-spot-create-patch-delete-20260313a.txt](../.bench/stack-spot-create-patch-delete-20260313a.txt) は `@kivin/logger` の disabled log allocation 削減後の確認用 rerun です。correctness と build は通りましたが、focused CRUD の `compiled create` 順位は依然として変わらなかったため、この artifact も benchmark truth の更新には使いません。

`compiled create` の残差を kivin 単体で分解する時は次を使います。

```bash
BENCH_ITERATIONS=10 bun run bench:kivin:create > .bench/kivin-create-breakdown-$(date +%Y%m%d%H).txt
```

[kivin-create-breakdown-20260313a.txt](../.bench/kivin-create-breakdown-20260313a.txt) では `request-id` middleware の寄与は見えるものの、より大きい差分は guard と body validation を外した時に出ました。したがって次の create-path investigation は response finalizer よりも、guard/validation の compiled path を優先するのが妥当です。

同 command の新しい artifact [kivin-create-breakdown-20260313b.txt](../.bench/kivin-create-breakdown-20260313b.txt) は in-process profile も含みます。network rerun はなお振れますが、`kivin.app.fetch.create` 系の profile は比較的安定しており、guard と validation を外すごとに段階的に改善するかを確認する用途に向いています。必要なら `BENCH_PROFILE_REQUESTS=20000` のように profile loop 回数だけ増やして再確認します。

[kivin-create-breakdown-20260313c.txt](../.bench/kivin-create-breakdown-20260313c.txt) は、sync raw guard / raw middleware の promise-check 回避を入れた後の確認用です。ここでは `kivin.guard.raw.create`, `kivin.body.json.parse.create`, `kivin.body.schema.validate.create` も同時に出すようにしてあり、create path の investigation を app.fetch だけでなく direct component profile でも追えるようにしました。

運用上の判断は次です。

- optimization 後の確認用 rerun は取る
- ただし docs に昇格する benchmark artifact は、複数 framework の順位が不自然に崩れていないものを選ぶ
- latest rerun が noisy でも、そこから `remaining gap` の所在だけは読み取る

この 3 本で、それぞれ次を担保します。

- typecheck と artifact generation の整合
- core runtime pipeline と AST/OpenAPI generator の回帰防止
- Bun single binary の build と起動後 endpoint 応答

## Remaining gaps

まだ薄い領域は次です。

- single binary smoke を CI matrix に組み込んで macOS/Linux 差分も拾うこと

OpenAPI と runtime manifest の整合は、snapshot だけでなく example app と dedicated fixture について requestBody / parameters / responses / security / tags / summary / description の semantic diff でも固定しています。特に fixture 側では multi-security、controller + route tag merge、required/optional query params、`204` no-content response を押さえています。

framework を production 向けに育てるなら、unit test 追加だけでは不十分です。artifact generation と compiled binary までを release gate に含めて、runtime core と build pipeline を同時に守る必要があります。
