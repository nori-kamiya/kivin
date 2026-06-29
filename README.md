# kivin

Bun single-binary deployment を前提にした、軽量な Fetch API ベースの Web フレームワークです。現在は early-stage (`v0.0.1`) で、API は安定版に向けて変わる可能性があります。

狙いは次の 3 点です。

- Hono のように薄い実行時コア
- NestJS のような module / controller / service の構造化
- Valibot と OpenAPI をビルド時生成でつなぐ

## Current features

- AST-based route manifest generation
- tsconfig path alias resolution for module graph traversal
- generated import alias collision avoidance
- Valibot schema validation
- OpenAPI 3.1 generation
- `operationId`, route description, and security scheme support
- standardized `HttpError` helpers and `204 No Content` responses
- default secure-headers middleware for production-facing APIs
- configurable secure-headers middleware via `createSecureHeadersMiddleware(...)`
- mutation route support for `PUT`, `PATCH`, and `DELETE`
- global / route guards
- global / route middleware
- global / route exception filters
- Bun single binary build

## Packages

- `@kivin/core`: ルータ、DI、アプリ実行時コア
- `@kivin/decorators`: Module / Controller / Route / Parameter decorators
- `@kivin/logger`: JSON line の構造化ロガーと request logger middleware
- `@kivin/openapi`: OpenAPI ドキュメント生成
- `@kivin/valibot`: Valibot schema adapter
- `@kivin/cli`: manifest と OpenAPI のコード生成 CLI

## Quick start

> 前提: [Bun](https://bun.sh) 1.3 以上。現状はモノレポとして利用する形を想定しています（npm 配布は未対応）。リポジトリを clone して `bun install` してください。

最小構成は controller・module・application の 3 つです。

```ts
// app.ts
import { Controller, Get } from '@kivin/decorators';
import { defineApplication, defineModule } from '@kivin/core';

@Controller('/hello')
class HelloController {
  @Get('/')
  hello() {
    return { message: 'hello kivin' };
  }
}

const HelloModule = defineModule({
  controllers: [HelloController],
  providers: [],
  imports: [],
});

export default defineApplication({
  modules: [HelloModule],
});
```

ルートグラフと OpenAPI をビルド時に生成し、生成 manifest から実行します。

```bash
# manifest.ts / openapi.json を生成
bun run packages/cli/src/bin.ts generate --entry app.ts --outDir .kivin/generated

# 生成 manifest を使ってアプリを起動
bun run main.ts
```

```ts
// main.ts
import { createApp } from '@kivin/core';
import { manifest } from './.kivin/generated/manifest';

const app = createApp(manifest);

export default {
  fetch: app.fetch,
  port: 3000,
};
```

single binary にするには generated manifest を静的 import したまま `bun build --compile` します（runtime scan 不要）。動く完全な例は [`examples/basic`](examples/basic) を参照してください。

## Workflow

```bash
bun install
bun run generate
bun run check
bun test
bun run example:dev
bun run example:build
bun run example:smoke
bun run inspect:routes
bun run inspect:modules
bun run bench
```

`bun run generate` は TypeScript source を AST 解析して次を生成します。

- `examples/basic/.kivin/generated/manifest.ts`
- `examples/basic/.kivin/generated/openapi.json`

`bun run example:build` は generated manifest を静的 import したまま `bun build --compile` を実行します。runtime scan は不要です。

`bun run example:smoke` は compiled binary を起動して list/create/update/patch/delete、`/openapi.json`、`HEAD` / `OPTIONS` を実際に検証します。

`bun run bench` は compiled binary の `kivin` / `hono` / `elysia` を同一 workload で比較し、startup、binary size、GET/PATCH の throughput と latency を出します。

full stack の順位を更新したい時は `BENCH_ITERATIONS=10 bun run bench:stack` を基準にするのが安全です。手元の `10` iteration sample では、`kivin` は full stack で `Hono` を安定して上回り、`Elysia` とも main app-like routes では strongest tier を維持しています。canonical focused CRUD baseline でも `patch` は strongest tier、`delete` も strongest tier ですが、`compiled create` はまだ `Hono` / `Elysia` が上です。今の認識としては「最強クラス」であって、「全 path で絶対最速」ではありません（数値は環境・バージョンに依存するため、各自の環境で再計測することを推奨します）。

`bun run inspect:routes` は route ごとの handler に加えて controller scope、guard/middleware/filter の scope、executor mode (`native-static` / `singleton-runtime` / `context-runtime` / `request-runtime`) も表示します。

`bun run inspect:modules` は provider scope に加えて controller scope と app-global guard/middleware/filter wiring も表示します。

## Documents

- [docs/reference.md](docs/reference.md) — API reference
- [docs/architecture.md](docs/architecture.md)
- [docs/development-guide.md](docs/development-guide.md)
- [docs/ast-generator.md](docs/ast-generator.md)
- [docs/performance.md](docs/performance.md)
- [docs/pipeline.md](docs/pipeline.md)
- [docs/schema-adapter.md](docs/schema-adapter.md)
- [docs/openapi-flow.md](docs/openapi-flow.md)
- [docs/bun-compile.md](docs/bun-compile.md)
- [docs/testing.md](docs/testing.md)

変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。

## License

[MIT](LICENSE) © nori-kamiya
