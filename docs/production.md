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

## JWT（`@kivinjs/jwt`）

Web Crypto ベースで依存はありません。HS* / RS* / PS* / ES* / EdDSA に対応しています。

```ts
import { createJwtGuard, getJwtPayload, signJwt } from '@kivinjs/jwt';

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
import { createJwtGuard, createRemoteJwks } from '@kivinjs/jwt';

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
import { createTimeoutMiddleware } from '@kivinjs/http';
import { createRateLimitMiddleware } from '@kivinjs/security';

globals: {
  middleware: [
    createRateLimitMiddleware({ limit: 100, windowMs: 60_000 }),
    createTimeoutMiddleware(10_000),
  ],
},
```

`createTimeoutMiddleware(ms, { status?, message? })`:

- 後続（ハンドラなど）が `ms` 以内に終わらなければ `504 { message: 'Request timed out' }` を返します（Hono と同じ。`status` で変更可）
- **ガードは対象外です。** ガードはミドルウェアより前に実行されるため（[pipeline.md](pipeline.md)）、ガードの中で止まった処理にはこのタイムアウトが効きません。外部への認証確認など遅くなりうる処理は、ガード自身の中で `AbortSignal.timeout(ms)` などのタイムアウトを持たせてください
- JavaScript ではハンドラを中断できないため、処理自体は裏で続きます。長い処理はクライアント切断を `request.signal` で検知できます

`createRateLimitMiddleware({ limit, windowMs, key?, headers?, store? })`:

- **ガードより後に実行されます。** ガードが拒否したリクエスト（認証失敗など）はこのミドルウェアに届かないため数えられず、パスワードやトークンの総当たりは制限されません。認証の試行回数を制限するには、リバースプロキシ / WAF で制限するか、認証ガードの前に `RateLimitStore`（`MemoryRateLimitStore` など）の `increment` を呼ぶ独自ガードを置いてください
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
import { createCompressMiddleware, createEtagMiddleware } from '@kivinjs/http';

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
import { serveStatic } from '@kivinjs/static';

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
import { createBasicAuthGuard, createBearerAuthGuard, createCsrfMiddleware, readBasicCredentials } from '@kivinjs/security';

export const AdminGuard = createBasicAuthGuard({ users: { admin: process.env.ADMIN_PASSWORD! }, realm: 'Admin' });
export const ApiKeyGuard = createBearerAuthGuard({ tokens: [process.env.API_KEY!] });

@Get('/admin')
@UseGuards(AdminGuard)
admin({ context }: RouteInput) {
  return { user: readBasicCredentials(context.request)?.username };
}
```

- `createBasicAuthGuard({ users | verify, realm })`: 失敗時は `401` と `WWW-Authenticate: Basic realm="…", charset="UTF-8"`。`users` は定数時間で比較し、どのユーザー名が存在するかが時間差で分からないよう全件を比較します。パスワードハッシュなどは `verify` で
- `createBearerAuthGuard({ tokens | verify, realm })`: 静的な API キーなど。JWT は `@kivinjs/jwt` の `createJwtGuard` を使ってください
- どちらも `canActivateRaw` を持つので、context を作らない高速な経路で動きます

`createCsrfMiddleware({ trustedOrigins })` は、ブラウザからのクロスサイトな状態変更リクエストを `403` にします（Go 1.25 の `CrossOriginProtection` と同じ判定）:

- GET / HEAD / OPTIONS は常に通す
- `Sec-Fetch-Site` があれば `same-origin` か `none` のときだけ通す（`same-site` のサブドメインも拒否）
- 無ければ `Origin` のホストがリクエストの `Host` と一致するときだけ通す。どちらのヘッダも無いリクエスト（curl やサーバ間通信）は通す
- `trustedOrigins` に挙げたオリジンは常に許可
- フォームの Content-Type だけを見る方式と違い、JSON など全ボディ型を対象にします

## IP 制限（`@kivinjs/security`）

許可リスト / 拒否リスト（Hono の `ipRestriction` 相当）。IPv4 / IPv6 のアドレス、CIDR、`*`、判定関数を指定できます。

```ts
import { createIpRestrictionGuard } from '@kivinjs/security';

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
import { anyGuard, createBasicAuthGuard, createBearerAuthGuard } from '@kivinjs/security';

