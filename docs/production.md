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

### 署名付き Cookie

改ざんを検出したい値（ユーザー ID・設定など）は HMAC-SHA256 で署名して保存できます。暗号化はしないので、クライアントに見られて困る値は入れないでください。

```ts
const COOKIE_SECRETS = [process.env.COOKIE_SECRET!, process.env.COOKIE_SECRET_OLD!].filter(Boolean);

async login({ context }: RouteInput) {
  await context.setSignedCookie('uid', user.id, COOKIE_SECRETS, { httpOnly: true, sameSite: 'Lax' });
  return { ok: true };
}

async me({ context }: RouteInput) {
  const uid = await context.signedCookie('uid', COOKIE_SECRETS);
  if (!uid) throw unauthorized();   // undefined = 無い、false = 署名が合わない（改ざん / 別の鍵）
  return { uid };
}
```

- 値は `<value>.<署名>`（署名は base64url 43 文字）。署名対象は `<name>=<value>` なので、ある Cookie 用に署名された値を別名の Cookie に移しても検証に失敗します。
- 鍵は文字列・鍵のバイト列・HMAC の `CryptoKey` のいずれか。配列を渡すと先頭の鍵で署名し、どれかの鍵で検証できれば受け入れるので、新しい鍵を先頭に足すだけでローテーションできます。検証は `crypto.subtle.verify`（定数時間）です。
- ミドルウェアなど `RequestContext` の外では `getSignedCookie(request, name, secrets)` / `serializeSignedCookie(name, value, secrets, options)` / `signCookieValue` / `verifyCookieValue` を使います。

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

## リクエストボディのサイズ制限

```ts
defineApplication({ /* ... */ bodyLimit: 1024 * 1024 });   // POST / PUT / PATCH / DELETE の既定（1 MiB）

@Post('/:id/avatar')
@BodyLimit(5 * 1024 * 1024)                                 // このルートだけ 5 MiB
@Consumes('multipart/form-data')
uploadAvatar(/* ... */) {}
```

- 上限を超えると `413 { message: 'Payload Too Large', limit }`。`Content-Length` が上限を超えていれば何も読まずに返します
- `Content-Length` の無いチャンク転送は、読みながら数えて超えた時点で打ち切ります（上限内なら読んだ内容をそのまま後段へ渡します）
- 制限のあるルート（ボディを持つメソッド）だけが判定を通り、GET や制限の無いルートには一切コストがかかりません
- Bun の `listen({ maxRequestBodySize })`（既定 128 MiB）はサーバ全体の上限、こちらはルートごとの上限です

## タイムアウトとレートリミット

```ts
import { createTimeoutMiddleware } from '@kivin/http';
import { createRateLimitMiddleware } from '@kivin/security';

globals: {
  middleware: [
    createRateLimitMiddleware({ limit: 100, windowMs: 60_000 }),
    createTimeoutMiddleware(10_000),
  ],
},
```

`createTimeoutMiddleware(ms, { status?, message? })`:

- 後続（ガード・ハンドラなど）が `ms` 以内に終わらなければ `504 { message: 'Request timed out' }` を返します（Hono と同じ。`status` で変更可）
- JavaScript ではハンドラを中断できないため、処理自体は裏で続きます。長い処理はクライアント切断を `request.signal` で検知できます

`createRateLimitMiddleware({ limit, windowMs, key?, headers?, store? })`:

- キーごとの固定ウィンドウでメモリ上に数えます。上限を超えると `429 { message: 'Too Many Requests' }` と `Retry-After`
- レスポンスに `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`（秒）を付けます（`headers: false` で無効）
- キーの既定はクライアントのアドレス（`getClientAddress(request)`、Bun の `server.requestIP`）。リバースプロキシの後ろではプロキシのアドレスになるので、信頼できる転送ヘッダから `key` を自分で作ってください。`key` が `undefined` を返したリクエストは制限しません
- 既定はプロセスごとのメモリ（`MemoryRateLimitStore`）です。複数インスタンスで上限を共有するには `store` に共有ストアを渡します:

  ```ts
  const redisStore: RateLimitStore = {
    async increment(key, windowMs, now) {
      const count = await redis.incr(`rl:${key}`);
      if (count === 1) await redis.pexpire(`rl:${key}`, windowMs);
      const ttl = await redis.pttl(`rl:${key}`);
      return { count, resetAt: now + Math.max(ttl, 0) };
    },
  };
  createRateLimitMiddleware({ limit: 100, windowMs: 60_000, store: redisStore });
  ```
