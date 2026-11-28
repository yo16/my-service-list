# my-service-list

作ったウェブサービスのマスタ管理と状態管理。通し番号、開発段階、インフラ（配信先、DB、外部サービスなど）、技術タグ、公開日、死活状況を 1 つの表で見る。

- マスタは Supabase の `services` テーブルに置く。追加と編集は、自分の PC で動かす登録画面（`node scripts/admin.mjs`）で行う。
- GitHub Actions の同期ジョブが毎時、GitHub API（リポジトリの URL、Topics、使用言語、Release、最終 push）と UptimeRobot API v3（死活、24 時間の稼働率）を取り、結合した JSON をパスフレーズで暗号化して GitHub Pages に配置する。
- 一覧ページ（https://yo16.github.io/my-service-list/）はパスフレーズを入力すると復号して表を出す。ログインの仕組みは持たない。

設計の詳細は [docs/design.md](docs/design.md) にある。

## ファイル構成

| パス | 内容 |
|---|---|
| `docs/design.md` | 設計書 |
| `supabase/schema.sql` | `services` テーブルと、区分、費用と収益、キーの表の定義。Supabase の SQL Editor で実行する。何度実行しても同じ結果になる |
| `scripts/build.mjs` | 同期スクリプト。Node 22 以上、依存ライブラリなし |
| `scripts/lib/tags.mjs` | 技術タグの決め方（GitHub の Topics と使用言語の結合） |
| `scripts/lib/infra.mjs` | インフラの判定（サイトの応答ヘッダーとリポジトリのファイルからインフラを推定） |
| `scripts/admin.mjs` | ローカルの登録画面のサーバー。Node 22 以上、依存ライブラリなし |
| `admin/index.html` | 登録画面の HTML。`scripts/admin.mjs` が配信する。Pages には配置されない |
| `scripts/import-metrics.mjs` | 費用、収益、キーの本数と期限の取り込み。JSON を検証して Supabase に入れる。Node 22 以上、依存ライブラリなし |
| `scripts/lib/metrics.mjs` | 取り込む JSON の検証と、取得元ごとの費用の重ね方。テストは `scripts/lib/metrics.test.mjs`（`npm test`） |
| `scripts/lib/metrics-store.mjs` | 費用、収益、キーを Supabase に書く手順。取り込みと登録画面で共有する |
| `scripts/check-variants.mjs` | 表記ゆれの点検。`npm run check:variants` で動かす。Node 22 以上、依存ライブラリなし |
| `scripts/maintain-from-readme.mjs` | README からの登録情報のメンテナンス。`npm run maintain:readme` で動かす。Node 22 以上、依存ライブラリなし |
| `scripts/lib/readme.mjs` | README から説明、技術タグ、インフラ、URL の候補を読む規則。テストは `scripts/lib/readme.test.mjs`（`npm test`） |
| `scripts/sync-github-issues.mjs` | Claude Code のセッション開始時に、GitHub の open な Issue を beads に登録する |
| `package.json` | npm から動かすスクリプトの定義だけを持つ。依存ライブラリはない |
| `.env.example` | 登録画面が読む `.env` の見本 |
| `.github/workflows/sync.yml` | 同期ジョブ（毎時、手動、push 時）と GitHub Pages への配置 |
| `site/` | 一覧ページの HTML、CSS、JS。フレームワークとビルドなし |
| `site/sample/data.json` | 架空のサンプルデータ。ローカルで表示を確かめるときに使う（配置はされない） |
| `.claude/agents/` | Claude Code のサブエージェント（`web-designer`、`frontend-engineer`）の定義 |

## 初回セットアップ

1. **Supabase**: プロジェクトを作り、SQL Editor で `supabase/schema.sql` を実行する。続けて次の 2 つの値を控える。
   - **URL**: 画面上部の「Connect」ボタンで開くダイアログに出る。`https://<プロジェクトの参照 ID>.supabase.co` の形。
   - **secret key**: 左下の歯車 Settings → API Keys →「Publishable and secret API keys」タブにある、`sb_secret_` で始まる鍵。「Create new API keys」ボタンしか出ていなければ、押して作る。
