# my-service-list

作ったウェブサービスのマスタ管理と状態管理。通し番号、開発段階、技術タグ、公開日、死活状況を 1 つの表で見る。

- マスタは Supabase の `services` テーブルに置き、Table Editor で編集する。
- GitHub Actions の同期ジョブが毎時、GitHub API（リポジトリの URL、Topics、Release、最終 push）と UptimeRobot API v3（死活、24 時間の稼働率）を取り、結合した JSON をパスフレーズで暗号化して GitHub Pages に配置する。
- 一覧ページ（https://yo16.github.io/my-service-list/）はパスフレーズを入力すると復号して表を出す。ログインの仕組みは持たない。

設計の詳細は [docs/design.md](docs/design.md) にある。

## ファイル構成

| パス | 内容 |
|---|---|
| `docs/design.md` | 設計書 |
| `supabase/schema.sql` | `services` テーブルの定義。Supabase の SQL Editor で実行する |
| `scripts/build.mjs` | 同期スクリプト。Node 22 以上、依存ライブラリなし |
| `.github/workflows/sync.yml` | 同期ジョブ（毎時、手動、push 時）と GitHub Pages への配置 |
| `site/` | 一覧ページの HTML、CSS、JS。フレームワークとビルドなし |
| `site/sample/data.json` | 架空のサンプルデータ。ローカルで表示を確かめるときに使う（配置はされない） |

## 初回セットアップ

1. **Supabase**: プロジェクトを作り、SQL Editor で `supabase/schema.sql` を実行する。Project Settings → API から URL と `service_role` キーを控える。
2. **UptimeRobot**: Integrations → API で読み取り専用（read-only）の API キーを作る。
3. **GitHub の PAT**: Settings → Developer settings → Fine-grained tokens で、一覧に載せるリポジトリを選び、Metadata と Contents を Read にしたトークンを作る。公開リポジトリだけなら省略できる。
4. **Secrets**: このリポジトリの Settings → Secrets and variables → Actions に次を登録する。

   | 名前 | 値 |
   |---|---|
   | `SUPABASE_URL` | Supabase プロジェクトの URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | `service_role` キー |
   | `UPTIMEROBOT_API_KEY` | UptimeRobot の読み取り専用キー（任意。なければ全件「未監視」） |
   | `GH_READ_TOKEN` | 手順 3 のトークン（任意） |
   | `SITE_PASSPHRASE` | 一覧ページを開くパスフレーズ。推測されにくい 20 文字以上にする |

5. **Pages**: Settings → Pages で Source を「GitHub Actions」にする。
6. Actions の `sync` を「Run workflow」で手動実行し、一覧ページを開いてパスフレーズで復号できることを確かめる。

Secrets を登録するまで、同期ジョブは失敗にならず何もせずに終わる。

## サービスを 1 件追加する

1. Supabase の Table Editor で `services` に行を足す。最低限 `name`、`stage`、`github_repo`（`owner/repo` の形）。
2. 対象リポジトリの GitHub 設定（About の歯車）で Website に URL、Topics に技術タグを入れる。Supabase の `url` と `tags` は、これを上書きしたいときだけ使う。
3. 公開中なら UptimeRobot に同じ URL の監視を足す。URL で自動的に照合される。照合がうまくいかないときは `uptimerobot_monitor_id` に monitor ID を入れる。
4. 次の同期（最長 1 時間）で表に出る。すぐ見たいときは `sync` を手動実行する。

`stage` の値は `planning`（企画）、`developing`（開発中）、`released`（公開中）、`paused`（休止）、`retired`（終了）。

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