## 圧縮と ETag

```ts
import { createCompressMiddleware, createEtagMiddleware } from '@kivin/http';

defineApplication({
  // ...
  // 圧縮を先に（外側に）置くと、ETag は圧縮前のボディで計算・比較されます
  globals: { middleware: [createCompressMiddleware(), createEtagMiddleware()] },
});
```

`createCompressMiddleware(options)`:

- `Accept-Encoding` の q 値に従い `br` → `gzip` の順で選びます（`encodings` で変更）。圧縮した／しうるレスポンスには `Vary: Accept-Encoding` を付けます
- brotli の品質は既定 4（gzip の約半分のサイズで同程度のコスト。品質 11 は約 100 倍遅い）。`brotliQuality` / `gzipLevel` で変更できます
- 圧縮しないもの: `threshold`（既定 1024 バイト）未満、画像など非テキスト（`filter` で変更）、`text/event-stream`、HEAD、204 / 206 / 304、`Cache-Control: no-transform`、すでに `Content-Encoding` があるもの
- `application/x-ndjson` はバッファせずストリームのまま圧縮します。強い ETag は弱い ETag に変えます

`createEtagMiddleware(options)`:

- GET / HEAD の 200 で ETag の無いレスポンスに、ボディのハッシュから弱い ETag を付け、`If-None-Match` が一致すれば `304` を返します
- SSE / NDJSON、`maxSize`（既定 1 MiB）を超えるボディ、すでに ETag があるもの（`serveStatic` など）はそのまま通します
## 静的ファイル

`serveStatic` は Bun のネイティブルートにそのまま渡せるハンドラです（アプリのルートと同じく Bun のルーターで振り分けられます）。

```ts
import { serveStatic } from '@kivin/static';

app.listen({
  port: 3000,
  routes: {
    // ハッシュ付きアセットは長期キャッシュ
    '/assets/*': serveStatic({ root: './public/assets', prefix: '/assets', cacheControl: 'public, max-age=31536000, immutable', precompressed: true }),
    // SPA: 存在しないパスへの HTML ナビゲーションは index.html
    '/app/*': serveStatic({ root: './web/dist', prefix: '/app', fallback: 'index.html' }),
  },
});
```

- Content-Type は拡張子から、`ETag`（弱い検証子）と `Last-Modified` を付け、`If-None-Match` / `If-Modified-Since` に `304` を返します
- `Range: bytes=…`（単一範囲）に `206`、範囲外は `416`。`If-Range` が古ければ全体を返します
- `root` の外に出るパス（`..`、`%2e%2e`、`%2f` / `\` を含むもの、NUL）は `404`。ドットファイル（`.env` など）も既定で `404`（`dotfiles: 'allow'` で許可）
- ディレクトリには `index.html`（`index` で変更、`false` で無効）
- `precompressed: true` で、`Accept-Encoding` に応じて隣の `.br` / `.gz` を返します（`Content-Encoding` と `Vary` 付き）
- GET / HEAD 以外は `405`
## Basic / Bearer 認証と CSRF

```ts
import { createBasicAuthGuard, createBearerAuthGuard, createCsrfMiddleware, readBasicCredentials } from '@kivin/security';

export const AdminGuard = createBasicAuthGuard({ users: { admin: process.env.ADMIN_PASSWORD! }, realm: 'Admin' });
export const ApiKeyGuard = createBearerAuthGuard({ tokens: [process.env.API_KEY!] });