// API トークンでも Basic 認証でもよい
@UseGuards(anyGuard(createBearerAuthGuard({ tokens: [process.env.API_TOKEN!] }), createBasicAuthGuard({ users: { admin: process.env.ADMIN_PASSWORD! } })))
```

順番に試して最初に通ったもので許可します。すべて拒否した場合は最初の `HttpError`（`WWW-Authenticate` 付きの 401 など）を返し、どれも例外を投げなければ 403 です。

合成するガードはアプリのコンテナが作るので、コンストラクタ依存（`@Injectable({ deps })`）を持つガードもそのまま使えます。合成されるガードをモジュールの `providers` に書く必要はありません（依存先のサービスはモジュールが提供します）。モジュールが提供しているガードはその単一のインスタンスを共有し、request-scoped のガードを含む場合は合成したガードも request-scoped になります。

```ts
@Injectable({ deps: [ApiKeyRepository] })
class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeyRepository) {}
  async canActivate(context: RequestContext) {
    return this.keys.isValid(context.request.headers.get('x-api-key'));
  }
}

@UseGuards(anyGuard(ApiKeyGuard, createBasicAuthGuard({ users: { admin: process.env.ADMIN_PASSWORD! } })))
```

### すべて通す / 一部のルートで外す（`everyGuard` / `exceptGuard`）

Hono の `combine` の `every` / `except` に相当します。

```ts
import { anyGuard, everyGuard, exceptGuard } from '@kivinjs/security';

// セッション + CSRF の両方、または API トークン
@UseGuards(anyGuard(everyGuard(SessionGuard, CsrfGuard), ApiTokenGuard))

// アプリ全体に認証を掛け、ヘルスチェックと公開ページだけ外す
defineApplication({ ..., globals: { guards: [exceptGuard(['/health', '/public/*'], ApiKeyGuard)] } });
```

- `everyGuard(...guards)` は順番にすべて通れば許可し、最初の拒否で止まります。`@UseGuards(A, B)` と同じ意味なので、`anyGuard` の中で組み合わせるときに使います。
- `exceptGuard(exempt, ...guards)` は `exempt` に一致するルートではガードを実行せずに許可します。パスはルートのテンプレート（`route.fullPath`。`basePath` を含む）と比較し、`'/health'` は完全一致、`'/public/*'` は `/public` とその配下に一致します。判定はルートごとに 1 回だけで、リクエスト毎のコストはありません。`(request, route) => boolean` を渡すとリクエスト毎に判定します。
- どちらも、合成したガードがすべて raw 対応（`canActivateRaw`）ならコンテキストを作らない速い経路のままで、ガードが同期的に答える間は判定も同期的です。

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
- kivin の外で起きたエラー（`listen({ routes })` に渡した native route など）も、Bun の既定エラーページではなく汎用の 500 になります（`ListenOptions` に `error` の型はないため、この応答を TypeScript から差し替えることはできません。kivin のルートのエラーは例外フィルタで整形してください）

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

## ストリーミング（`@kivinjs/http`）

SSE 以外のストリーミングには `stream` / `streamText` / `streamNdjson` を使います。返した `Response` には通常どおりキューされたヘッダや Cookie が付きます。

```ts
import { streamNdjson, streamText } from '@kivinjs/http';

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

## リバースプロキシ（`@kivinjs/http`）

```ts
import { proxy } from '@kivinjs/http';

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

## HTML テンプレート（`@kivinjs/http`）

```ts
import { html, htmlResponse, raw } from '@kivinjs/http';

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

### JSX

Bun は `.tsx` をそのまま実行できるので、kivin は JSX ランタイムを同梱しません。React（`react-dom/server`）などで描画したストリームを `htmlResponse` に渡します。

