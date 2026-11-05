# Production features

本番運用でよく必要になる機能の使い方です。いずれも、使わない場合はリクエスト経路にコストを足しません（`bun run perf:regression` で確認しています）。

## CORS

```ts
defineApplication({
  modules: [UsersModule],
  schemaAdapter: createValibotAdapter(),
  cors: {
    origin: ['https://app.example.com'], // '*' / 文字列 / 配列 / (origin) => boolean
    credentials: true,
    exposeHeaders: ['x-request-id'],
    maxAge: 600,
  },
});
```

- アプリの全ルートのレスポンスに CORS ヘッダを付けます（一番外側の global middleware として動きます）。パラメータ / クエリ / ボディの検証エラー、ガードの拒否、フィルタやハンドラの例外から作られたエラーレスポンスにも付くので、ブラウザからエラー本文を読めます。
- preflight（`OPTIONS` + `Access-Control-Request-Method`）には自動で応答します。`methods` を省略すると、そのパスが実際に受け付けるメソッドを返します。
- 404 / 405 にもヘッダを付けるので、ブラウザ側でエラー内容を読めます。
- `credentials: true` で `origin: '*'` の場合は、リクエストの origin をそのまま返します（ブラウザは `*` と credentials の組み合わせを拒否するため）。

## Cookie

```ts
login({ context }: RouteInput) {
  const lang = context.cookie('lang');           // 1 リクエストにつき 1 回だけパース
  context.setCookie('session', token, { httpOnly: true, sameSite: 'Lax', maxAge: 3600 });
  context.setCookie('theme', 'dark');            // 複数の Set-Cookie を出せる
  return { ok: true };
}

logout({ context }: RouteInput) {
  context.deleteCookie('session');
  return context.noContent();
}
```

`parseCookies` / `serializeCookie` / `getCookie` は単体の関数としても使えます。`Path` の既定値は `/` で、`SameSite=None` や `partitioned` を指定すると `Secure` を自動で付けます。

## JWT（`@kivin/jwt`）

Web Crypto ベースで依存はありません。HS* / RS* / PS* / ES* / EdDSA に対応しています。

```ts
import { createJwtGuard, getJwtPayload, signJwt } from '@kivin/jwt';

export const AuthGuard = createJwtGuard({
  key: process.env.JWT_SECRET!,      // RS/ES では公開鍵の CryptoKey か JWK
  algorithms: ['HS256'],             // 必須。トークン側にアルゴリズムを選ばせない
  issuer: 'https://auth.example.com',
  audience: 'api',
  cookie: 'token',                   // Authorization ヘッダが無いときに Cookie も見る
  authorize: (payload) => payload.role === 'admin', // false なら 403
});

@Get('/me')
@UseGuards(AuthGuard)
me({ context }: RouteInput) {
  return getJwtPayload(context);
}

const token = await signJwt({ role: 'admin' }, { key: secret, algorithm: 'HS256', expiresInSec: 3600, subject: userId });
```

- トークンが無い・不正な場合は `401` と `WWW-Authenticate: Bearer ...`、`authorize` が false を返した場合は `403` になります。
- `exp` は既定で必須です（期限の無いトークンを許す場合は `requiredClaims: []`）。`nbf` / `iss` / `aud` / `sub` / `maxAgeSec` / `clockToleranceSec` も検証できます。

### JWKS（OIDC プロバイダの公開鍵）

Auth0 / Cognito / Entra ID / Google など、鍵をローテーションするプロバイダには `createRemoteJwks` を `key` に渡します。

```ts
import { createJwtGuard, createRemoteJwks } from '@kivin/jwt';

export const AuthGuard = createJwtGuard({
  key: createRemoteJwks('https://auth.example.com/.well-known/jwks.json'),
  algorithms: ['RS256'],
  issuer: 'https://auth.example.com/',
  audience: 'api',
});
```

- 鍵は初回の検証時に取得し、`cacheTtlSec`（既定 600 秒。レスポンスの `Cache-Control: max-age` があればそちら）の間キャッシュします。同時に来たリクエストの取得は 1 回にまとめます
- トークンの `kid` が見つからない場合は、ローテーションとみなして 1 回だけ再取得します。再取得の間隔は `cooldownSec`（既定 30 秒）以上空けるので、でたらめな `kid` を送り続けられてもプロバイダへのリクエストは増えません
- 鍵は `kid` と、アルゴリズムに合う鍵種別（RS/PS→RSA、ES256→P-256 など）・`use`・`alg` で選びます。`kid` の無いトークンは、候補が 1 つに決まる場合だけ受け付けます
- 再取得に失敗した場合は直前の鍵セットを使い続けます。初回取得に失敗した場合、ガードは `503`（`Retry-After`）を返します（`401` ではないため、クライアントがログアウト扱いにしません）
- 固定の鍵セットを使う場合は `createLocalJwks({ keys: [...] })`。`verifyJwt(token, { key: resolver, ... })` でガード以外からも使えます

## WebSocket

```ts
app.listen({
  port: 3000,
  websockets: {
    '/rooms/:room': defineWebSocket({
      upgrade(request) {
        const user = authenticate(request);
        return user ? { user } : new Response('unauthorized', { status: 401 }); // Response を返すと拒否
      },
      open(socket) {
        socket.subscribe(socket.data.params.room);
      },
      message(socket, message) {
        socket.publish(socket.data.params.room, `${socket.data.data.user.name}: ${message}`);
      },
    }),
  },
});
```

