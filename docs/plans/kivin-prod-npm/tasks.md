# kivin — プロダクション化 & npm 公開 タスク分解

作成: 2026-07-02 / 対象: v0.0.1 (GitHub 公開済) → v0.1.0 (npm 初公開)
実行者: Sonnet(/implement-tasks 想定)。指示書: `.claude/handoffs/kivin-prod-npm/instructions.md`
テスト観点: `docs/plans/kivin-prod-npm/test-plan.md`

## 決定事項(前提)

- **公開形態: 単一パッケージ `kivin`**(npm 素の名前は 2026-07-02 時点で未使用を確認済)。
  subpath exports: `kivin`(core), `kivin/decorators`, `kivin/logger`, `kivin/openapi`, `kivin/valibot`。CLI bin `kivin` 同梱。
  理由: `@kivin` スコープは取得可否が未確定・公開オーケストレーション最小・`bun install kivin` の UX が最短。
- ESM only / Bun 専用 (core が `Bun.serve` 依存)。engines は `bun >=1.2` を宣言(参考情報として)。
- 初公開バージョンは **0.1.0**。実際の `npm publish` はユーザーの npm ログインが必要なため **T11 でユーザーがゲート**。

## 依存順序

```
T0 → T1 → T2 → T3 ─┬→ T4, T5, T6, T7 (並列可)
              ├→ T8 (CI)
              ├→ T9 (graceful shutdown)
              └→ T10 (README/docs)
T4..T10 全完了 → T11 (リリース, ユーザーゲート)
```

各タスク完了時点でツリーは常にビルド可能・`bun run release:check` グリーンを維持すること。

---

### T0: release:check のスモーク失敗とハングを修正する(ベースライン修復)

- depends on: なし
- files: `scripts/example-smoke.ts`(修正), `examples/basic/src/main.ts`(修正)
- what: 2026-07-02 実測でベースラインの `release:check` は**レッド**(typecheck/99 tests はグリーン、example:smoke で失敗)。原因は 2 つ。
  1. **bind/接続先の不一致**: バイナリは `localhost` で listen(Bun 1.3.14 では IPv6 のみに bind され得る)、smoke は `127.0.0.1` へ fetch → 接続不可でタイムアウト。→ `examples/basic/src/main.ts` の `Bun.serve` に `hostname: "127.0.0.1"`(または HOST env)を明示し、smoke も同一ホストへ接続する。
  2. **エラー経路のデッドロック**: `scripts/example-smoke.ts:99` の catch 節が、生きている子プロセスの stdout を `streamToText` で読み切ろうとして永久待機(kill は finally で catch の後のため到達しない)→ 失敗が 20 分超のハングに化ける。→ ストリームを読む**前に** `processHandle.kill()` する。全体のハードタイムアウト(例: 30s)も付ける。
- verify: `bun run release:check` → exit 0 かつ 60 秒以内に完了。意図的に assert を壊した場合に数秒でエラー終了する(ハングしない)ことも確認
- executor: sonnet

### T1: 6 パッケージを単一パッケージ `kivin` に統合する

- depends on: T0
- files: `packages/kivin/`(新規: package.json, tsconfig.json, src/{core,decorators,logger,openapi,valibot,cli}/), 旧 `packages/{core,cli,decorators,logger,openapi,valibot}`(削除), `examples/basic/src/*.ts`(import 書換), ルート `package.json`/`tsconfig.build.json`(参照更新), `scripts/*.ts`(パス更新)
- what: 各パッケージの `src/` を `packages/kivin/src/<旧名>/` へ移動し、`@kivin/x` 相互 import を相対パスへ書換。tests は `packages/kivin/tests/<旧名>/` へ移動。exports map(`.`/`./decorators`/`./logger`/`./openapi`/`./valibot`)と `bin: {kivin: ./dist/cli/bin.js}` を定義。examples・root scripts・ベンチの import を `kivin`/`kivin/...` に更新。
  ※ 機械的な移動+import 書換のみのため「≤5 files」ルールの例外。**ロジック変更は一切禁止**。
- verify: `bun run release:check` → 全グリーン(generate → typecheck → bun test → compiled smoke)
- executor: sonnet

### T2: publish メタデータと publish ゲートを整備する

- depends on: T1
- files: `packages/kivin/package.json`, `packages/kivin/README.md`(新規・最小), ルート `package.json`(scripts 追加)
- what: `version: 0.1.0`, `description`, `keywords`, `engines: {bun: ">=1.2"}`, `sideEffects: false`, `files: ["dist"]`, `license/repository(directory)/homepage/bugs` を確定。`valibot` と `@valibot/to-json-schema` は **optional peerDependencies**(+ peerDependenciesMeta)へ移し、テスト用に root devDeps 維持。`typescript` は CLI の AST 解析で実行時に必要なため **dependencies に残す**。`prepublishOnly: "bun run release:check && bun run build"` を設定。
- verify: `bunx publint packages/kivin` → エラー 0 / `bunx @arethetypeswrong/cli --pack packages/kivin` → ESM-only 構成として問題なし(node16 CJS 系の警告は Bun 専用のため許容・README に明記)
- executor: sonnet

### T3: tarball インストール E2E スモーク (pack:smoke) を作る

- depends on: T2
- files: `scripts/pack-smoke.ts`(新規), ルート `package.json`(`pack:smoke` 追加・`release:check` に組込み)
- what: ①`npm pack` で tarball 生成 → ②一時 dir に最小アプリ(controller 1 つ + valibot スキーマ 1 つ)を生成 → ③`bun install <tarball>` → ④`bunx kivin generate` → ⑤`bun build --compile` → ⑥バイナリ起動して GET/POST/バリデーション失敗(400)を fetch 確認 → ⑦後片付け。**「公開物がユーザー環境で動く」ことの唯一の証明**なので最優先で早期に置く。
- verify: `bun run pack:smoke` → exit 0、tarball 内容に `src/`/`tests/` が含まれないこと(スクリプト内で assert)
- executor: sonnet