@Get('/admin')
@UseGuards(AdminGuard)
admin({ context }: RouteInput) {
  return { user: readBasicCredentials(context.request)?.username };
}
```

- `createBasicAuthGuard({ users | verify, realm })`: 失敗時は `401` と `WWW-Authenticate: Basic realm="…", charset="UTF-8"`。`users` は定数時間で比較し、どのユーザー名が存在するかが時間差で分からないよう全件を比較します。パスワードハッシュなどは `verify` で
- `createBearerAuthGuard({ tokens | verify, realm })`: 静的な API キーなど。JWT は `@kivin/jwt` の `createJwtGuard` を使ってください
- どちらも `canActivateRaw` を持つので、context を作らない高速な経路で動きます

`createCsrfMiddleware({ trustedOrigins })` は、ブラウザからのクロスサイトな状態変更リクエストを `403` にします（Go 1.25 の `CrossOriginProtection` と同じ判定）:

- GET / HEAD / OPTIONS は常に通す
- `Sec-Fetch-Site` があれば `same-origin` か `none` のときだけ通す（`same-site` のサブドメインも拒否）
- 無ければ `Origin` のホストがリクエストの `Host` と一致するときだけ通す。どちらのヘッダも無いリクエスト（curl やサーバ間通信）は通す
- `trustedOrigins` に挙げたオリジンは常に許可
- フォームの Content-Type だけを見る方式と違い、JSON など全ボディ型を対象にします

## IP 制限（`@kivin/security`）

許可リスト / 拒否リスト（Hono の `ipRestriction` 相当）。IPv4 / IPv6 のアドレス、CIDR、`*`、判定関数を指定できます。

```ts
import { createIpRestrictionGuard } from '@kivin/security';

// 管理画面は社内ネットワークだけ
@UseGuards(createIpRestrictionGuard({ allow: ['10.0.0.0/8', '192.168.0.0/16', '::1'], deny: ['10.0.13.0/24'] }))
@Controller('/admin')
export class AdminController { ... }
```

- 拒否リストが優先され、許可リストがあれば一致しないアドレスは `403` です。
- `::ffff:10.1.2.3` のような IPv4-mapped IPv6 は IPv4 として判定します。
- アドレスは既定で接続元（`getClientAddress`）です。リバースプロキシの後ろでは `getAddress` でプロキシが付けたアドレス（`X-Forwarded-For` の最後の値など、信頼できるもの）を返してください。
- アドレスが分からない・解釈できない場合は既定で拒否します（`unknown: 'allow'` で許可）。`app.fetch` を直接呼ぶテストには接続元が無いので、`getAddress` を差し替えてください。
- ガードはマッチしたルートにだけ効きます。`listen({ routes })` の静的ファイルなども含め全リクエストを制限するなら、判定関数 `createIpRestriction(options)` を `onRequest` フックで使います: `onRequest: (request) => (passes(request) ? undefined : Response.json({ message: 'Forbidden' }, { status: 403 }))`。

### いずれかの認証を通す（`anyGuard`）

```ts
import { anyGuard, createBasicAuthGuard, createBearerAuthGuard } from '@kivin/security';

// API トークンでも Basic 認証でもよい
@UseGuards(anyGuard(createBearerAuthGuard({ tokens: [process.env.API_TOKEN!] }), createBasicAuthGuard({ users: { admin: process.env.ADMIN_PASSWORD! } })))
```

順番に試して最初に通ったもので許可します。すべて拒否した場合は最初の `HttpError`（`WWW-Authenticate` 付きの 401 など）を返し、どれも例外を投げなければ 403 です。合成するガードはコンストラクタ依存を持たないもの（`@kivin/security` / `@kivin/jwt` のファクトリで作るガードなど）に限ります。

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

- `upgrade` が例外を投げると `500 { message: 'Internal Server Error' }` を返します（スタックトレースは返しません）
- `open` / `message` / `close` / `drain` の例外（async の reject を含む）は、ルートの `error(socket, error, phase)` フックに渡されます。フックが無ければ `console.error` に出力します。接続は維持されますが、`open` が失敗した場合だけ 1011 で閉じます
- kivin の外で起きたエラー（`listen({ routes })` に渡した native route など）も、Bun の既定エラーページではなく汎用の 500 になります（`listen({ error })` で上書きできます）

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

## ストリーミング（`@kivin/http`）

SSE 以外のストリーミングには `stream` / `streamText` / `streamNdjson` を使います。返した `Response` には通常どおりキューされたヘッダや Cookie が付きます。

```ts
import { streamNdjson, streamText } from '@kivin/http';

