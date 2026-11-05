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

- アプリの全ルートのレスポンスに CORS ヘッダを付けます（一番外側の global middleware として動きます）。
- preflight（`OPTIONS` + `Access-Control-Request-Method`）には自動で応答します。`methods` を省略すると、そのパスが実際に受け付けるメソッドを返します。
- 404 / 405 にもヘッダを付けるので、ブラウザ側でエラー内容を読めます。
- `credentials: true` で `origin: '*'` の場合は、リクエストの origin をそのまま返します（ブラウザは `*` と credentials の組み合わせを拒否するため）。

## Cookie

```ts
login(@Context() context: RequestContext) {
  const lang = context.cookie('lang');           // 1 リクエストにつき 1 回だけパース
  context.setCookie('session', token, { httpOnly: true, sameSite: 'Lax', maxAge: 3600 });
  context.setCookie('theme', 'dark');            // 複数の Set-Cookie を出せる
  return { ok: true };
}

logout(@Context() context: RequestContext) {
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
me(@Context() context: RequestContext) {
  return getJwtPayload(context);
}

const token = await signJwt({ role: 'admin' }, { key: secret, algorithm: 'HS256', expiresInSec: 3600, subject: userId });
```

- トークンが無い・不正な場合は `401` と `WWW-Authenticate: Bearer ...`、`authorize` が false を返した場合は `403` になります。
- `exp` は既定で必須です（期限の無いトークンを許す場合は `requiredClaims: []`）。`nbf` / `iss` / `aud` / `sub` / `maxAgeSec` / `clockToleranceSec` も検証できます。
- JWKS（リモート鍵セット）の取得は今後の課題です。現状は鍵を直接渡してください。

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
events(@Context() context: RequestContext) {
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

```ts
@Post('/avatar')
async upload(@Context() context: RequestContext) {
  const form = await context.form(); // { name: string, avatar: File, tag: string[] ... }
  const input = v.parse(AvatarSchema, form);
  // ...
}
```

`context.formData()` は生の `FormData` を返します。アップロードサイズの上限は `app.listen({ maxRequestBodySize })` で設定します。`@Body()` で multipart を直接受ける形と OpenAPI の multipart 記述は今後の課題です。

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
