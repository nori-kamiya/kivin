# リリース手順書

16 個の `@kivin/*` パッケージを、同じバージョンで npm に公開する手順です。ここに書いた順に、オーナー本人が行います。コードと CI は用意済みなので、オーナーにしかできない作業（npm と GitHub の設定、トークン、承認）だけを書いています。

## 全体像

```
タグ vX.Y.Z を push
  └─ build ジョブ（権限は contents: read のみ）
       release:check → release:pack → release:verify --tag → .release を artifact に保存
  └─ publish ジョブ（environment: npm、必須レビュアーの承認待ち、id-token: write）
       artifact の sha512 を manifest.json と照合 → 依存順に npm publish --provenance
```

- パックは `bun pm pack`、公開は `npm publish <tgz> --provenance --access public`。`npm pack` は `workspace:` を書き換えないのでインストールできない tarball になり、`bun publish` は provenance を付けられないためです
- tarball の公開ではライフサイクルスクリプトが走らないので、`release:pack` が先に `bun run build` を実行します
- publish ジョブは checkout も `bun install` もしません。実行するのは artifact に入れた自己完結の `publish.mts`（Node 組み込みだけを import）だけで、OIDC トークンを持つジョブにリポジトリ由来の依存コードを持ち込まないためです
- 公開先は最初から `latest` です。`next` から昇格する手順は置いていません。パッケージ同士の依存は peer の範囲指定なので、途中まで公開された状態でも壊れにくく、再実行すれば残りが公開されます

## 手順

### 1. npm の名前を確認する（最初にやる）

npm 上に `kivin` という名前のユーザーまたは組織が存在しますが、所有者がわかっていません。`@kivin/*` というスコープは、その名前のユーザーか組織のものなので、**自分が `@kivin` スコープを取れるか**を先に確かめます。

1. `https://www.npmjs.com/~kivin` と `https://www.npmjs.com/org/kivin` を開く。どちらかが存在すれば、その所有者が `@kivin` を持っている
2. 存在しない、または自分のものなら、npm の組織 `kivin` を作る（Free プランで public パッケージは公開できる）
3. 他人のものなら、次のどれかを選ぶ（番号の若い順に検討する）
   - 所有者に連絡して譲ってもらう（npm サポートに名前の問い合わせもできる）
   - 別のスコープに変える。候補: `@kivin-js`、`@kivinjs`、自分のユーザースコープ `@nori-kamiya`（これは必ず取れる）。候補ごとに同じ確認をする
   - スコープなしの名前にはしない。16 個のパッケージを同じ接頭辞でまとめて管理する前提が崩れる

スコープを変える場合は、このリリース作業の前に別 PR で全パッケージの `name`、`@kivin/*` を参照している import と依存、`tsconfig.base.json` の `paths`、`scripts/release/lib.ts` の `SCOPE`、docs を一括で置き換え、`bun run release:check` と `bun run pack:smoke` が通ることを確認します。決めるまで先に進みません。

`npm view @kivin/core` が 404 になることも確認します（すでに誰かが同名を公開していないこと）。

### 2. npm アカウントの準備

- 公開に使うアカウントで 2FA を有効にする
- 組織（またはユーザースコープ）に、公開権限のある自分のアカウントがあることを確認する

### 3. GitHub の environment `npm` を作る

リポジトリの Settings → Environments → New environment で `npm` を作ります。

- Required reviewers: 自分を追加する。承認前に build ジョブの `release:verify` の結果と artifact の中身を確認する
- Deployment branches and tags: 「Selected branches and tags」にして、タグ `v*` だけを許可する
- **この設定とタグ ruleset（手順 4）が、任意のコミットへのタグを止める本当の関門です。** `release:verify --tag` の祖先チェックは、タグが指すコミット自身の `scripts/` と `release.yml` から実行されるため、`main` に入っていないコミットのタグでは書き換えられてしまいます。最初のリリースの前に、この 2 つを必ず有効にしてください
- Environment secrets は次の手順 5 で登録する（初回だけ）

### 4. タグの ruleset を作る

Settings → Rules → Rulesets → New ruleset → New tag ruleset。

- Target tags: `v*`
- Restrict creations（作成できる人を限る）、Restrict updates、Restrict deletions を有効にする
- Bypass list はリポジトリのオーナーだけにする
- 手順 3 の environment とあわせて、これが `main` 以外のコミットから公開されるのを防ぐ唯一の仕組みです（`release:verify --tag` の祖先チェックはタグ側のコードで動くため、保証になりません）

あわせて、`main` のブランチ保護に必須ステータスチェックが残っていることを確認します。必須なのは `Typecheck, test, smoke` と `Performance regression vs base` で、`ci.yml` でもこの名前を変えていません。

### 5. 初回だけ使う bootstrap トークンを作る

信頼された公開（trusted publishing）は、パッケージが npm に存在してからでないと設定できません。そのため、最初の 1 回は短命のトークンで公開します。

