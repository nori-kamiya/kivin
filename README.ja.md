# kivin

*[English README](README.md)*

Bun の single-binary デプロイを前提にした、軽量な Fetch API ベースの Web フレームワークです。現在は early-stage (`v0.1.0`) で、安定版までに API が変わる可能性があります。

狙い:

- Hono のように薄い実行時コア
- NestJS のような module / controller / service の構造化
- Valibot（または Standard Schema 対応の validator）と OpenAPI をビルド時生成でつなぐ

> **必要環境:** [Bun](https://bun.sh) **1.4.0 以上**（`engines.bun` に宣言。`bun install` 自体は `engines` を強制しませんが、それより古い Bun では `createApp` と `kivin` CLI が起動時に分かりやすいエラーで失敗します）。kivin は Bun 専用で、Node では動きません。

## インストール

```bash
bun add @kivinjs/core @kivinjs/decorators @kivinjs/valibot valibot
bun add -d @kivinjs/cli @types/bun typescript
```

`@kivinjs/cli` は、プロジェクトの開発依存として入れてください（どこか別の場所から実行するだけでは不十分です）。ルートマニフェストの生成時に、プロジェクトに入っている `@kivinjs/core` に対してアプリを読み込むためです。core に差し込むパッケージ（`@kivinjs/security`、`@kivinjs/http` など）は `@kivinjs/core` を peer dependency に持つので、同じく `bun add` で入れます。Zod や ArkType など他の Standard Schema 対応 validator は、`@kivinjs/valibot` の代わりに `@kivinjs/standard-schema` を使います（[docs/schema-adapter.md](docs/schema-adapter.md)）。

手で組み立てずに雛形から始めるには:

```bash
bunx --package @kivinjs/cli kivin init my-app
```

（必ず `--package @kivinjs/cli` を付けてください。スコープなしの npm 名 `kivin` は本プロジェクトのものではありません。）

### TypeScript の設定

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],          // DOM lib は不要
    "types": ["bun"],           // 必須: kivin の型定義は Bun の型を使う
    "strict": true,
    "noEmit": true
  },
  // 生成物を含めると、`tsc` がハンドラと schema の contract を検査する
  "include": ["*.ts", ".kivin/generated/**/*.ts", ".kivin/generated/**/*.json"]
}
```

`moduleResolution` は `"bundler"` が必須です。公開している型定義は拡張子なしの相対 import を使うため、`NodeNext` はサポートしていません。

kivin は TC39 標準デコレータ（TypeScript 5+ の既定）を使います。`experimentalDecorators` は有効に**しないでください**。

## Quick start

最小構成は controller・module・application の 3 つです。

```ts
// app.ts
import { defineApplication, defineModule } from '@kivinjs/core';
import { Controller, Get } from '@kivinjs/decorators';
import { createValibotAdapter } from '@kivinjs/valibot';

@Controller('/hello')
export class HelloController {
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
  schemaAdapter: createValibotAdapter(),
});
```

`schemaAdapter` は必須です。

```ts
// main.ts
import { createApp } from '@kivinjs/core';
import manifest from './.kivin/generated/manifest';
import appDefinition from './app';

const app = createApp(appDefinition, manifest);

// manifest のルートはすべて Bun.serve の native routes に載ります
app.listen(3000);
```

`package.json` に scripts を足します（`kivin` コマンドはローカルの `@kivinjs/cli` が提供します）。

```json
{
  "scripts": {
    "generate": "kivin generate --entry app.ts --outDir .kivin/generated",
    "dev": "kivin dev --entry app.ts --outDir .kivin/generated --main main.ts",
    "build": "kivin generate --entry app.ts --outDir .kivin/generated && bun build main.ts --compile --outfile server",
    "typecheck": "tsc"
  }
}
```

```bash
bun run generate      # .kivin/generated に manifest.ts / contracts.ts / client.ts / openapi.json を出力
bun run main.ts       # 生成した manifest から起動
curl localhost:3000/hello/
```

`openapi.json` や docs ページのような静的ルートも native routes として載せられます。

```ts
import openApiDocument from './.kivin/generated/openapi.json';