@Get('/export')
export({ context }: RouteInput) {
  // DB カーソルなどの async iterable を 1 行 1 JSON で流す。切断されたら反復をやめる
  return streamNdjson(this.users.cursor(), { signal: context.request.signal });
}

@Get('/progress')
progress({ context }: RouteInput) {
  return streamText(async (out) => {
    for (let step = 1; step <= 10 && !out.aborted; step += 1) {
      await out.writeln(`step ${step}/10`);
      await out.sleep(500);              // 切断されると即座に起きる
    }
  }, { signal: context.request.signal });
}
```

- `write` はクライアントが受け取るまで待つ（バックプレッシャー）。切断後の `write` は何もしません。
- ハンドラが投げた例外は、レスポンス開始後なのでステータスは変えられません。既定ではログに出してストリームを閉じます。`onError(error, writer)` で最後のチャンクを書けます。
- `signal: context.request.signal` を渡すと、書き込んでいない間の切断も `onAbort` / `aborted` に反映されます。

## リバースプロキシ（`@kivin/http`）

```ts
import { proxy } from '@kivin/http';

app.listen({
  port: 3000,
  routes: {
    // /api/* をバックエンドへ（パスの /api を外して転送）
    '/api/*': (request) => {
      const url = new URL(request.url);
      return proxy(`http://backend:8080${url.pathname.slice(4)}${url.search}`, request, { timeoutMs: 10_000 });
    },
  },
});
```

- メソッド・ヘッダ・ボディをそのまま転送し（ボディはストリーミング）、`Connection` などのホップバイホップヘッダは往復とも取り除きます。
- `X-Forwarded-For`（接続元を追記）/ `X-Forwarded-Host` / `X-Forwarded-Proto` を付けます（`forwarded: false` で無効）。
- 上流のレスポンスは圧縮されたまま返すので、`Content-Encoding` と中身が食い違いません。
- 上流に届かなければ 502、`timeoutMs` を超えたら 504。クライアントが切断すると上流へのリクエストも中断します。

## HTML テンプレート（`@kivin/http`）

```ts
import { html, htmlResponse, raw } from '@kivin/http';

@Get('/users/:id/card')
card({ params }: RouteInput<{ params: typeof IdSchema }>) {
  const user = this.users.find(params.id);
  return htmlResponse(html`
    <article>
      <h1>${user.name}</h1>                       <!-- 自動でエスケープ -->
      <ul>${user.tags.map((tag) => html`<li>${tag}</li>`)}</ul>
      ${user.admin && html`<span class="badge">admin</span>`}
      ${raw(trustedSnippet)}                       <!-- 信頼できるマークアップだけ -->
    </article>`);
}
```

埋め込んだ値はすべて HTML エスケープされます（属性値も含む）。`html` で作ったものは二重にエスケープされず、配列は連結、`null` / `undefined` / 真偽値は何も出力しません。

## 現在のリクエストへのアクセス（`@kivin/http`）

```ts
import { createRequestStorageMiddleware, getCurrentRequest, setRequestValue, getRequestValue } from '@kivin/http';

defineApplication({ ..., globals: { middleware: [createRequestStorageMiddleware() /* 先頭に */] } });

// どこからでも（リクエストを引数で渡さなくても）
export function audit(event: string) {
  const request = getCurrentRequest();
  logger.info({ event, path: request && new URL(request.url).pathname, tenant: getRequestValue('tenant') });
}
```

AsyncLocalStorage を使うので、`await` をまたいでも各リクエストで分離されます。ミドルウェアを入れたリクエストにだけコストがかかります。

## コンテンツネゴシエーション（`@kivin/http`）

```ts
import { acceptsLanguage, acceptsType } from '@kivin/http';