```tsx
// pages.controller.tsx（tsconfig: "jsx": "react-jsx"）
import { renderToReadableStream } from 'react-dom/server';
import { htmlResponse } from '@kivinjs/http';

function Page({ name }: { name: string }) {
  return <html><body><h1>Hello, {name}</h1></body></html>;
}

@Controller('/')
export class PagesController {
  @Get('/')
  async home() {
    return htmlResponse(await renderToReadableStream(<Page name="kivin" />));
  }
}
```

Hono の `jsxRenderer` のようなレイアウトの共通化は、レイアウト用のコンポーネントで包めば足ります。Preact（`preact-render-to-string`）など文字列を返すレンダラーは `htmlResponse(renderToString(<Page />))` です。

## 現在のリクエストへのアクセス（`@kivinjs/http`）

```ts
import { createRequestStorageMiddleware, getCurrentRequest, setRequestValue, getRequestValue } from '@kivinjs/http';

defineApplication({ ..., globals: { middleware: [createRequestStorageMiddleware() /* 先頭に */] } });

// どこからでも（リクエストを引数で渡さなくても）
export function audit(event: string) {
  const request = getCurrentRequest();
  logger.info({ event, path: request && new URL(request.url).pathname, tenant: getRequestValue('tenant') });
}
```

AsyncLocalStorage を使うので、`await` をまたいでも各リクエストで分離されます。ミドルウェアを入れたリクエストにだけコストがかかります。

## コンテンツネゴシエーション（`@kivinjs/http`）

```ts
import { acceptsLanguage, acceptsType } from '@kivinjs/http';

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
import { createMethodOverride, createPrettyJsonMiddleware, createTrailingSlash } from '@kivinjs/http';

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
import { createRequestIdMiddleware, getRequestId } from '@kivinjs/http';
import { RequestLoggerMiddleware } from '@kivinjs/logger';

// ID を先（外側）に置くと、ロガーの request.* レコードに同じ requestId が入ります
globals: { middleware: [createRequestIdMiddleware(), RequestLoggerMiddleware] },
```

- 受け取った `x-request-id`（ロードバランサが付けたものなど）が `[A-Za-z0-9._:-]{1,128}` ならそのまま使い、それ以外（空白・制御文字・長すぎるもの）は新しい UUID に置き換えます。ログやレスポンスヘッダへの注入を防ぐためです
- レスポンスに同じヘッダを付け、ハンドラからは `getRequestId(request)` / `context.get('requestId')` で読めます
- `header`（既定 `x-request-id`）、`trustIncoming: false`（常に新規発行）、`generate` を変更できます

## 観測（`@kivinjs/observability`）

### Prometheus メトリクス

```ts
import { createMetrics } from '@kivinjs/observability';

const metrics = createMetrics();
const app = createApp(defineApplication({ ..., globals: { middleware: [metrics.middleware] } }), manifest);
app.listen({ port: 3000, routes: { '/metrics': metrics.handler } });
```

- `http_requests_total` / `http_request_duration_seconds{method, route, status}` と `http_requests_in_flight`、プロセスの CPU / メモリ / 起動時刻を出します。
- `route` はルートのテンプレート（`/users/:id`）なので系列数が増え続けません。
- ルートに一致しなかったリクエスト（404、405、自動の `OPTIONS` / CORS プリフライト）と、`onRequest` フックが返した応答（末尾スラッシュのリダイレクトなど）は `route="(unmatched)"` で `http_requests_total` にだけ数えます。スキャンや誤ったクライアントの検知に使えます。処理時間はほぼゼロでレイテンシの分布をゆがめるため、ヒストグラムには入れません。`method` は既知のメソッド以外を `_OTHER` にまとめます。`createMetrics({ unmatchedRoute: 'other' })` でラベルを変え、`false` で数えません。`metrics.middleware` を `globals.middleware` に入れたときだけ有効です（ルート単位のミドルウェアでは数えません）。
- `status` は最終レスポンスのステータスです。例外フィルタがドメインエラーを 404 に変換した場合も 500 ではなく 404 として数えます（core の `afterResponse` を使用）。
- 独自メトリクスは `metrics.registry.counter({ name, help, labelNames })` / `gauge` / `histogram` で追加できます。
- `/metrics` は公開しないでください（`createIpRestriction` を使う、別ポートで listen する、など）。

