# kivin — テスト計画 (観点と項目)

作成: 2026-07-02 / 対応タスク: `docs/plans/kivin-prod-npm/tasks.md`
優先度: P0 = リリースブロッカー / P1 = 0.1.0 に含めたい / P2 = 後続でよい
種別: U = unit, I = integration, E = e2e(コンパイル済バイナリ or tarball)

## 現状カバレッジマップ (2026-07-02 実測)

| パッケージ | src | test | 状態 |
|---|---|---|---|
| core | 13 | 2 | ランタイム挙動は厚い(メソッド網羅・405/Allow・filter/middleware 順序・request-scope 分離・バリデーション失敗・201/204 契約) |
| cli | 3 | 1 | 正常系のみ。異常系・決定性なし |
| decorators | 1 | 0 | **ゼロ** |
| logger | 1 | 1 | 最低限あり |
| openapi | 1 | 0 | **単体ゼロ**(example 依存の意味的チェックのみ) |
| valibot | 1 | 0 | **ゼロ** |

横断ギャップ: CI なし / インストール成果物(tarball)の検証なし / graceful shutdown 未実装・未テスト。

---

## 観点 A: パッケージング・配布物 (P0, T2/T3)

- [ ] A1 (E) tarball に `dist/` のみ含まれ、`src/` `tests/` `.kivin/` が漏れていない
- [ ] A2 (E) 一時プロジェクトで `bun install <tarball>` が成功する
- [ ] A3 (E) 5 つの subpath (`kivin`, `kivin/decorators`, `kivin/logger`, `kivin/openapi`, `kivin/valibot`) すべてが import 可能で、`tsc --noEmit` で型が解決する
- [ ] A4 (E) `bunx kivin generate --entry ...` がインストール先から動く(bin 解決)
- [ ] A5 (E) valibot を install していないプロジェクトで `kivin`(core のみ)が import・動作する(optional peer の検証)
- [ ] A6 (U) `bunx publint` エラー 0 / attw で ESM-only として破綻なし
- [ ] A7 (E) 生成物から `bun build --compile` した単一バイナリが起動し応答する

## 観点 B: ランタイム core — 既存担保の維持 (P0, T1 のリグレッション柵)

既存テストが T1 の統合後もすべてグリーンであること自体が検証項目。特に:

- [ ] B1 (U) GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS の全メソッド + 405/`Allow`
- [ ] B2 (U) バリデーション失敗 → 400 のレスポンス形状
- [ ] B3 (U) guard/middleware/filter の実行順序・short-circuit・多層ネスト
- [ ] B4 (U) request-scoped provider の per-request 再利用と cross-request 分離
- [ ] B5 (U) HttpError ヘルパー群(conflict/not-found/rate-limit/precondition/not-modified/service-unavailable)の契約
- [ ] B6 (U) 201 Created + queued headers / 204 No Content 契約
- [ ] B7 (U) 不正 JSON の遅延パース(middleware が先に short-circuit できる)

## 観点 C: graceful shutdown (P0, T9)

- [ ] C1 (I) `shutdown()` 呼び出しで新規接続を受け付けない
- [ ] C2 (I) in-flight リクエストは完了してから終了する(遅延ハンドラ中に SIGTERM → 200 を受領)
- [ ] C3 (I) SIGTERM/SIGINT ハンドラ有効時に exit code 0
- [ ] C4 (U) シグナルハンドラは opt-in であり、未使用時に既存挙動が変わらない

## 観点 D: decorators (P1, T4)

- [ ] D1 (U) Get/Head/Post/Put/Patch/Delete/Options がそれぞれ正しい method + path メタデータを登録する
- [ ] D2 (U) `Controller(basePath)` の basePath 正規化(先頭/末尾スラッシュ、ネスト時の結合)
- [ ] D3 (U) UseGuards/UseMiddleware/UseFilters がクラス/メソッド両レベルで積まれ、順序が保存される
- [ ] D4 (U) Tag/Summary/Description/OperationId/Security/Response(=ApiResponse) が OpenAPI メタデータへ届く形で登録される
- [ ] D5 (U) `Injectable({deps})` の依存トークン登録
- [ ] D6 (U) `Module({...})` の imports/controllers/providers 登録内容

## 観点 E: valibot アダプタ (P1, T5)

- [ ] E1 (U) parse 成功 → `ParseSuccess`(変換後の値を返す。coercion/transform が反映される)
- [ ] E2 (U) parse 失敗 → `ParseFailure`(issue のパス・メッセージが失われない)
- [ ] E3 (U) ネスト object / optional / union / array スキーマの成功・失敗
- [ ] E4 (U) JSON Schema 変換が OpenAPI 3.1 として妥当な形になる(型・required・nested)
- [ ] E5 (U) 変換不能スキーマ(function など)を渡したときの挙動が定義済み(明示エラー or 明示フォールバック)

## 観点 F: OpenAPI 生成 (P1, T6)

- [ ] F1 (U) path/method 網羅: manifest のルートが全部 `paths` に現れる
- [ ] F2 (U) path params / query params / requestBody / responses(201/204/4xx 含む)の対応
- [ ] F3 (U) Security / Tag / Summary / OperationId の反映
- [ ] F4 (U) 決定性: 同一入力 → バイト同一の JSON(キー順含む)
- [ ] F5 (U) ルート 0 件・スキーマなしルートなどエッジフィクスチャで落ちない
- [ ] F6 (U) `createDocsHtml` が指定 URL を埋め込んだ HTML を返す

## 観点 G: CLI (P1, T7)

- [ ] G1 (I) 存在しない `--entry` → 非 0 exit + 人間が読めるエラー(スタックトレース垂れ流しでない)
- [ ] G2 (I) app 定義が export されていないファイル → 明示エラー
- [ ] G3 (I) `--outDir` が無ければ作成される
- [ ] G4 (I) generate を 2 回実行して出力がバイト一致(決定性・冪等)
- [ ] G5 (I) `inspect routes` / `inspect modules` がフィクスチャで期待形式を出す
- [ ] G6 (I) `openapi` サブコマンドの出力が generate 経由の openapi.json と一致

## 観点 H: 横断・非機能 (P1〜P2)

- [ ] H1 (E, P0) `bun run release:check` が CI(GitHub Actions)で再現グリーン
- [ ] H2 (I, P1) logger: JSON lines 形状・レベルフィルタ・request logger middleware のフィールド(既存テストの確認+不足分)
- [ ] H3 (E, P2) `perf:check` の不変条件が手動 workflow で確認できる
- [ ] H4 (E, P2) コンパイル済バイナリの起動時間・サイズの記録(ゲート化はしない)
- [ ] H5 (E, P0) example-smoke / pack-smoke は**失敗時に数秒で非 0 exit する**(子プロセス kill 前にストリームを読まない・全体ハードタイムアウトあり)— 2026-07-02 に catch 節デッドロックで 20 分ハングした実績あり (T0)
- [ ] H6 (E, P0) サーバの bind hostname とスモークの接続先が明示的に一致している(`localhost` の IPv6 解決差異に依存しない) (T0)

## テストしないこと(明示)

- Node.js での動作(Bun 専用と README に明言する)
- ベンチマークの対フレームワーク優位性(perf:check の不変条件のみ見る)
- `@kivin/*` スコープパッケージとしての解決(単一パッケージ方針のため)
