# Runtime Pipeline

## Request flow

1. Router が route を解決
2. `RequestContext` を作成
3. path / query / body を schema validate
4. global guards + route guards を順に評価
5. global middleware + route middleware をチェイン実行
6. controller method を呼ぶ
7. success response schema があれば validate
8. route filters と global filters で例外を処理

## Context

`RequestContext` は次を提供します。

- `req.raw`
- `req.param(name)`
- `req.query(name)`
- `json()`
- `text()`
- `inject()`
- `set()` / `get()`

middleware から request scoped な値を載せる用途を想定しています。

## Guards

```ts
export class ApiKeyGuard {
  canActivate(context: RequestContext) {
    return context.req.raw.headers.get('x-api-key') === 'secret';
  }
}
```

false を返すと 403 を返します。

## Middleware

NestJS っぽい `handle()` と Hono っぽい `use()` の両方を受けます。

```ts
export class RequestIdMiddleware {
  async handle(context: RequestContext, next: () => Promise<Response>) {
    const requestId = crypto.randomUUID();
    context.set('requestId', requestId);
    const response = await next();
    response.headers.set('x-request-id', requestId);
    return response;
  }
}
```

## Filters

```ts
export class UserNotFoundFilter {
  catch(error: unknown, context: RequestContext) {
    if (!(error instanceof UserNotFoundError)) {
      return undefined;
    }

    return context.json({ message: error.message }, { status: 404 });
  }
}
```

`undefined` を返すと次の filter に処理が渡ります。