show({ context }: RouteInput) {
  const lang = acceptsLanguage(context.request, ['ja', 'en'], 'en');      // ja-JP → ja、en-US → en
  const type = acceptsType(context.request, ['application/json', 'text/html']);
  if (!type) throw httpError(406, 'Not Acceptable');
  ...
}
```

q 値の高いものを選び、同じ q なら具体的な一致（`text/html` > `text/*` > `*/*`）、次にクライアントの順序を優先します。`text/html;q=0, */*` のように明示的に `q=0` を付けた値は `*` があっても選ばれません。エンコーディングは同じ q ならサーバー側の順序（`createCompressMiddleware` の既定は brotli → gzip）です。

## ルーティング前のフック（`onRequest`）

`defineApplication({ onRequest })` に渡したフックは、ルーティングの前に全リクエストで順に実行されます（Bun のネイティブルートに載ったルートも含む）。`Response` を返すと即座に応答し、`Request` を返すとそのリクエストとしてルーティングし直します。フックを設定しなければオーバーヘッドはありません。

```ts
import { createMethodOverride, createPrettyJsonMiddleware, createTrailingSlash } from '@kivin/http';

defineApplication({
  modules: [AppModule],
  schemaAdapter: createValibotAdapter(),
  onRequest: [
    createTrailingSlash(),                         // /users/ → 301 /users（クエリは維持）
    createMethodOverride(),                        // <form method="post"> + _method=DELETE → DELETE ルート
    (request) => (isMaintenance() ? new Response('maintenance', { status: 503 }) : undefined),
  ],
  globals: { middleware: [createPrettyJsonMiddleware()] },   // ?pretty で JSON をインデント
});
```

- `createMethodOverride` は POST だけを対象にし、既定では PUT / PATCH / DELETE のみ許可します。フォームはクローンから読むので、ルート側でも同じボディを読めます。`{ from: { header: 'X-HTTP-Method-Override' } }` や `{ from: { query: '_method' } }` も指定できます。
- `createTrailingSlash` は `//evil.example/` のようなパスでも `Location` が `//` で始まらないようにしています（オープンリダイレクト対策）。kivin はもともと末尾スラッシュの有無を同じルートとして扱うので、これは URL を 1 つにそろえるためのものです。
- フックが書き換えたリクエストでも `getClientAddress` は元の接続元を返します。

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

## リクエスト ID

```ts
import { createRequestIdMiddleware, getRequestId } from '@kivin/http';
import { RequestLoggerMiddleware } from '@kivin/logger';

// ID を先（外側）に置くと、ロガーの request.* レコードに同じ requestId が入ります
globals: { middleware: [createRequestIdMiddleware(), RequestLoggerMiddleware] },
```

- 受け取った `x-request-id`（ロードバランサが付けたものなど）が `[A-Za-z0-9._:-]{1,128}` ならそのまま使い、それ以外（空白・制御文字・長すぎるもの）は新しい UUID に置き換えます。ログやレスポンスヘッダへの注入を防ぐためです
- レスポンスに同じヘッダを付け、ハンドラからは `getRequestId(request)` / `context.get('requestId')` で読めます
- `header`（既定 `x-request-id`）、`trustIncoming: false`（常に新規発行）、`generate` を変更できます

## 観測（`@kivin/observability`）

### Prometheus メトリクス

```ts
import { createMetrics } from '@kivin/observability';

const metrics = createMetrics();
const app = createApp(defineApplication({ ..., globals: { middleware: [metrics.middleware] } }), manifest);
app.listen({ port: 3000, routes: { '/metrics': metrics.handler } });
```

- `http_requests_total` / `http_request_duration_seconds{method, route, status}` と `http_requests_in_flight`、プロセスの CPU / メモリ / 起動時刻を出します。
- `route` はルートのテンプレート（`/users/:id`）なので系列数が増え続けません。ルートに一致しなかったリクエスト（404）は数えません。
- `status` は最終レスポンスのステータスです。例外フィルタがドメインエラーを 404 に変換した場合も 500 ではなく 404 として数えます（core の `afterResponse` を使用）。
- 独自メトリクスは `metrics.registry.counter({ name, help, labelNames })` / `gauge` / `histogram` で追加できます。
- `/metrics` は公開しないでください（`createIpRestriction` を使う、別ポートで listen する、など）。

### OpenTelemetry トレース

依存を持たないので、アプリ側で `@opentelemetry/api` と SDK を入れて tracer を渡します。

```ts
import { context, propagation, trace } from '@opentelemetry/api';
import { createTracingMiddleware } from '@kivin/observability';

const Tracing = createTracingMiddleware({ tracer: trace.getTracer('my-app'), propagation, context });
defineApplication({ ..., globals: { middleware: [Tracing /* 先頭に置く */, ...] } });
```

- リクエストごとに SERVER スパン（名前は `GET /users/:id`）を作り、`http.request.method` / `http.route` / `url.path` / `server.address` / `client.address` / `user_agent.original` / `http.response.status_code` を付けます。
- `propagation` と `context` を渡すと受信した `traceparent` からトレースを継続します。ハンドラの実行中はスパンがアクティブなので、計装された fetch や DB ドライバのスパンは子になります。
- スパンは最終レスポンスで終わり、5xx ならエラーにして元の例外を記録します（フィルタが 4xx にしたものはエラーにしません）。

### Server-Timing

```ts
import { createServerTimingMiddleware, serverTiming } from '@kivin/observability';

