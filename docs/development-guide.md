# Development Guide

## Goal

`kivin` は Bun single-binary deployment 前提の framework として、次の 2 点を同時に満たすことを開発の基準にします。

- 実アプリで fastest tier を維持できること
- 速さのために runtime / package / mental model を複雑化しすぎないこと

ここでいう fastest tier は、全 benchmark で常に 1 位を取ることではありません。`core` だけの micro benchmark ではなく、logger / validation / OpenAPI / CLI generation を含む app-like workload でも、`Hono` / `Elysia` と同じ土俵で上位を維持できる構造を目指します。

## What We Learned

### From Elysia

`Elysia` から参考にする点は、feature の多さではなく route-specific composition です。

- route ごとに必要な処理だけを compose する
- context を本当に必要になるまで作らない
- Bun 向け response path を分ける
- hook / validation / response mapping を generic pipeline ではなく compiled handler に寄せる

つまり「賢い runtime」より「build or registration 時に分岐を確定する」方が効きます。

### From Hono

`Hono` から参考にする点は、core の責務を狭く保つことです。

- `Context` と compose の責務が明快
- middleware は Fetch API の延長として理解できる
- adapter や optional middleware は core に押し込まない
- 追加機能は薄い utility として積む

つまり「高機能な 1 枚岩」より「薄い核と分離された周辺」の方が長期的に強いです。

## kivin Principles

### 1. Keep Runtime Thin

runtime は次の責務に絞ります。

- route dispatch
- request scope の最小構築
- validation / guard / middleware / filter の実行
- response finalization

次は runtime に持ち込まない方針です。

- decorator discovery のための runtime scan
- module graph の runtime discovery
- OpenAPI generation
- docs metadata の組み立て
- heavy reflection based behavior switching

これらは CLI / build step に寄せます。

### 2. Specialize By Route, Not By Global Abstraction

高速化は generic abstraction を増やすのではなく、route registration 時の specialization で行います。

優先順位は次です。

1. route metadata から不要な処理を消す
2. request context を不要 route で作らない
3. singleton-only route では request container を作らない
4. `204` / no-schema / no-query / no-body のような frequent case を compile-time に寄せる
5. Bun fast path を helper に閉じ込める

重要なのは、最適化の条件分岐を request time に増やさないことです。分岐が必要なら registration time に決め、request time では短い直線パスを実行します。

### 3. Complexity Must Collapse Into Internal Helpers

実装は速くても、表面 API まで複雑にしてはいけません。

- 利用者向け API は module / controller / service / guard / middleware / filter の形を維持する
- 複雑な fast path は internal helper に閉じ込める
- 1 つの optimization が public API や docs mental model を変えるなら慎重に扱う

`kivin` の価値は「NestJS 的に構造化できるのに runtime は薄い」点にあります。速さのためにこの読みやすさを壊さないことを優先します。

### 4. Make Optional Packages Near-Zero Cost

実アプリでは `core` だけ速くても足りません。`@kivin/logger`, `@kivin/valibot`, `@kivin/openapi`, `@kivin/cli`, `@kivin/decorators` を使っても fastest tier に残れる構造が必要です。

各 package の原則は次です。

#### `@kivin/decorators`

- runtime reflection を賢くするための package にしない
- metadata は build step の入力として扱う
- decorator は authoring DX に寄与し、runtime dependency は増やさない

#### `@kivin/cli`

- module graph, route manifest, OpenAPI generation を一手に引き受ける
- runtime を軽くするための code generation を優先する
- app inspect や route diagnostics も CLI に寄せる

#### `@kivin/openapi`

- request path に一切入れない
- generated artifact を返すだけの構造を優先する
- docs UI が必要でも runtime schema walk はしない

#### `@kivin/valibot`

- runtime validation の境界を明確にする
- route 単位で必要な validator だけを持つ
- schema adapter の共通化は維持するが、per-request schema resolution は避ける

#### `@kivin/logger`

