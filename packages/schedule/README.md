# @kivin/schedule

*English | [日本語](#日本語)*

Cron jobs for kivin that follow the application lifecycle: time zones, no overlapping runs and graceful stop.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/decorators @kivin/schedule
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

This package has no dependencies of its own; it is used inside a kivin application, so install `@kivin/core` as well (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

With several instances every instance runs the jobs; use a lock for run-once jobs.

## Usage

```ts
import { Injectable } from '@kivin/decorators';
import { Scheduler } from '@kivin/schedule';

@Injectable({ deps: [] })
export class Jobs extends Scheduler {
  constructor() {
    super({ timeZone: 'Asia/Tokyo' });
    this.cron('cleanup', '*/15 * * * *', () => console.log('cleanup'), { overlap: 'skip' });
  }
}
// Register Jobs in a module's providers; jobs start on app.init() and stop on app.close()
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinschedule) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

アプリのライフサイクルに連動する kivin 用の cron ジョブです。タイムゾーン、重複実行の抑止、graceful stop に対応します。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivin/core @kivin/decorators @kivin/schedule
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

このパッケージ自体に依存はなく、kivin アプリケーションの中で使うため `@kivin/core` も入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

複数インスタンスで動かすと、それぞれがジョブを実行します。1 回だけ実行したいジョブにはロックを使ってください。

### 使い方

```ts
import { Injectable } from '@kivin/decorators';
import { Scheduler } from '@kivin/schedule';

@Injectable({ deps: [] })
export class Jobs extends Scheduler {
  constructor() {
    super({ timeZone: 'Asia/Tokyo' });
    this.cron('cleanup', '*/15 * * * *', () => console.log('cleanup'), { overlap: 'skip' });
  }
}
// Register Jobs in a module's providers; jobs start on app.init() and stop on app.close()
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinschedule)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
