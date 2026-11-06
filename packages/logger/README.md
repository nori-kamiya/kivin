# @kivinjs/logger

*English | [日本語](#日本語)*

Structured JSON-line logger and request logger middleware for kivin.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivinjs/core @kivinjs/logger @kivinjs/valibot valibot
bun add -d @types/bun typescript
```

kivin's type declarations need `"moduleResolution": "bundler"` in your `tsconfig.json`; `NodeNext` is not supported. `@types/bun` and `typescript` are needed for type checking.

`@kivinjs/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivinjs/cli` (`bun add -d @kivinjs/cli`) to generate the route manifest.

`@kivinjs/decorators` is installed automatically as a dependency.

## Usage

```ts
import { defineApplication, defineModule } from '@kivinjs/core';
import { createLogger, createLoggerModule, RequestLoggerMiddleware } from '@kivinjs/logger';
import { createValibotAdapter } from '@kivinjs/valibot';

const logger = createLogger({ serviceName: 'my-api', level: 'info' });
logger.info('started', { port: 3000 }); // one JSON line per record

const LoggerModule = createLoggerModule({ serviceName: 'my-api' });

export default defineApplication({
  modules: [defineModule({ controllers: [], providers: [], imports: [LoggerModule] })],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: [RequestLoggerMiddleware] },
});
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinlogger) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用の JSON line の構造化ロガーと request logger ミドルウェアです。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivinjs/core @kivinjs/logger @kivinjs/valibot valibot
bun add -d @types/bun typescript
```

kivin の型定義は `tsconfig.json` で `"moduleResolution": "bundler"` を前提にしています。`NodeNext` はサポートしていません。型検査には `@types/bun` と `typescript` が必要です。

`@kivinjs/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivinjs/cli`（`bun add -d @kivinjs/cli`）を使います。

`@kivinjs/decorators` は依存として自動で入ります。

### 使い方

```ts
import { defineApplication, defineModule } from '@kivinjs/core';
import { createLogger, createLoggerModule, RequestLoggerMiddleware } from '@kivinjs/logger';
import { createValibotAdapter } from '@kivinjs/valibot';

const logger = createLogger({ serviceName: 'my-api', level: 'info' });
logger.info('started', { port: 3000 }); // one JSON line per record

const LoggerModule = createLoggerModule({ serviceName: 'my-api' });

export default defineApplication({
  modules: [defineModule({ controllers: [], providers: [], imports: [LoggerModule] })],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: [RequestLoggerMiddleware] },
});
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinlogger)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