app.listen({
  port: 3000,
  routes: {
    '/openapi.json': Response.json(openApiDocument),
  },
});
```

single binary にするには、生成 manifest を静的 import したまま `bun build main.ts --compile --outfile server` します（runtime scan 不要）。出力名を `app` にしないでください。`./app` が `app.ts` より先に解決されてしまいます。

このリポジトリの `examples/basic` は動く完全な例ですが、モノレポの workspace リンクを使っているので、そのままコピーしては使えません。

### `generate` がすること・しないこと

- `kivin generate` はデコレータをソースの AST から解析しますが、**エントリファイルとその import 先も実際に import します**。つまり、`app.ts` から辿れるモジュールのトップレベルの副作用はビルド時に実行されます。必須の環境変数の読み込みや接続の確立などをそこに書くと、シークレットの無い CI / Docker ビルドで失敗します。環境変数の検証は DI（`@kivinjs/config` の `envProvider`）か `main.ts` で行ってください（[docs/production.md](docs/production.md)）。
- decorator に渡す guard・middleware は **`export` する**か、その場で式として書く必要があります。schema も **`export` してください**。契約チェックと型付きクライアントは `export` された schema を読みます。その場で書いた schema（`@UseQuerySchema(v.object({ ... }))`）は実行時には検証されますが、`kivin generate` は警告を出して契約チェックを省き、型付きクライアントの入力型はゆるい型になります。`export` していない `const IdSchema = ...` を渡すと生成に失敗します。
- 生成に失敗した場合、`--outDir` の以前の成果物は変更されません。

## Dev mode

```bash
bun run dev
```

ソースを保存するたびに manifest / contracts / client を再生成してサーバーを再起動します。生成に失敗した場合（書きかけの構文エラーなど）は直前のサーバーを動かしたままにします。`--watch <dir>` で監視対象を追加できます。

## Typed client

`generate` は `client.ts` も出力します。schema とハンドラの型から作られた型付き HTTP クライアントで、サーバー側のコードは `import type` でしか参照しないため、そのままフロントエンドにバンドルできます。

```ts
import { createClient, KivinClientError } from './.kivin/generated/client';

const api = createClient({
  baseUrl: 'https://api.example.com',
  headers: () => ({ authorization: `Bearer ${token}` }),
});

// 後述の Handlers の UserController のルート（@OperationId なし: コントローラ名 + メソッド名）
const user = await api.user.findById({ params: { id: '1' } });
await api.user.create({ body: { name: 'Ada', email: 'ada@example.com' } }); // body の型を検査
```

- メソッドは `@OperationId('users.list')` から `client.users.list` になります（無い場合はコントローラ名とメソッド名）。
- 入力の型は `export` された query / param / body の schema 入力、出力の型は 2xx レスポンス schema の出力から取ります。schema が無いルートはハンドラの引数・戻り値の型を使います（`Response` を直接返すルートは `unknown`）。
- 2xx 以外は `KivinClientError`（`status` とパース済みの `body` を持つ）を投げます。
- `fetch` オプションに `app.fetch` を渡すと、サーバーを立てずにテストからそのまま呼べます。

## Handlers and decorators

TC39 標準デコレータには引数デコレータが無いので、ハンドラは 1 つの入力オブジェクトを受け取ります。使うフィールドだけを分割代入すると、kivin はリクエストごとにそのフィールドだけを計算します。

```ts
import * as v from 'valibot';
import type { RouteInput } from '@kivinjs/core';
import { Controller, Get, Post, UseBodySchema, UseParamSchema } from '@kivinjs/decorators';

export const UserIdParamSchema = v.object({ id: v.string() });
export const CreateUserSchema = v.object({ name: v.string(), email: v.pipe(v.string(), v.email()) });

@Controller('/users')
export class UserController {
  @Get('/:id')
  @UseParamSchema(UserIdParamSchema)
  findById({ params }: RouteInput<{ params: typeof UserIdParamSchema }>) {
    return { id: params.id }; // params.id は schema の出力型
  }