- disabled path で allocation を増やさない
- request logger は opt-in かつ thin middleware に保つ
- `RequestContext` が不要な routeでは logger のためだけに context を要求しない
- structured log は response path の外でなるべく処理する

## Target Structure

実アプリで fastest tier を維持するため、構造は次を標準にします。

### Build-Time Layer

- decorators / metadata authoring
- CLI による manifest generation
- OpenAPI artifact generation
- route inspection / module inspection

この層で確定させるほど runtime は薄くなります。

### Runtime Kernel

- router
- container
- request context
- response state
- compiled route executor

この kernel は small, explicit, predictable であるべきです。新機能を足す時も、まず kernel に入れるべきか package に逃がせるかを判断します。

### Optional Feature Layer

- logging
- auth helpers
- secure headers
- OpenAPI endpoint exposure
- future cache / metrics integrations

この層の rule は「未使用なら cost almost zero」「使用時も route-local cost に閉じる」です。

## Default Design Decisions

今後の開発では次を default judgement にします。

### Request Context

- default は lazy
- context parameter がない routeでは作らない
- logger や helper access のためだけに context を強制しない
- request-scoped provider が必要な時だけ child container を作る

### Middleware And Guards

- singleton fast path を最優先する
- raw path で十分な middleware / guard は `RequestContext` を要求しない
- middleware combinator を増やす前に compile-time flattening を優先する
- global feature は増やしすぎず、route-local cost を意識する

### Validation

- request / response schema は route ごとに閉じる
- no-schema route に identity mapper を持ち込まない
- schema adapter API は単純に保ち、special case は app compile 側で吸収する

### Responses

- Bun 向け最短 path は response helper に閉じ込める
- `204` / JSON / plain `Response` の hot path を分ける
- header/status merge は `ResponseState` に集中させる
- response finalization を generic post-process 一発に寄せすぎない

### Packages

- package 増設より existing package の役割整理を優先する
- `core` に寄せるべきでない機能は周辺 package に置く
- 周辺 package が runtime cost を増やすなら build-time 寄せを再検討する

## What We Should Not Copy

`Elysia` と `Hono` の良いところは取り入れますが、そのまま真似しない点も明確にします。

- `kivin` は lifecycle hook framework にはしない
- `kivin` は dynamic plugin magic を中心にしない
- `kivin` は everything-is-context API に寄せない
- `kivin` は adapter surface を先に広げない
- `kivin` は benchmark のためだけの public API を増やさない

`kivin` の中心は module/controller based app development と build-time generated contract です。ここが `Hono` や `Elysia` と違う価値なので、競合の強みを取り入れても identity は変えません。

## Performance Development Loop

今後の性能改善は次の順序で進めます。

1. 実アプリ workload でボトルネックを確認する
2. route category を切り出して benchmark を focused 化する
3. compile-time specialization で解けるか確認する
4. API や mental model を壊さない internal simplification を優先する
5. docs と benchmark truth を更新する

原則として、速くするために generic abstraction や runtime polymorphism を増やすのは最後です。まずは route metadata, executor selection, helper split の整理で吸収します。

## Acceptance Criteria

新しい設計や optimization は、少なくとも次を満たす時に採用します。

- README と docs の mental model を悪化させない
- `bun run check` と `bun test` を通る
- `bun run example:smoke` を壊さない
- focused benchmark か full stack benchmark で理由のある改善がある
- 未使用 route や未使用 package に cost を持ち込まない

改善幅が小さくても code shape が単純になるなら採用候補です。逆に benchmark が少し良くても、構成が読みにくくなり maintenance cost が増えるなら見送ります。

## Current Guidance

2026-03-12 時点では、今後の優先順位を次のように置きます。

1. `compiled create` を route-specific specialization で詰める
2. full stack benchmark を継続して truth source にする
3. logger / security headers / OpenAPI exposure を含む app-like route で zero-cost default を徹底する
4. core の内部 fast path を整理し、同じ効果をより少ない分岐で実現できる形へ寄せる

この document を今後の design review と performance discussion の基準にします。新しい機能や最適化は「この方針に沿っているか」を先に確認してから進めます。