### T4: decorators のユニットテストを追加する

- depends on: T1
- files: `packages/kivin/tests/decorators/decorators.test.ts`(新規)
- what: 現在テスト 0 件。test-plan.md「観点 D」の項目(全 HTTP メソッドデコレータ、Controller basePath、UseGuards/UseMiddleware/UseFilters、OpenAPI 系メタ(Tag/Summary/Response/Security)、Injectable deps)をメタデータ検証で網羅。
- verify: `bun test packages/kivin/tests/decorators` → pass、`bun run release:check` グリーン維持
- executor: sonnet

### T5: valibot アダプタのユニットテストを追加する

- depends on: T1
- files: `packages/kivin/tests/valibot/adapter.test.ts`(新規)
- what: 現在テスト 0 件。test-plan.md「観点 E」: parse 成功/失敗の `ParseResult` 契約、ネスト/optional/union/coercion、JSON Schema 変換(OpenAPI に渡る形)の検証。
- verify: `bun test packages/kivin/tests/valibot` → pass
- executor: sonnet

### T6: openapi 生成のユニットテストを追加する

- depends on: T1
- files: `packages/kivin/tests/openapi/document.test.ts`(新規)
- what: 現在パッケージ単体テスト 0 件(意味的チェックは example 依存)。test-plan.md「観点 F」: buildOpenApiDocument の paths/params/requestBody/responses/security/tags、決定性(同一入力→同一出力)、`createDocsHtml` の最低限検証を example 非依存のフィクスチャで。
- verify: `bun test packages/kivin/tests/openapi` → pass
- executor: sonnet

### T7: CLI の異常系・決定性テストを追加する

- depends on: T1
- files: `packages/kivin/tests/cli/cli.test.ts`(既存 1 件があれば拡張)
- what: test-plan.md「観点 G」: 存在しない entry でのエラーメッセージと非 0 exit、outDir 自動作成、generate 2 回実行の決定性(バイト一致)、inspect routes/modules の出力形式。
- verify: `bun test packages/kivin/tests/cli` → pass
- executor: sonnet

### T8: GitHub Actions CI を追加する

- depends on: T3
- files: `.github/workflows/ci.yml`(新規)
- what: 現在 CI なし。push(main)/PR で `oven-sh/setup-bun` → `bun install --frozen-lockfile` → `bun run release:check` → `bun run pack:smoke`。`perf:check` は共有ランナーでフレーキーなため **workflow_dispatch(手動)のみ** に分離。
- verify: `bunx actionlint .github/workflows/ci.yml` → エラー 0(push 後の初回 run グリーン確認は T11 で)
- executor: sonnet

### T9: graceful shutdown を実装する

- depends on: T1
- files: `packages/kivin/src/core/app.ts`(修正: `listen` 周辺 — 旧 packages/core/src/app.ts:628), `packages/kivin/tests/core/shutdown.test.ts`(新規), `examples/basic/src/main.ts`(利用例)
- what: 現状 SIGTERM/SIGINT ハンドリングなし(grep 済)。`app.listen()` が返す server に対する `shutdown()`(`server.stop(true)` 相当で新規受付停止+in-flight 完了待ち)を追加し、opt-in の `installSignalHandlers` 相当を提供。**API 追加のみで既存挙動は不変**。
- verify: `bun test packages/kivin/tests/core/shutdown.test.ts` → pass(サブプロセス起動→リクエスト中に SIGTERM→in-flight 200 完了+exit 0 を検証)
- executor: sonnet

### T10: README とドキュメントをインストール利用前提に書き直す

- depends on: T3
- files: `README.md`, `docs/reference.md`, `packages/kivin/README.md`, `scripts/quickstart-check.ts`(新規・任意)
- what: Quickstart を「`bun install kivin` → 最小アプリ → `bunx kivin generate` → `bun build --compile` → 起動」の流れに書き換え(モノレポ内開発前提の記述と分離)。subpath exports 一覧、valibot が optional peer である旨、Bun 専用である旨を明記。Quickstart のコマンド列はそのまま pack:smoke の最小アプリと共通化してドリフトを防ぐ。
- verify: `bun run pack:smoke` グリーン(README の手順と同一コード経路であることをレビューで確認)
- executor: sonnet

### T11: リリース実行 (0.1.0)

- depends on: T4–T10 全部
- files: `CHANGELOG.md`, ルート/`packages/kivin` の version, git tag `v0.1.0`
- what: `/release` フローに従う: release:check + pack:smoke 最終実行 → CHANGELOG 追記 → version bump → commit/tag/push → CI グリーン確認 → `npm publish --dry-run` で同梱物確認 → **`npm login` 後に `npm publish`(ここはユーザー実施)** → GitHub Release 作成 → `bun install kivin` を実環境で最終確認。
- verify: `npm view kivin version` → `0.1.0`
- executor: main(+ ユーザー: npm 認証と publish 最終承認)

---

## 意図的にスコープ外 (Later)

- `bun create kivin` スターターテンプレート
- `@kivin/*` スコープ取得・移行、JSR 公開
- ベンチ優位性の追求(PROJECT_STATE「Next decisions」の perf トラック)
- request-scoped provider の適用範囲拡大
- Node.js 対応(core が Bun.serve 前提のため対象外を明言する方針)
