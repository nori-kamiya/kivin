# Bun Compile

## Constraints

Bun single binary で安定させるため、次を避けます。

- runtime glob scan
- dynamic import path
- reflection metadata 依存の自動 DI
- 起動時の module discovery

## Supported flow

```bash
bun run generate
bun build examples/basic/src/main.ts --compile --outfile examples/basic/bin/basic-app
PORT=3100 ./examples/basic/bin/basic-app
```

## Why it works

- generated manifest は静的 import される
- route collection は AST generator が事前に済ませる
- OpenAPI JSON は build artifact なので runtime 生成不要
- 依存解決は起動時に固定される

## Smoke check

build 成功だけでは不十分です。compiled binary を実際に起動して、少なくとも route endpoint と `/openapi.json` を確認します。

```bash
bun run example:smoke
```

## Next step

tsconfig path alias 解決や import alias 衝突回避を強化すると、より大きい実アプリに適用しやすくなります。