  @Post('/')
  @UseBodySchema(CreateUserSchema)
  create({ body, context }: RouteInput<{ body: typeof CreateUserSchema }>) {
    return context.json({ id: '1', ...body }, { status: 201 });
  }
}
```

フィールドは `params` / `query` / `body` / `headers` / `context` の 5 つです。schema を宣言していない場合、`headers` は `string | undefined` のレコード（全リクエストヘッダ。名前は小文字、同じヘッダが複数あればカンマ連結）、`params` は文字列のレコード、`query` は `string | string[] | undefined` のレコード（同じキーが繰り返されると配列）、`body` は `unknown` になります。

## Compile-time contracts

decorator は型を変えられないため、schema とハンドラの入力型は別々に書くことになります。kivin はそのズレをビルド時に検出します。

- `kivin generate` は `contracts.ts` も出力します。`tsconfig` の `include` に `.kivin/generated/**/*.ts` を含めておくと、`tsc` が次の不一致をエラーにします。
  - ハンドラの入力型（`RouteInput<{ params; query; body; headers }>`）と、ルートの `@UseParamSchema` / `@UseQuerySchema` / `@UseBodySchema` / `@UseHeaderSchema`
  - ハンドラの戻り値と、宣言された 2xx レスポンス schema（`Response` を直接返す場合は対象外）
- `@Injectable({ deps })` は型付きで、deps の並び・型・個数がコンストラクタ引数と合わないとコンパイルエラーになります。シンボルのトークンに型を付けたい場合は `createToken<T>('key')` を使います。

```text
contracts.ts: Type '{ contractError: "UserController.findById: the handler input type does not match the route's @UseParamSchema / @UseQuerySchema / @UseBodySchema / @UseHeaderSchema"; ... }' does not satisfy the constraint 'true'.
```

型は Standard Schema の型情報から取るので、Valibot 以外の validator でも同じように効きます。

## Features

- AST ベースの route manifest 生成、tsconfig path alias 解決、ahead-of-time の route executor（`--no-aot` / `KIVIN_AOT=0` で無効化）
- Valibot と Standard Schema（Zod、ArkType など）による検証、OpenAPI 3.1 生成（`operationId`・説明・security scheme）
- 型付き HTTP クライアントの生成、route と DI のコンパイル時 contract 検査
- CORS、Cookie（署名付きも）、WebSocket、Server-Sent Events、multipart フォーム、ルート単位のボディ上限
- guard / middleware / 例外フィルタ（global とルート単位）、`HttpError` ヘルパー、graceful shutdown、provider を差し替えられる `createTestingApp`
- 必要なものだけ入れるミドルウェア群: 認証 guard（Basic / Bearer / JWKS 対応の JWT）、CSRF、secure headers（`createSecureHeadersMiddleware`。**既定では有効になりません**）、レートリミット、IP 許可 / 拒否リスト、圧縮、ETag、タイムアウト、リクエスト ID、コンテンツネゴシエーション、ストリーミング、リバースプロキシ、静的ファイル、セッション、メトリクス / トレース / ヘルスチェック、型付き環境変数、cron、GraphQL Yoga のマウント
- Bun single binary ビルド（`bun build --compile`）

## Packages

すべてのパッケージが Bun 1.4.0 以上を必要とします。詳細は [docs/reference.md](docs/reference.md) を参照してください。

| パッケージ | 役割 |
| --- | --- |
| `@kivinjs/core` | ルータ、DI、モジュール、ライフサイクル、入力検証、Cookie / SSE / WebSocket などアプリ実行時の中核 |
| `@kivinjs/decorators` | Module / Controller / Route / Enhancer / OpenAPI デコレータ |
| `@kivinjs/valibot` | Valibot schema adapter |
| `@kivinjs/standard-schema` | Standard Schema adapter（Zod / ArkType / Valibot など） |
| `@kivinjs/cli` | コード生成 CLI（`generate` / `dev` / `openapi` / `inspect`） |
| `@kivinjs/openapi` | OpenAPI 3.1 ドキュメント生成 |
| `@kivinjs/security` | Basic / Bearer 認証ガード、CSRF、secure headers、レートリミット、IP 制限 |
| `@kivinjs/jwt` | JWT の検証・署名（Web Crypto）、JWKS、認証 guard |
| `@kivinjs/http` | 圧縮、ETag、タイムアウト、リクエスト ID、コンテンツネゴシエーション、ストリーミング、Pretty JSON、Method Override、末尾スラッシュ |
| `@kivinjs/static` | 静的ファイル配信（`serveStatic`） |
| `@kivinjs/session` | サーバー側セッション（署名付き Cookie、差し替え可能なストア） |
| `@kivinjs/logger` | JSON line の構造化ロガーと request logger middleware |
| `@kivinjs/observability` | OpenTelemetry トレース、Prometheus メトリクス、Server-Timing、ヘルスチェック |
| `@kivinjs/config` | 型付き・検証済みの環境変数 |
| `@kivinjs/schedule` | アプリのライフサイクルに連動する cron ジョブ |
| `@kivinjs/graphql` | GraphQL Yoga のマウント |

## Performance

CI のペア計測（compiled binary、`bun run perf:check`）では、app-like な workload で kivin のスループットは Hono の 101〜134%、Elysia の 97〜109% で、いくつかの項目では信頼区間が 100% をまたぎます。[docs/performance.md](docs/performance.md) の「Latest paired comparison」を参照してください。数値は環境・バージョンに依存するため、各自の環境で再計測することを推奨します。

## Documents

- [docs/reference.md](docs/reference.md): API reference
- [docs/production.md](docs/production.md): CORS / Cookie / 認証 / セキュリティ / ストリーミング / 観測 / 環境変数 / cron / セッション / GraphQL / WebSocket / SSE / multipart / graceful shutdown / テスト
- [docs/architecture.md](docs/architecture.md)
- [docs/pipeline.md](docs/pipeline.md): リクエストの流れ
- [docs/ast-generator.md](docs/ast-generator.md)
- [docs/schema-adapter.md](docs/schema-adapter.md)
- [docs/openapi-flow.md](docs/openapi-flow.md)
- [docs/bun-compile.md](docs/bun-compile.md)
- [docs/decorators-roadmap.md](docs/decorators-roadmap.md): TC39 デコレータへの移行の記録
- [docs/performance.md](docs/performance.md)

変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。

## Contributing

kivin 自体を開発する場合（clone して `bun install`）:

```bash
bun run generate
bun run check           # generate + tsc -b
bun test
bun run example:smoke   # examples/basic を binary にして起動確認
bun run release:check   # check + test + example:smoke。マージ前のゲート
```

[docs/development-guide.md](docs/development-guide.md)、[docs/testing.md](docs/testing.md)、メンテナ向けの引き継ぎメモ [docs/handoff.md](docs/handoff.md) を参照してください。

## License

[MIT](LICENSE) © nori-kamiya