### OpenTelemetry トレース

依存を持たないので、アプリ側で `@opentelemetry/api` と SDK を入れて tracer を渡します。

```ts
import { context, propagation, trace } from '@opentelemetry/api';
import { createTracingMiddleware } from '@kivinjs/observability';

const Tracing = createTracingMiddleware({ tracer: trace.getTracer('my-app'), propagation, context });
defineApplication({ ..., globals: { middleware: [Tracing /* 先頭に置く */, ...] } });
```

- リクエストごとに SERVER スパン（名前は `GET /users/:id`）を作り、`http.request.method` / `http.route` / `url.path` / `server.address` / `client.address` / `user_agent.original` / `http.response.status_code` を付けます。
- `propagation` と `context` を渡すと受信した `traceparent` からトレースを継続します。ハンドラの実行中はスパンがアクティブなので、計装された fetch や DB ドライバのスパンは子になります。
- 親子関係には `@opentelemetry/context-async-hooks` の `AsyncLocalStorageContextManager` を `context.setGlobalContextManager` で登録してください。継続には `@opentelemetry/core` の `W3CTraceContextPropagator` の登録も必要です。Bun 上で `await` をまたいで親子になることを結合テストで確認しています。
- スパンは最終レスポンスで終わり、5xx ならエラーにして元の例外を記録します（フィルタが 4xx にしたものはエラーにしません）。

### Server-Timing

```ts
import { createServerTimingMiddleware, serverTiming } from '@kivinjs/observability';

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
import { createHealthCheck } from '@kivinjs/observability';

const health = createHealthCheck({ checks: { db: () => db.query('select 1'), redis: () => redis.ping() }, timeoutMs: 2000 });
app.listen({
  port: 3000,
  routes: health.routes(),                         // GET /livez, GET /readyz
  shutdownSignals: true,
  onShutdownStart: () => health.setReady(false),   // /readyz を 503 にする
  shutdownDelayMs: 5000,                           // ロードバランサが外すまで受付を続ける
});
```

- `/livez` はチェックを行わず常に 200 です（依存先の障害でプロセスを再起動させないため）。
- `/readyz` はチェックを並列に実行し、例外・`false`・タイムアウトのいずれかで 503 と失敗したチェックを返します（`details: false` で名前だけ）。

## 環境変数（`@kivinjs/config`）

起動時に一度だけ環境変数を検証し、型付きの値として使います。不正な変数はすべてまとめてエラーにし、値（パスワードなど）はメッセージに出しません。

```ts
import { envProvider, loadEnv } from '@kivinjs/config';
import * as v from 'valibot';

const Env = v.object({
  PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.integer()), '3000'),
  DATABASE_URL: v.pipe(v.string(), v.url()),
  LOG_LEVEL: v.optional(v.picklist(['debug', 'info', 'warn', 'error']), 'info'),
});

// DI で使う（推奨）。検証は最初に解決されたときに行われる（起動時に `app.get(ENV)` などで解決すれば、環境変数の不備で即座に失敗する）
export const ENV = createToken<v.InferOutput<typeof Env>>('app.env');
defineModule({ providers: [envProvider(ENV, Env)], ... });

// DI を使わずに直接読むなら、モジュールの先頭ではなく起動処理の中で呼ぶ
// const env = loadEnv(Env);                      // { PORT: number; DATABASE_URL: string; LOG_LEVEL: … }
```