Bun ネイティブの WebSocket サーバーをそのまま使います（pub/sub も利用可能）。パスは Bun のルート構文で、アプリのルートと衝突するとエラーになります。

## Server-Sent Events

```ts
@Get('/events')
events({ context }: RouteInput) {
  return context.sse(async (stream) => {
    while (!stream.signal.aborted) {
      stream.send({ event: 'tick', data: { at: Date.now() } });
      await Bun.sleep(1000);
    }
  });
}
```

ハンドラが終わるか、クライアントが切断する（`stream.signal` が abort される）とストリームを閉じます。プロキシに切られないよう、15 秒ごとに keep-alive コメントを送ります（`keepAliveMs` で変更可）。

## multipart / form

`@Consumes('multipart/form-data')`（または `'application/x-www-form-urlencoded'`）を付けると、ボディをフォームとして読み、`@UseBodySchema` で検証したうえで入力オブジェクトの `body` に渡します。

```ts
export const AvatarUpload = v.object({
  avatar: v.pipe(v.file(), v.mimeType(['image/png', 'image/jpeg']), v.maxSize(1024 * 1024)),
  alt: v.optional(v.string()),
});

@Put('/:id/avatar')
@Consumes('multipart/form-data')
@UseParamSchema(UserIdParams)
@UseBodySchema(AvatarUpload)
uploadAvatar({ params, body }: RouteInput<{ params: typeof UserIdParams; body: typeof AvatarUpload }>) {
  return { id: params.id, filename: body.avatar.name, size: body.avatar.size };
}
```

- フィールドは文字列か `File` になり、同じ名前が複数あれば配列になります（`v.array(v.string())` などで受けます）
- フォーム以外の Content-Type は `415`、壊れたボディは `400`、schema 違反は通常どおり `400 body validation failed`
- ガード・ミドルウェア・フィルタ・CORS は JSON ルートと同じ順序で効きます（ボディを読むのはガードの後）
- OpenAPI の `requestBody` は `multipart/form-data` で出力され、`v.file()` / `v.blob()` は `{ type: 'string', format: 'binary' }` になります
- 生成クライアントは plain object を `FormData` に変換して送ります（`File` / `Blob` はそのまま、配列は同名フィールドを複数）。`FormData` を直接渡すこともできます
- `@Consumes` のない JSON ルートには一切コストがかかりません

`context.formData()` / `context.form()` は従来どおり使え、`@Consumes` ルートでも `body` と同じ解析結果を共有します。アップロードサイズの上限は `app.listen({ maxRequestBodySize })` で設定します。

## 起動時フック（`onModuleInit` / `onApplicationBootstrap`）

DB 接続やキャッシュのウォームアップなど、最初のリクエストより前に終えたい非同期処理は provider のフックに書き、`listen` の前に `await app.init()` を呼びます。

```ts
class Database {
  async onModuleInit() {
    await this.pool.connect();
  }
}

const app = createApp(definition, manifest);
await app.init();       // 全 singleton を生成し onModuleInit → onApplicationBootstrap を順に await
app.listen(3000);
```

- singleton provider をすべて生成し（ルートで使われない provider も含む）、依存される側から順に `onModuleInit()` を await し、その後 `onApplicationBootstrap()` を同じ順で await します
- フックを持つ provider があるのに `init()` 前に `listen()` を呼ぶとエラーになります（フックが黙って実行されないことを防ぐため）。フックが無いアプリは従来どおり `init()` 不要です
- `init()` は何度呼んでも 1 回だけ実行されます。フックが失敗すると reject し、再度呼べばやり直せます
- `createTestingApp(...).request()` は最初のリクエストの前に自動で `init()` します。`app.fetch` を直接使う場合は自分で `await app.init()` してください

## Graceful shutdown

```ts
class Database {
  async onApplicationShutdown(signal?: string) {
    await this.pool.end();
  }
}

app.listen({ port: 3000, shutdownSignals: true }); // SIGINT / SIGTERM で app.close() してから exit
```

`app.close()` の流れは次のとおりです。

1. 新しい接続の受け付けを止める
2. 処理中のリクエストを最大 `timeoutMs`（既定 10 秒）待つ
3. 生成済みのシングルトンの `onApplicationShutdown(signal)` を、後に作られたものから順に呼ぶ（依存される側が後で閉じる）

`shutdownSignals` は既定で無効です。テストや別のホストに組み込む場合に、プロセスの終了を kivin が勝手に握らないようにするためです。

## テスト

```ts
import { createTestingApp } from '@kivin/core';

const app = createTestingApp(appDefinition, {
  manifest,                                              // 省略するとデコレータのメタデータから組み立てる
  overrides: [{ provide: UserRepository, useValue: fakeRepository }],
});

const response = await app.request('/users', { method: 'POST', json: { name: 'Ada' } });
expect(response.status).toBe(201);
app.get(UserRepository); // DI から直接取り出す
```

ポートを開かずにアプリを呼び出せます。生成クライアントに `fetch: app.fetch` を渡せば、型付きでテストを書くこともできます。
