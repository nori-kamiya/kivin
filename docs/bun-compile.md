# Bun Compile

## Constraints

Bun single binary で安定させるため、次を避けます。

- runtime glob scan
- dynamic import path
- reflection metadata 依存の自動 DI
- 起動時の module discovery

## Supported flow

```bash
bun add -d @kivin/cli                              # 初回のみ
bunx --package @kivin/cli kivin generate --entry app.ts --outDir .kivin/generated
bun build main.ts --compile --outfile server       # app.ts と同名にしない
./server
```

`main.ts` は生成した `manifest.ts` を静的に import して `createApp(...).listen(...)` するファイルです（[README](../README.md#quick-start)）。`--outfile` を `app` にすると、`./app` が `app.ts` より先に解決されて import が壊れるので避けます。リポジトリ内の完全な例は `examples/basic` です（`bun run example:build`）。

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