> **`kivin generate` はエントリ（`app.ts`）とその import 先をすべて実行します。** モジュールの先頭で `export const env = loadEnv(Env)` のように書くと、ビルドや CI（シークレットが無い環境）で `generate` が `Invalid environment variables:` で失敗します。環境変数の検証は `envProvider`（DI）か、`main.ts` など `generate` が読み込まない場所で行ってください。`app.ts` から辿れるファイルのトップレベルでは、環境変数・ネットワーク・ファイルに依存する副作用を避けます。

Standard Schema に対応したライブラリ（Valibot / Zod / ArkType）ならそのまま渡せます。それ以外は `{ adapter }` を指定します。`prefix: 'APP_'` を付けると `APP_PORT` を `PORT` として読み、無関係な変数は schema に渡しません。

## 定期実行（`@kivinjs/schedule`）

```ts
import { Scheduler } from '@kivinjs/schedule';

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

## セッション（`@kivinjs/session`）

```ts
import { createSessionMiddleware, getSession } from '@kivinjs/session';

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

## GraphQL（`@kivinjs/graphql`）

GraphQL Yoga をそのまま Bun のネイティブルートに載せます（kivin 側は Yoga に依存しません）。

```ts
import { createSchema, createYoga } from 'graphql-yoga';
import { createGraphqlRoutes } from '@kivinjs/graphql';

const yoga = createYoga<{ users: UserService; userId?: string }>({ schema: createSchema({ typeDefs, resolvers }) });
await app.init();
app.listen({
  port: 3000,
  routes: createGraphqlRoutes(yoga, {
    context: async (request) => ({ users: app.get(UserService), userId: await authenticate(request) }),
  }),
});
```

GET（GraphiQL を含む）、POST、CORS preflight、SSE のサブスクリプションは実物の Yoga との結合テストで確認しています。

WebSocket のサブスクリプションには `graphql-ws` を `listen({ websockets })` に載せます。`upgrade` の戻り値をコンテキストに渡せます。

```ts
import { defineWebSocket } from '@kivinjs/core';
import { GRAPHQL_TRANSPORT_WS_PROTOCOL, makeServer } from 'graphql-ws';

const graphqlWs = makeServer<Record<string, unknown>, { userId: string }>({
  execute: (args) => args.rootValue.execute(args),
  subscribe: (args) => args.rootValue.subscribe(args),
  onSubscribe: async (context, _id, payload) => {
    const { schema, execute, subscribe, contextFactory, parse, validate } = yoga.getEnveloped({ userId: context.extra.userId });
    const document = parse(payload.query);
    const errors = validate(schema, document);
    if (errors.length > 0) {
      return errors;
    }
    return {
      schema, document,
      operationName: payload.operationName,
      variableValues: payload.variables,
      contextValue: await contextFactory(),
      rootValue: { execute, subscribe },
    };
  },
});

const sessions = new WeakMap<object, { receive?: (message: string) => Promise<void>; closed?: (code?: number, reason?: string) => Promise<void> }>();

const graphqlSocket = defineWebSocket<{ userId: string }>({
  upgrade: (request) => authenticate(request) ?? new Response('Unauthorized', { status: 401 }),
  open(socket) {
    const session: { receive?: (message: string) => Promise<void>; closed?: (code?: number, reason?: string) => Promise<void> } = {};
    sessions.set(socket, session);
    session.closed = graphqlWs.opened({
      protocol: GRAPHQL_TRANSPORT_WS_PROTOCOL,
      send: (message) => { socket.send(message); },
      close: (code, reason) => { socket.close(code, reason); },
      onMessage: (receive) => { session.receive = receive; },
    }, { userId: socket.data.data.userId });
  },
  async message(socket, message) {
    await sessions.get(socket)?.receive?.(String(message));
  },
  async close(socket, code, reason) {
    await sessions.get(socket)?.closed?.(code, reason);
  },
});

app.listen({ port: 3000, routes: createGraphqlRoutes(yoga, { context }), websockets: { '/graphql/ws': graphqlSocket } });
```

