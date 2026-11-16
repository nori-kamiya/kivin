# @kivinjs/schedule

*English | [日本語](#日本語)*

Cron jobs for kivin that follow the application lifecycle: time zones, no overlapping runs and graceful stop.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/decorators @kivinjs/schedule
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

This package has no dependencies of its own; it is used inside a kivin application, so install `@kivinjs/core` as well (the command above includes it). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

With several instances every instance runs the jobs unless the scheduler has a `lock` (below).

## Usage

```ts
import { Injectable } from '@kivinjs/decorators';
import { Scheduler } from '@kivinjs/schedule';

@Injectable({ deps: [] })
export class Jobs extends Scheduler {
  constructor() {
    super({ timeZone: 'Asia/Tokyo' });
    this.cron('cleanup', '*/15 * * * *', () => console.log('cleanup'), { overlap: 'skip' });
  }
}
// Register Jobs in a module's providers; jobs start on app.init() and stop on app.close()
```

## Several instances: run once with a lock

With `lock`, each scheduled run happens on one instance only: every instance tries to take the key `<job name>:<scheduled time in ms>`, and only the one that gets it runs the job. `createRedisJobLock` takes it in Redis with `SET … NX PX`, using Bun's built-in client (`RedisClient` from `bun`, or `Bun.redis`); the package itself stays dependency-free.

```ts
import { RedisClient } from 'bun';
import { Injectable } from '@kivinjs/decorators';
import { createRedisJobLock, Scheduler } from '@kivinjs/schedule';

@Injectable({ deps: [] })
export class Jobs extends Scheduler {
  constructor() {
    super({ timeZone: 'Asia/Tokyo', lock: createRedisJobLock(new RedisClient(process.env.REDIS_URL), { prefix: 'myapp:job:' }) });
    this.cron('daily-report', '0 9 * * MON-FRI', () => console.log('report')); // one instance
    this.cron('refresh-cache', '*/5 * * * *', () => console.log('refresh'), { lock: false }); // every instance
  }
}
```

- The lock is not released after the run; it expires after `lockTtlMs` (default 60000, also settable per job). Keep it longer than the clock difference between instances, or a lagging instance could run the same scheduled time again.
- Only scheduled runs are coordinated: `run(name)`, `runOnStart` and `lock: false` jobs run on the instance that starts them.
- When taking the lock fails (Redis is down, …), the run is skipped on that instance and `onError` receives a `JobLockError`.
- Runs are not kept from overlapping across instances: an instance still busy with the previous run does not compete, so another may start the next one.

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinschedule) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

アプリのライフサイクルに連動する kivin 用の cron ジョブです。タイムゾーン、重複実行の抑止、graceful stop に対応します。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/decorators @kivinjs/schedule
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

このパッケージ自体に依存はなく、kivin アプリケーションの中で使うため `@kivinjs/core` も入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

複数インスタンスで動かすと、スケジューラに `lock`（下記）が無い限り、それぞれがジョブを実行します。

### 使い方

```ts
import { Injectable } from '@kivinjs/decorators';
import { Scheduler } from '@kivinjs/schedule';

@Injectable({ deps: [] })
export class Jobs extends Scheduler {
  constructor() {
    super({ timeZone: 'Asia/Tokyo' });
    this.cron('cleanup', '*/15 * * * *', () => console.log('cleanup'), { overlap: 'skip' });
  }
}
// Register Jobs in a module's providers; jobs start on app.init() and stop on app.close()
```

### 複数インスタンス: ロックで 1 回だけ実行する

`lock` を渡すと、スケジュールどおりの各回を 1 つのインスタンスだけが実行します。各インスタンスは `<ジョブ名>:<予定時刻のミリ秒>` というキーを取りにいき、取れたインスタンスだけがジョブを実行します。`createRedisJobLock` は Bun 組み込みのクライアント（`bun` の `RedisClient`、または `Bun.redis`）で、Redis に `SET … NX PX` してロックを取ります。パッケージ自体は依存なしのままです。

```ts
import { RedisClient } from 'bun';
import { Injectable } from '@kivinjs/decorators';
import { createRedisJobLock, Scheduler } from '@kivinjs/schedule';

@Injectable({ deps: [] })
export class Jobs extends Scheduler {
  constructor() {
    super({ timeZone: 'Asia/Tokyo', lock: createRedisJobLock(new RedisClient(process.env.REDIS_URL), { prefix: 'myapp:job:' }) });
    this.cron('daily-report', '0 9 * * MON-FRI', () => console.log('report')); // one instance
    this.cron('refresh-cache', '*/5 * * * *', () => console.log('refresh'), { lock: false }); // every instance
  }
}
```

- ロックは実行後も解放せず、`lockTtlMs`（既定 60000。ジョブ単位でも指定可）で期限切れになります。インスタンス間の時計のずれより長くしてください。短いと、時計の遅れたインスタンスが同じ回をもう一度実行することがあります。
- 調整するのはスケジュールどおりの実行だけです。`run(name)`、`runOnStart`、`lock: false` のジョブは、それを起動したインスタンスで実行します。
- ロックの取得に失敗した場合（Redis が落ちているなど）は、そのインスタンスではその回をスキップし、`onError` に `JobLockError` を渡します。
- インスタンスをまたいだ重複は防ぎません。前回の実行がまだ続いているインスタンスは次の回を取りにいかないので、別のインスタンスが次の回を始めることがあります。

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinschedule)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