defineApplication({ ..., globals: { middleware: [createServerTimingMiddleware({ enabled: (request) => isInternal(request) })] } });

async show({ context }: RouteInput) {
  const user = await serverTiming(context.request).measure('db', () => this.users.find(id));
  ...
}
// Server-Timing: db;dur=3.2, total;dur=4.1   （ブラウザの Network パネルに表示）
```

処理時間はタイミング攻撃の手がかりにもなるので、本番では `enabled` で社内からのリクエストなどに絞ることを勧めます。

### ヘルスチェック

```ts
import { createHealthCheck } from '@kivin/observability';

const health = createHealthCheck({ checks: { db: () => db.query('select 1'), redis: () => redis.ping() }, timeoutMs: 2000 });
const server = app.listen({ port: 3000, routes: health.routes() });   // GET /livez, GET /readyz

process.once('SIGTERM', async () => {
  health.setReady(false);   // ロードバランサが外すまで待ってから停止
  await Bun.sleep(5000);
  await app.close();
  process.exit(0);
});
```

- `/livez` はチェックを行わず常に 200 です（依存先の障害でプロセスを再起動させないため）。
- `/readyz` はチェックを並列に実行し、例外・`false`・タイムアウトのいずれかで 503 と失敗したチェックを返します（`details: false` で名前だけ）。

## 環境変数（`@kivin/config`）

起動時に一度だけ環境変数を検証し、型付きの値として使います。不正な変数はすべてまとめてエラーにし、値（パスワードなど）はメッセージに出しません。

```ts
import { envProvider, loadEnv } from '@kivin/config';
import * as v from 'valibot';

const Env = v.object({
  PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer()), '3000'),
  DATABASE_URL: v.pipe(v.string(), v.url()),
  LOG_LEVEL: v.optional(v.picklist(['debug', 'info', 'warn', 'error']), 'info'),
});

export const env = loadEnv(Env);                  // { PORT: number; DATABASE_URL: string; LOG_LEVEL: … }
// DI で使うなら
export const ENV = createToken<typeof env>('app.env');
defineModule({ providers: [envProvider(ENV, Env)], ... });
```

Standard Schema に対応したライブラリ（Valibot / Zod / ArkType）ならそのまま渡せます。それ以外は `{ adapter }` を指定します。`prefix: 'APP_'` を付けると `APP_PORT` を `PORT` として読み、無関係な変数は schema に渡しません。

## 定期実行（`@kivin/schedule`）

```ts
import { Scheduler } from '@kivin/schedule';