`context` は Yoga がリゾルバのコンテキストに混ぜるサーバーコンテキストです。`HttpError`（`unauthorized()` など）や `Response` を投げるとそのまま応答します。ガードやミドルウェアはコントローラーのルート用なので、GraphQL の認証は `context` か `onRequest` フックで行ってください。

### Apollo Server

Apollo Server（v4 / v5）には fetch 用の公式インテグレーションが無いので、`executeHTTPGraphQLRequest` を呼ぶ薄い関数で載せます。fetch ネイティブな GraphQL Yoga のほうが手間はかかりません。

```ts
import { ApolloServer, HeaderMap } from '@apollo/server';

const apollo = new ApolloServer<{ userId?: string }>({ typeDefs, resolvers });
await apollo.start();

async function apolloFetch(request: Request): Promise<Response> {
  const headers = new HeaderMap();
  request.headers.forEach((value, key) => headers.set(key, value));
  const result = await apollo.executeHTTPGraphQLRequest({
    httpGraphQLRequest: {
      method: request.method,
      headers,
      search: new URL(request.url).search,
      body: request.method === 'POST' ? await request.json().catch(() => undefined) : undefined,
    },
    context: async () => ({ userId: await authenticate(request) }),
  });
  const responseHeaders = new Headers([...result.headers]);
  if (result.body.kind === 'complete') {
    return new Response(result.body.string, { status: result.status ?? 200, headers: responseHeaders });
  }
  // @defer / @stream（incremental delivery）
  const chunks = result.body.asyncIterator;
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
  }), { status: result.status ?? 200, headers: responseHeaders });
}

app.listen({ port: 3000, routes: { '/graphql': { GET: apolloFetch, POST: apolloFetch } } });
// app.close() の後に apollo.stop()
```

## tRPC

tRPC の fetch アダプタ（`@trpc/server/adapters/fetch`）をワイルドカードのネイティブルートに載せます。専用のアダプタは不要です。`onRequest` フックは他のネイティブルートと同じく先に動きます。

```ts
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

app.listen({
  port: 3000,
  routes: {
    '/trpc/*': (request: Request) => fetchRequestHandler({
      endpoint: '/trpc',
      req: request,
      router: appRouter,
      createContext: async () => ({ users: app.get(UserService), userId: await authenticate(request) }),
    }),
  },
});
```

バッチ呼び出し（`/trpc/a,b?batch=1`）もそのまま動きます。GraphQL と同じく、ガードやミドルウェアはかからないので、認証は `createContext` か `onRequest` フックで行ってください。

## 未処理の例外

フィルタで処理されなかった例外は、クライアントには `500 { message: 'Internal Server Error' }` だけを返し（原因やスタックは返しません）、サーバ側では `console.error('[kivin] Unhandled error', error)` に 1 回出力します。

- `HttpError` やフィルタが応答を返した例外は出力しません
- `@kivinjs/logger` の `RequestLoggerMiddleware` が `request.error` として記録した例外は二重に出しません
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

シグナルで停止するときは、`app.close()` の前に `onShutdownStart(signal)` を呼び、`shutdownDelayMs`（既定 0）の間はリクエストを受け付け続けます。`onShutdownStart` が失敗してもログに出して停止を続けます。どちらも `shutdownSignals` が必須です。待機中に同じシグナルをもう一度受けると、kivin は処理せず OS の既定動作で即座に終了します。

`shutdownSignals` は既定で無効です。テストや別のホストに組み込む場合に、プロセスの終了を kivin が勝手に握らないようにするためです。

## テスト

```ts
import { createTestingApp } from '@kivinjs/core';

const app = createTestingApp(appDefinition, {
  manifest,                                              // 省略するとデコレータのメタデータから組み立てる
  overrides: [{ provide: UserRepository, useValue: fakeRepository }],
});

const response = await app.request('/users', { method: 'POST', json: { name: 'Ada' } });
expect(response.status).toBe(201);
app.get(UserRepository); // DI から直接取り出す
```

ポートを開かずにアプリを呼び出せます。生成クライアントに `fetch: app.fetch` を渡せば、型付きでテストを書くこともできます。