2. **UptimeRobot**: Integrations → API で読み取り専用（read-only）の API キーを作る。
3. **GitHub の PAT**: 非公開リポジトリを一覧に載せるなら、「[非公開リポジトリを同期ジョブで読めるようにする](#非公開リポジトリを同期ジョブで読めるようにする)」の手順でトークンを作る。公開リポジトリだけなら省略できる。
4. **Secrets**: このリポジトリの Settings → Secrets and variables → Actions に次を登録する。

   | 名前 | 値 |
   |---|---|
   | `SUPABASE_URL` | Supabase プロジェクトの URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | 手順 1 で控えた secret key（`sb_secret_` で始まる値） |
   | `UPTIMEROBOT_API_KEY` | UptimeRobot の読み取り専用キー（任意。なければ全件「未監視」） |
   | `GH_READ_TOKEN_1` など | 手順 3 のトークン。持ち主ごとに 1 つ（任意） |
   | `SITE_PASSPHRASE` | 一覧ページを開くパスフレーズ。推測されにくい 20 文字以上にする |

5. **Pages**: Settings → Pages で Source を「GitHub Actions」にする。
6. Actions の `sync` を「Run workflow」で手動実行し、一覧ページを開いてパスフレーズで復号できることを確かめる。

Secrets を登録するまで、同期ジョブは失敗にならず何もせずに終わる。

## サービスを登録する

登録は、自分の PC で動かす登録画面から行う。Supabase の画面を直接さわる必要はない。

### 初回だけ: `.env` を用意する

登録画面は、Supabase に接続するための URL と鍵を、リポジトリ直下の `.env` というファイルから読む。

1. リポジトリ直下に `.env` という名前のファイルを作る。すでにあれば、そのファイルを開く。
2. 次の 2 行を追記する。値は「初回セットアップ」の手順 1 で控えたものと同じ。

   ```
   SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxxxxxxx
   ```

3. 保存する。`.env` は `.gitignore` に入っているのでコミットされない。見本は `.env.example` にある。

### 1 件登録する

登録するリポジトリが非公開なら、先に「[非公開リポジトリを同期ジョブで読めるようにする](#非公開リポジトリを同期ジョブで読めるようにする)」の手順で、同期ジョブがそのリポジトリを読めるようにする。登録画面は自分の gh のログインで読むので、読めるようにしていなくても情報が表示される点に注意する。

1. リポジトリのフォルダで次を実行する。ブラウザで `http://127.0.0.1:8787/` が開く。開かなければ、この URL を自分で開く。

   ```
   node scripts/admin.mjs
   ```

2. サービス名を入れる。
3. 段階を選ぶ。企画、開発中、公開中、休止、終了のどれか。
4. GitHub リポジトリを `owner/repo` の形で入れる。文字を打つと自分のリポジトリの候補が出る。入れると、そのリポジトリから取れる説明、Website、技術がその場に表示される。技術タグは入力しない。GitHub の Topics と使用言語から、同期のときに決まる。
5. 「登録する」を押す。登録済みの一覧に通し番号つきで並ぶ。
6. 「一覧ページに反映する」を押す。同期ジョブが動き、1〜2 分で一覧ページに出る。押さなくても、次の定時同期（最長 1 時間）で出る。
7. 終わったら、コマンドを実行した画面で Ctrl+C を押して止める。

### 登録したあとに

- 段階を変えるときや項目を直すときは、登録画面の一覧で「編集」を押し、直して「更新する」を押す。
- GitHub 側で About の Website にサービスの URL を入れると、一覧のリンクと UptimeRobot の照合に使われる。Topics に枠組みやサービス名（例: nextjs、supabase）を入れると技術タグに加わる。
- インフラは同期のときに自動で判定する。GCE、VPS、レンタルサーバー、Cloud SQL など判定できないものは、編集画面の「任意の項目」にある「インフラの追加分」にカンマ区切りで入れる。判定の結果に足される。判定が間違っているときは、-Cloudflare のように頭に - を付けると除ける。
- 公開中のサービスは、UptimeRobot に同じ URL の監視を足すと死活が表に出る。URL で自動的に照合される。照合できないときは、編集画面の「任意の項目」にある UptimeRobot の monitor ID を入れる。

## 非公開リポジトリを同期ジョブで読めるようにする

同期ジョブは、非公開リポジトリを fine-grained PAT（読み取り専用のトークン）で読む。1 本のトークンで読めるのは 1 つの持ち主（個人か 1 つの組織）のリポジトリだけなので、持ち主ごとにトークンを作り、`GH_READ_TOKEN_1`〜`GH_READ_TOKEN_9` のうち空いている番号の Secret に、`持ち主=トークン` の形で登録する（例: `my-org=github_pat_xxxx`）。持ち主に合うトークンがないリポジトリは `GH_READ_TOKEN` で読む。

その持ち主のトークンがまだないときは、次の手順で作る。

1. https://github.com/settings/personal-access-tokens/new を開く。
2. Token name に `my-service-list <持ち主>` と入れる。
3. Resource owner で持ち主を選ぶ。
4. Expiration で「No expiration」を選ぶ。
5. Repository access で「Only select repositories」を選び、一覧に載せるリポジトリをすべて選ぶ。
6. Permissions の「Add permissions」で Contents を足し、「Read-only」にする。Metadata の Read-only は自動で付く。
7. 「Generate token」を押し、出てきたトークンをコピーする。持ち主が組織で、承認待ち（pending）と出たときは、その組織の Settings → Personal access tokens → Pending requests で承認する。
8. https://github.com/yo16/my-service-list/settings/secrets/actions/new を開く。
9. Name に、`GH_READ_TOKEN_1`〜`GH_READ_TOKEN_9` のうち空いている番号の名前を入れる。登録済みの番号は https://github.com/yo16/my-service-list/settings/secrets/actions で分かる。
10. Secret に `持ち主=` と入れ、続けてトークンを貼り、「Add secret」を押す。

その持ち主のトークンがすでにあり、リポジトリを足すだけのときは、次の手順で行う。

1. https://github.com/settings/personal-access-tokens を開き、その持ち主のトークンの名前を押す。
2. 「Edit」を押す。
3. Repository access で、足すリポジトリを選ぶ。
4. 「Update」を押す。

## 費用と収益を登録画面から入れる

月の費用と収益、サービスに分けられない共通の費用は、登録画面から入れたり直したりできる。誤った値（負の数、小数、内訳の合計の不一致）があれば、何も保存せずに、どの欄が誤りかを出す。

1. リポジトリのフォルダで次を実行する。ブラウザで登録画面が開く。

   ```
   node scripts/admin.mjs
   ```

2. 画面の下の「費用と収益」で、月を選ぶ。その月に入っている金額が出る。
3. サービスの「手入力」の行に、費用と収益を円の整数で入れる。内訳を入れるときは、「ドメイン:150、クラウド:1200」の形で書き、合計を費用と同じにする。
4. 共通の費用を入れるときは、「共通の費用の行を足す」を押し、請求元、請求の単位、費用を入れる。
5. 「保存する」を押す。
6. 「一覧ページに反映する」を押す。

入っている金額を消すと、0 円として保存される。「手入力」以外の行は、JSON の取り込みで入った金額である。この画面でも直せるが、次に同じ取得元を取り込むと置き換わる。

## 費用、収益、キーの本数と期限を取り込む

サービスごとの月の費用と収益、サービスに分けられない共通の費用、API キーの本数といちばん近い期限を、1 か月分の JSON ファイルから Supabase に入れる。`.env` は登録画面と同じものを使う。JSON の形は [docs/design.md](docs/design.md) の 3.6 にある。このリポジトリは公開なので、本物の金額を書いた JSON ファイルはリポジトリの外に置く。

誤りがあれば、何も書き込まずにエラーで止まる。同じ月を何度取り込んでも、同じ行を上書きするだけになる。

費用は取得元（JSON の `source`）ごとに持つ。`source` を変えれば、同じサービスの同じ月を別々のファイルで取り込めて、月の費用はその合計になる。同じ `source` をもう一度取り込むと、その取得元の分だけが置き換わる。月が締まる前の金額は、JSON に `"provisional": true` を書くと、一覧に「暫定」と出る。

1. その月の JSON ファイルを、リポジトリの外に作る。
2. リポジトリのフォルダで次を実行し、検証だけを行う（書き込まない）。`<ファイル>` は 1 で作ったファイルの場所に置き換える。

   ```
   node scripts/import-metrics.mjs <ファイル> --dry-run
   ```

3. 「検証を通りました」と出たら、`--dry-run` を外して実行する。

   ```
   node scripts/import-metrics.mjs <ファイル>
   ```

4. 登録画面の「一覧ページに反映する」を押す。

## 表記ゆれを点検する

登録済みのサービス名、インフラの追加分、技術タグの追加分から、表記ゆれの可能性がある組を一覧にする。「フォームメーラー」と「フォームメイラー」、「GCP Cloud Run」と「Cloud Run」のような組が出る。Supabase は読むだけで、書き換えない。`.env` は登録画面と同じものを使う。

1. リポジトリのフォルダで次を実行する。

   ```
   npm run check:variants
   ```

2. 出てきた組ごとに、別のものか、同じものの書き分けかを確かめる。「← そろえる表記」と出ている表記は、同期のときの自動判定が使う書き方か、そろえる先として決めた書き方である。
3. 同じものなら、登録画面の「編集」で「← そろえる表記」の書き方にそろえる。
4. そろえる先を新しく決めたら、自動判定の表記は `scripts/lib/infra.mjs` で、それ以外は `scripts/check-variants.mjs` の `PREFERRED_TERMS` に足す。

## README から登録情報を足す

登録済みのサービスの GitHub リポジトリの README を読み、登録に無い技術タグ、インフラ、説明、URL を足す。足すだけで、すでにある値は消さない。`.env` は登録画面と同じものを使う。

読むのは、README の冒頭と、見出しに「技術」「構成」「スタック」「インフラ」などを含む節だけである。名前が出てくることしか分からないので、使っていないものが候補に混ざることがある。そのため、最初は書き込まずに候補だけを出す。

1. リポジトリのフォルダで次を実行する。サービスごとに、足す候補が出る。

   ```
   npm run maintain:readme
   ```

2. 候補を確かめ、書き込んでよいサービスの通し番号を控える。
3. 控えた通し番号をカンマ区切りで `--id` に渡し、`--apply` を付けて実行する。次の例は 3 番と 5 番だけを書き込む。

   ```
   npm run maintain:readme -- --id 3,5 --apply
   ```

4. 登録画面の「一覧ページに反映する」を押す。

候補のうち一部だけが誤りのサービスは、書き込んだあとに登録画面の「編集」で直す。すでにある説明を README の冒頭の文に置き換えたいときは、`--rewrite-description` を足す。

## ローカルで確かめる

表示だけを見るなら、`site/` を静的サーバーで配信する。`data.enc.json` がないのでサンプルデータが出る。

```
python -m http.server 8765 --directory site
```

暗号化と復号まで通すなら、サンプルデータを暗号化して `dist/` を配信する。

```
SITE_PASSPHRASE=任意の文字列 node scripts/build.mjs --sample
python -m http.server 8766 --directory dist
```

実際の Supabase を使って手元で動かすときは、Secrets と同じ名前の環境変数を設定して `node scripts/build.mjs` を実行する。`--plain` を付けると暗号化前の `dist/data.json` も書く。`dist/` は `.gitignore` に入っている。

## 注意

- 公開リポジトリなので、サービス名や URL を含むデータはコミットしない。マスタは Supabase にだけ置き、配置されるのは暗号化済みのファイルだけ。
- 暗号化済みファイルは誰でも取得できるため、安全性はパスフレーズの長さに依存する。
- GitHub は、リポジトリに 60 日間 push がないと schedule の実行を止める。止まったら Actions の画面で有効にし直す。
- 登録画面は自分の PC の中（127.0.0.1）だけで待ち受ける。Supabase の鍵は `.env` にだけ置き、ブラウザには渡さない。
- Supabase の鍵は、旧形式の `service_role` キー（Settings → API Keys の「Legacy API keys」タブ）でも動くが、旧形式は 2026 年末に廃止予定なので secret key を使う。
