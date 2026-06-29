# OpenAPI Flow

## Source of truth

OpenAPI の source of truth は decorator metadata と schema object の組み合わせです。

- route: `@Get`, `@Post`
- docs: `@Summary`, `@Description`, `@OperationId`, `@Tag`, `@ApiResponse`
- security: `@Security`, `defineApplication({ openApi: { securitySchemes } })`
- validation: `@UseBodySchema`, `@UseQuerySchema`, `@UseParamSchema`

## Build steps

1. CLI が app entry を AST 解析して module graph をたどる
2. controller decorators から route manifest を TypeScript として生成
3. generated manifest を import する
4. schemaAdapter で schema を OpenAPI 3.1 JSON に変換
5. `openapi.json` を出力

## Runtime steps

実行時は metadata の探索をしません。generated manifest の配列を読むだけです。

## Example security metadata

```ts
@Post('/')
@OperationId('users.create')
@Security('apiKeyAuth')
@ApiResponse(201, UserSchema, 'Created user')
create() {
  // ...
}
```

```ts
defineApplication({
  modules: [UsersModule],
  schemaAdapter: createValibotAdapter(),
  openApi: {
    securitySchemes: {
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    },
  },
})
```

## Example

```ts
@Controller('/users')
@Tag('Users')
export class UserController {
  @Get('/:id')
  @Summary('Find user by id')
  @UseParamSchema(v.object({ id: v.string() }))
  @Response(200, UserSchema, 'User detail')
  findById(@PathParam('id') id: string) {
    return { id, name: 'Ada' };
  }
}
```