1. npm の Access Tokens で Granular Access Token を作る
   - Permissions: Read and write
   - Packages and scopes: 手順 1 で決めたスコープ
   - Expiration: 7 日
   - CI から公開するので、2FA のバイパスを許可する設定が必要
2. GitHub の environment `npm` の secret に `NPM_BOOTSTRAP_TOKEN` として登録する（リポジトリの secret ではなく **environment** の secret）

### 6. リリース前の確認

1. 全 16 パッケージの `version` が同じで、公開したいバージョンになっている（バージョンを上げる作業は別。`release:verify --tag` が不一致を検出する）
2. `CHANGELOG.md` の `## [X.Y.Z] - Unreleased` を `## [X.Y.Z] - 公開日` に書き換えて、main へマージしておく（`release:verify --tag` は見出しの有無だけを検査する）
3. 各パッケージに `README.md` がある。`files` に `README.md` を含めているので、無いと `release:verify` が失敗する
4. ローカルで通す: `bun install --frozen-lockfile && bun run release:check && bun run release:pack && bun run release:verify && bun run pack:smoke`
5. 公開したいコミットが `origin/main` に入っている（タグのコミットが `origin/main` の祖先でないと `release:verify --tag` が失敗する。ただしこの検査はタグ側のコードで動く確認用のもので、強制は手順 3・4 の設定が担う）

### 7. タグを打って公開する

```bash
git tag vX.Y.Z <main のコミット>
git push origin vX.Y.Z
```

1. Actions の Release ワークフローで build ジョブが成功するのを待つ
2. publish ジョブが承認待ちになる。承認する前に、タグが指すコミットが `main` の履歴にあることを自分で確認する（`git merge-base --is-ancestor <タグのコミット> origin/main`）。そのうえで build のログの `release verification passed` と artifact の `manifest.json` を確認して承認する。ログの文言だけでは、タグ側のコードが出力したものか区別できない
3. 完了後、`npm view @kivin/core@X.Y.Z dist.integrity` が `.release/manifest.json` の値と一致し、npm のページに provenance が表示されることを確認する（`bun pm pack` の出力は 2 回の実行で同一だったため、ローカルで作った値とも比べられる）

### 8. trusted publishing に切り替え、トークンを消す

初回の公開が済んだら、16 パッケージそれぞれに信頼関係を設定します（npm が対応するバージョンの CLI で、2FA を求められる）。

```bash
for name in core decorators logger openapi valibot standard-schema jwt security http static graphql session schedule config observability cli; do
  npm trust github "@kivin/$name" --file release.yml --repo nori-kamiya/kivin --env npm --allow-publish
done
```

スコープを変えた場合は `@kivin` を読み替えます。16 個すべてを設定したら、次を行います。

1. GitHub の environment `npm` から `NPM_BOOTSTRAP_TOKEN` を削除する
2. npm の Access Tokens で bootstrap トークンを revoke する
3. 次のリリースで publish ジョブがトークンなしの OIDC で成功することを確認する。`release.yml` は secret が空なら `NODE_AUTH_TOKEN` を空にするだけで、変更は不要

### 9. 以降のリリース

手順 6 → 7 だけです。トークンは使いません。

## 途中で失敗したとき

16 個のうち一部だけ公開された状態は、次の手順で直します。**`npm unpublish` は使いません。** 公開済みの名前とバージョンは再利用できず、依存している人を壊すためです。

1. 失敗した publish ジョブのログで、どのパッケージで止まったかを確認する
2. 原因（一時的なネットワーク障害、レジストリの 5xx、レビュアーの承認切れなど）を直す
3. 同じタグで再実行する: `gh workflow run release.yml --ref vX.Y.Z`（入力はありません。ref がタグです）
4. publish スクリプトは `npm view <名前>@<バージョン> dist.integrity` で各パッケージを調べる
   - 一致: 公開済みなので飛ばす
   - 404: 公開する
   - 不一致: **失敗して止まる**。同じバージョンに別の内容がすでにあるということなので、自動では上書きも続行もしない
5. 不一致で止まった、または公開済みの内容に誤りが見つかった場合は、そのバージョンを `npm deprecate` で非推奨にし、パッチバージョンを上げて、全 16 パッケージを新しいバージョンで公開し直す（バージョンは全パッケージで揃える）

再実行できるのは、`release:pack` の出力が決定的だからです（同じコミットから 2 回 pack して manifest.json が一致することを確認済み）。ただし再実行は build からやり直すので、途中で `main` やロックファイルが変わっていても、タグが指すコミットから作り直されます。

## ローカルでの確認

```bash
bun run release:pack
bun run release:verify
bun run pack:smoke
bun scripts/release/publish.ts --dry-run   # 認証なしで npm publish --dry-run を 16 個に対して実行する
```

`publish.ts` は `--dry-run` なしでは GitHub Actions の外で実行を拒否します。