@Injectable({ deps: [ReportService] })
export class Jobs extends Scheduler {
  constructor(reports: ReportService) {
    super({ timeZone: 'Asia/Tokyo' });
    this.cron('daily-report', '0 9 * * MON-FRI', () => reports.send());
    this.cron('cleanup', '*/15 * * * *', () => reports.purgeExpired(), { overlap: 'skip' });
  }
}
// providers: [Jobs]
await app.init();          // onApplicationBootstrap で開始
app.listen(3000);
await app.close();         // 停止し、実行中のジョブを待つ（既定 30 秒まで）
```

- cron 式は 5 フィールド（秒を付けると 6）。`*/15`・`1-5`・`MON-FRI`・`JAN`・`@daily` などに対応し、日と曜日の両方を指定した場合はどちらかに一致すれば実行します（一般的な cron と同じ）。
- タイムゾーンは IANA 名で指定し、夏時間を考慮します（存在しない時刻の実行は飛ばし、2 回ある時刻は 1 回だけ）。
- 前回の実行が終わっていなければ、次の回は既定でスキップします（`overlap: 'allow'` で重ねて実行）。
- 例外はログに出して次回以降も続けます（`onError` で通知先を変更可）。`run(name)` で手動実行、`list()` で次回実行時刻を確認できます。
- 複数のインスタンスで動かすと、それぞれで実行されます。1 回だけ実行したいジョブはロックなどで排他してください。

## セッション（`@kivin/session`）

```ts
import { createSessionMiddleware, getSession } from '@kivin/session';

const Sessions = createSessionMiddleware({
  secret: [process.env.SESSION_SECRET!, process.env.SESSION_SECRET_OLD!].filter(Boolean),
  cookie: { secure: true },            // 既定は HttpOnly / SameSite=Lax / Path=/
  ttl: 60 * 60 * 24 * 7,
  // store: new RedisSessionStore(...)  // SessionStore を実装したもの（既定はメモリ）
});
defineApplication({ ..., globals: { middleware: [Sessions] } });

login({ context, body }: RouteInput<{ body: typeof LoginSchema }>) {
  const session = getSession<{ userId: string }>(context.request);
  session.regenerate();                // ログイン時は ID を作り直す（セッション固定化攻撃対策）
  session.set('userId', user.id);
}

logout({ context }: RouteInput) {
  getSession(context.request).destroy();
}
```

- セッション ID は 32 バイトの乱数で、Cookie には署名付きで入れます。署名が合わない・ストアに無い ID はクライアントの値を使わず、新しい ID にします。
- 何かを設定するまではセッションを作らず Cookie も出しません（匿名アクセスでストアが膨らまない）。変更があった時だけ保存し、`rolling: true` ならアクセスのたびに期限を延ばします。
- `MemorySessionStore` は開発・テスト・単一プロセス向けです（再起動で消え、プロセス間で共有されない）。

## GraphQL（`@kivin/graphql`）

GraphQL Yoga をそのまま Bun のネイティブルートに載せます（kivin 側は Yoga に依存しません）。

```ts
import { createSchema, createYoga } from 'graphql-yoga';
import { createGraphqlRoutes } from '@kivin/graphql';

const yoga = createYoga<{ users: UserService; userId?: string }>({ schema: createSchema({ typeDefs, resolvers }) });
await app.init();
app.listen({
  port: 3000,
  routes: createGraphqlRoutes(yoga, {
    context: async (request) => ({ users: app.get(UserService), userId: await authenticate(request) }),
  }),
});
```

`context` は Yoga がリゾルバのコンテキストに混ぜるサーバーコンテキストです。`HttpError`（`unauthorized()` など）や `Response` を投げるとそのまま応答します。ガードやミドルウェアはコントローラーのルート用なので、GraphQL の認証は `context` か `onRequest` フックで行ってください。

## 未処理の例外

フィルタで処理されなかった例外は、クライアントには `500 { message: 'Internal Server Error' }` だけを返し（原因やスタックは返しません）、サーバ側では `console.error('[kivin] Unhandled error', error)` に 1 回出力します。

- `HttpError` やフィルタが応答を返した例外は出力しません
- `@kivin/logger` の `RequestLoggerMiddleware` が `request.error` として記録した例外は二重に出しません
- 独自のロガーで記録する場合は、記録後に `markErrorReported(error)` を呼ぶと既定の出力を抑止できます

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
