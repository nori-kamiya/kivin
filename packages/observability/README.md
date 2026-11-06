# @kivin/observability

*English | [日本語](#日本語)*

Observability for kivin: Prometheus metrics, OpenTelemetry tracing, Server-Timing and `/livez` / `/readyz` health checks.

**Requires Bun 1.4.0 or later** (Bun only; it does not run on Node). Part of [kivin](https://github.com/nori-kamiya/kivin/blob/main/README.md), which is early-stage and may change before a stable release.

## Install

```bash
bun add @kivin/core @kivin/observability @kivin/valibot valibot
```

`@kivin/core` is a peer dependency of this package, so install it in your project too (the command above includes it). Use `@kivin/cli` (`bun add -d @kivin/cli`) to generate the route manifest.

OpenTelemetry is optional: `createTracingMiddleware` accepts the `@opentelemetry/api` objects you pass in and adds no dependency.

## Usage

```ts
import { createApp, defineApplication, defineModule } from '@kivin/core';
import { createHealthCheck, createMetrics } from '@kivin/observability';
import { createValibotAdapter } from '@kivin/valibot';
import manifest from '../.kivin/generated/manifest';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

const metrics = createMetrics();
const health = createHealthCheck({ checks: { self: () => true } });

const definition = defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: [metrics.middleware] },
});

createApp(definition, manifest).listen({
  port: 3000,
  routes: { '/metrics': metrics.handler, ...health.routes() }, // keep /metrics off the public internet
});
```

## Documentation

- [API reference](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinobservability) (Japanese)
- [Project README](https://github.com/nori-kamiya/kivin/blob/main/README.md)

---

## 日本語

kivin 用の観測機能です。Prometheus メトリクス、OpenTelemetry トレース、Server-Timing、`/livez` / `/readyz` ヘルスチェックを提供します。

**Bun 1.4.0 以上が必要です**（Bun 専用で、Node では動きません）。[kivin](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md) の一部で、early-stage のため安定版までに変わる可能性があります。

### インストール

```bash
bun add @kivin/core @kivin/observability @kivin/valibot valibot
```

`@kivin/core` はこのパッケージの peer dependency なので、プロジェクトにも入れてください（上のコマンドに含めています）。 ルートマニフェストの生成には `@kivin/cli`（`bun add -d @kivin/cli`）を使います。

OpenTelemetry は任意です。`createTracingMiddleware` は渡された `@opentelemetry/api` のオブジェクトを使うだけで、依存を増やしません。

### 使い方

```ts
import { createApp, defineApplication, defineModule } from '@kivin/core';
import { createHealthCheck, createMetrics } from '@kivin/observability';
import { createValibotAdapter } from '@kivin/valibot';
import manifest from '../.kivin/generated/manifest';

const AppModule = defineModule({ controllers: [], providers: [], imports: [] }); // your root module

const metrics = createMetrics();
const health = createHealthCheck({ checks: { self: () => true } });

const definition = defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
  globals: { middleware: [metrics.middleware] },
});

createApp(definition, manifest).listen({
  port: 3000,
  routes: { '/metrics': metrics.handler, ...health.routes() }, // keep /metrics off the public internet
});
```

### ドキュメント

- [API リファレンス](https://github.com/nori-kamiya/kivin/blob/main/docs/reference.md#kivinobservability)
- [プロジェクトの README](https://github.com/nori-kamiya/kivin/blob/main/README.ja.md)
