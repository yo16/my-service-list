# my-service-list

作ったウェブサービスのマスタ管理と状態管理。通し番号、開発段階、技術タグ、公開日、死活状況を 1 つの表で見る。

- マスタは Supabase の `services` テーブルに置く。追加と編集は、自分の PC で動かす登録画面（`node scripts/admin.mjs`）で行う。
- GitHub Actions の同期ジョブが毎時、GitHub API（リポジトリの URL、Topics、使用言語、Release、最終 push）と UptimeRobot API v3（死活、24 時間の稼働率）を取り、結合した JSON をパスフレーズで暗号化して GitHub Pages に配置する。
- 一覧ページ（https://yo16.github.io/my-service-list/）はパスフレーズを入力すると復号して表を出す。ログインの仕組みは持たない。

設計の詳細は [docs/design.md](docs/design.md) にある。

## ファイル構成

| パス | 内容 |
|---|---|
| `docs/design.md` | 設計書 |
| `supabase/schema.sql` | `services` テーブルの定義。Supabase の SQL Editor で実行する |
| `scripts/build.mjs` | 同期スクリプト。Node 22 以上、依存ライブラリなし |
| `scripts/lib/tags.mjs` | 技術タグの決め方（GitHub の Topics と使用言語の結合） |
| `scripts/admin.mjs` | ローカルの登録画面のサーバー。Node 22 以上、依存ライブラリなし |
| `admin/index.html` | 登録画面の HTML。`scripts/admin.mjs` が配信する。Pages には配置されない |
| `.env.example` | 登録画面が読む `.env` の見本 |
| `.github/workflows/sync.yml` | 同期ジョブ（毎時、手動、push 時）と GitHub Pages への配置 |
| `site/` | 一覧ページの HTML、CSS、JS。フレームワークとビルドなし |
| `site/sample/data.json` | 架空のサンプルデータ。ローカルで表示を確かめるときに使う（配置はされない） |

## 初回セットアップ

1. **Supabase**: プロジェクトを作り、SQL Editor で `supabase/schema.sql` を実行する。続けて次の 2 つの値を控える。
   - **URL**: 画面上部の「Connect」ボタンで開くダイアログに出る。`https://<プロジェクトの参照 ID>.supabase.co` の形。
   - **secret key**: 左下の歯車 Settings → API Keys →「Publishable and secret API keys」タブにある、`sb_secret_` で始まる鍵。「Create new API keys」ボタンしか出ていなければ、押して作る。
2. **UptimeRobot**: Integrations → API で読み取り専用（read-only）の API キーを作る。
3. **GitHub の PAT**: Settings → Developer settings → Fine-grained tokens で、一覧に載せるリポジトリを選び、Metadata と Contents を Read にしたトークンを作る。公開リポジトリだけなら省略できる。
4. **Secrets**: このリポジトリの Settings → Secrets and variables → Actions に次を登録する。

   | 名前 | 値 |
   |---|---|
   | `SUPABASE_URL` | Supabase プロジェクトの URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | 手順 1 で控えた secret key（`sb_secret_` で始まる値） |
   | `UPTIMEROBOT_API_KEY` | UptimeRobot の読み取り専用キー（任意。なければ全件「未監視」） |
   | `GH_READ_TOKEN` | 手順 3 のトークン（任意） |
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
- 公開中のサービスは、UptimeRobot に同じ URL の監視を足すと死活が表に出る。URL で自動的に照合される。照合できないときは、編集画面の「任意の項目」にある UptimeRobot の monitor ID を入れる。

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
