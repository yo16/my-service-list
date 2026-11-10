# my-service-list 設計書

作成したウェブサービスの一覧を、1 つの表で見るためのサイトの設計。マスタは Supabase、死活は UptimeRobot、リポジトリ情報は GitHub から取り、GitHub Pages に限定公開する。

最終更新: 2026-11-06

## 1. 目的と範囲

- 自分が作ったウェブサービスに通し番号を付け、インフラ（配信先、DB、外部サービスなど）、技術背景、開発段階、公開日、死活状況を 1 画面で見渡せるようにする。
- 1 件あたりの情報は少なく保つ。詳細は各リポジトリに任せ、ここには「何が、どの段階で、生きているか」だけを置く。
- 対象は数十件を想定する。それを超える規模の検索やページングは扱わない。

### 決定事項

| 項目 | 決定 |
|---|---|
| 公開範囲 | 限定公開。厳格なログインは作らず、パスフレーズで復号する方式にする（5 章） |
| 配置先 | GitHub Pages（リポジトリ `yo16/my-service-list` は公開リポジトリ） |
| 通し番号 | Supabase の自動採番。マスタのキーなので、あとから変更できないようにする |
| 開発段階の語彙 | 企画（planning）、開発中（developing）、公開中（released）、休止（paused）、終了（retired） |
| 死活管理 | UptimeRobot API v3 を使う。無料プランで利用可能（10 リクエスト/分、監視 50 件まで） |

## 2. 全体構成

```
┌─────────────────────────┐
│ Supabase（マスタ）        │  services テーブル。ローカルの登録画面（scripts/admin.mjs）で編集する
└───────────┬─────────────┘
            │ 読む（service_role キー）
            ▼
┌─────────────────────────┐
│ GitHub Actions（同期ジョブ）│  1 時間ごと + 手動 + push 時
│  scripts/build.mjs       │
│   ├ GitHub API   → リポジトリの URL、Topics、使用言語、Release、最終 push、archived、ファイル
│   ├ UptimeRobot  → 死活、直近 24 時間の稼働率、最後の障害
│   ├ 各サイト      → 応答ヘッダー（インフラの判定）
│   └ 結合して JSON を作り、パスフレーズで暗号化
└───────────┬─────────────┘
            │ deploy-pages（暗号化済み JSON + 静的ページ）
            ▼
┌─────────────────────────┐
│ GitHub Pages（一覧ページ）│  site/ の HTML、CSS、JS
│  パスフレーズ入力 → 復号 → 表を描画 │
└─────────────────────────┘
```

- 一覧ページのブラウザは Supabase、GitHub、UptimeRobot のどれにも直接アクセスしない。鍵は GitHub Actions の Secrets と、登録画面を動かす PC の `.env` にだけ置く。
- マスタの追加と編集は、自分の PC で動かす登録画面（6.3）で行う。Supabase の鍵はその PC のサーバー側で使うだけで、ブラウザには渡さない。
- 公開リポジトリなので、サービス名を含むデータは **コミットしない**。同期ジョブが生成した暗号化済み JSON を Pages のアーティファクトとして配置するだけにする。
- 同期ジョブの結果を Supabase に書き戻さない。Supabase は人が編集するマスタだけを持ち、派生データは毎回作り直す。

### 2.1 使っている外部サービス

このシステム自体が使う外部のサービスは次のとおり。npm の依存はなく、CDN や外部フォント、アクセス解析も使わない（一覧ページは CSP で通信を同じオリジンに限っている）。

| サービス | 用途 | 使う場所 | 認証 |
|---|---|---|---|
| Supabase（PostgREST の REST API） | マスタ `services` テーブルの保存と読み書き | 同期ジョブ（読む）、登録画面（読み書き） | secret key（`SUPABASE_SERVICE_ROLE_KEY`） |
| GitHub REST API（`api.github.com`） | リポジトリの情報、Topics、使用言語、Release、ファイル一覧と中身の取得 | 同期ジョブ、登録画面 | 同期ジョブは `GH_READ_TOKEN`、なければ `GITHUB_TOKEN`。登録画面は `GH_READ_TOKEN`、`GITHUB_TOKEN`、gh CLI のログインの順。どれもなければ無認証 |
| GitHub Actions | 同期ジョブの実行（毎時、手動、push 時） | `.github/workflows/sync.yml` | リポジトリの Secrets |
| GitHub Pages | 一覧ページと暗号化済み `data.enc.json` の配信 | `actions/upload-pages-artifact`、`actions/deploy-pages` | Actions の `id-token: write` |
| GitHub CLI（`gh`） | 登録画面から同期ジョブを起動する（`gh workflow run`）。GitHub API のトークンの取得にも使う | 登録画面 | gh のログイン |
| UptimeRobot API v3（`api.uptimerobot.com`） | 死活、直近 24 時間の稼働率、最後の障害の取得 | 同期ジョブ | 読み取り専用キー（`UPTIMEROBOT_API_KEY`） |

- 鍵の置き場所は 4 章の Secrets と、登録画面を動かす PC の `.env`。
- このほか、インフラの判定（3.4）のために、登録した各サービスのサイトへ HTTP でアクセスして応答ヘッダーを見る。これは外部サービスの利用ではなく、監視対象への問い合わせである。
- 表の `infra` 列に出る Vercel や Firebase などは、一覧に載せた各サービスのインフラであり、このシステムが使うものではない。

## 3. データ

### 3.1 Supabase: `services` テーブル（マスタ）

人が入力する項目だけを持つ。定義は `supabase/schema.sql`。

| 列 | 型 | 必須 | 意味 |
|---|---|---|---|
| `id` | bigint（自動採番、変更不可） | ○ | 通し番号。画面では `#001` の形で表示する |
| `name` | text | ○ | サービス名 |
| `description` | text | | 一言の説明。未設定なら GitHub のリポジトリ説明を使う |
| `stage` | enum `service_stage` | ○ | planning / developing / released / paused / retired。既定は planning |
| `github_repo` | text | | `owner/repo` の形。設定すると GitHub から派生データを取る |
| `url` | text | | サービスの URL。未設定なら GitHub の Website 欄（homepage）を使う |
| `uptimerobot_monitor_id` | bigint | | UptimeRobot の monitor ID。未設定なら URL の一致で探す |
| `tags` | text[] | | 技術タグの追加分。GitHub の Topics、使用言語と結合して表示する |
| `infra` | text[] | ○ | インフラの追加分（GCE、Google Maps API など何でも）。自動判定の結果に足す。`-Name` は判定の結果から除く（3.4）。既定は空 |
| `released_on` | date | | 公開日。未設定なら GitHub の最初の Release の日付を使う |
| `note` | text | | 補足。展開したときだけ表示する |
| `created_at` / `updated_at` | timestamptz | ○ | 作成日時、更新日時（自動） |

設計上の判断:

- **「未設定なら GitHub から」の列が多いのは意図的。** 各リポジトリ側の設定と内容（Website、Topics、使用言語、Release）を正とし、Supabase には上書きしたいときだけ値を入れる。README の自由文は解釈しない。
- **`stage` だけは手動。** 「開発中」と「公開中」の境目は機械的に判定できない。ただし GitHub で archived になっていれば、画面で「アーカイブ済み」の印を出す。
- **`id` の変更不可**は、`generated always as identity` と、`id` の更新を拒否するトリガーの 2 段で守る。削除は可能だが、欠番はそのままにする（採番し直さない）。
- RLS を有効にし、ポリシーは作らない。anon キーでは何も読めず、同期ジョブは service_role キーで読む。

### 3.2 派生データ（同期ジョブが毎回取る）

GitHub API（`GET /repos/{owner}/{repo}`、`GET /repos/{owner}/{repo}/languages`、`GET /repos/{owner}/{repo}/releases?per_page=100`）:

| 取る値 | 用途 |
|---|---|
| `html_url` | リポジトリへのリンク |
| `homepage` | `url` の既定値 |
| `description` | `description` の既定値 |
| `topics` | 技術タグ。手で付けた分類（枠組み、サービス名など） |
| `languages`（言語ごとのバイト数） | 技術タグ。全体の 5% 以上の言語を多い順に最大 5 件、小文字にして Topics の後ろに足す。HTML、CSS、Shell、Dockerfile などの補助的なものは除く。規則は `scripts/lib/tags.mjs` にある。結合の順は Topics → 使用言語 → Supabase の `tags` で、重複は大文字小文字を無視して除く |
| `pushed_at` | 「最終更新」列 |
| `archived`, `private` | アーカイブ済みの印、非公開リポジトリの印 |
| Release の `published_at`（最古） | `released_on` の既定値 |
| Release の `tag_name` と `published_at`（最新） | 展開時に「最新リリース」として表示 |

UptimeRobot API v3（`GET https://api.uptimerobot.com/v3/monitors?limit=200`、Bearer 認証、`nextLink` で続きを取る）:

| 取る値 | 用途 |
|---|---|
| `id`, `url`, `friendlyName` | `uptimerobot_monitor_id` または URL との照合 |
| `status` | UP / DOWN / LOOKS_DOWN / PAUSED / STARTED |
| `lastIncident.startedAt` | 最後の障害の開始時刻 |

直近 24 時間の稼働率は、サービスに結びついた監視についてだけ、統計 API（`GET /monitors/{id}/stats/uptime`）で 1 件ずつ取る。指定なしで直近 24 時間の `uptime`（0〜100 の百分率）が返る。監視一覧の `lastDayUptimes.histogram` は実際の応答では空だったので使わない。無料プランは 10 リクエスト/分なので、429 が返ったら `Retry-After` だけ待って 1 回やり直す。取れないときは警告を出し、稼働率なしで続ける。

照合の規則: `uptimerobot_monitor_id` があればそれを使う。なければサービスの URL と監視の `url` を正規化（小文字のホスト、末尾のスラッシュを除く）して一致させる。どちらでも見つからなければ「未監視」とする。

### 3.3 公開データ `data.json`（暗号化前）

```json
{
  "generatedAt": "2026-11-03T06:00:00Z",
  "services": [
    {
      "id": 1,
      "name": "サービス名",
      "description": "一言の説明",
      "stage": "released",
      "url": "https://example.com/",
      "repo": {
        "fullName": "yo16/example",
        "url": "https://github.com/yo16/example",
        "private": false,
        "archived": false,
        "pushedAt": "2026-10-30T12:34:56Z",
        "latestRelease": { "tag": "v1.2.0", "publishedAt": "2026-09-01T00:00:00Z" }
      },
      "tags": ["nextjs", "typescript"],
      "infra": ["Vercel", "Supabase", "Google Maps API"],
      "releasedOn": "2025-04-01",
      "uptime": {
        "monitorId": 123456,
        "status": "UP",
        "ratio24h": 100,
        "lastIncidentAt": null
      },
      "note": null
    }
  ]
}
```

- `repo` は `github_repo` が未設定なら `null`。`uptime` は未監視なら `null`。
- 列の由来（Supabase か GitHub か）は JSON に残さない。画面は結果だけを見る。

### 3.4 インフラの判定

配信先、DB、その他のサービスを外から見える印で推定し、配信先、DB、その他の順に 1 つのリストにする。規則は `scripts/lib/infra.mjs` にあり、同期ジョブと登録画面で共有する。`infra` に手で入れた値はリストの後ろに足す。`-Name` と書いた値は、判定の結果から除く（誤判定を消すため）。何でも入れられるように種類は持たず、画面でも配信先や DB に分けて表示しない。

- **配信先**: 次の順に見て、最初に当たった段を採る。動いているサイトの印を、リポジトリの設定より優先する。
  1. サイトの最後の URL のホスト名（`*.github.io`、`*.vercel.app`、`*.run.app` など）
  2. 応答ヘッダー（`x-vercel-id`、`server: GitHub.com`、`x-nf-request-id` など）
  3. GitHub の Topics（`vercel`、`gce` など）
  4. リポジトリのファイル（`vercel.json`、`fly.toml`、wrangler の設定、`firebase.json` の `hosting` など）
  5. 手前に別のものが隠れていることがあるヘッダー（`server: cloudflare`、`server: Google Frontend` など）
- **DB**: Topics、`supabase` フォルダ、`firestore.rules`、wrangler の `d1_databases` と `kv_namespaces`、依存パッケージ（`package.json` の dependencies、`requirements.txt`、`pyproject.toml`）から、当たったものをすべて採る。`pg` のように種類しか分からないものは、ほかに当たらないときだけ PostgreSQL などと出す。
- **その他**: 依存パッケージと Topics から、Cloud Functions（`@google-cloud/functions-framework` など）と Google Maps API（`@googlemaps/js-api-loader` など）を採る。script タグで直接読み込む Google Maps は判定できない。
- **読む範囲**: Git Trees API でファイル一覧を取り、深さ 3 段（`apps/web/package.json` まで）を見る。`node_modules`、`docs`、`examples`、`tests` などは除く。ファイルの中身は種類ごとに 4 本まで、浅いものから読む。
- **限界**: GCE、VPS、レンタルサーバー（`server: nginx` だけが見える）、Cloud SQL は印が出ないので判定できない。手で入れるか、Topics に付ける。空欄は「使っていない」と「判定できない」を区別しない。
- **失敗の扱い**: サイトに接続できないとき（10 秒で打ち切る）やリポジトリを読めないときは、残りの手がかりで判定し、ジョブは止めない。警告には通し番号だけを出す。

## 4. 同期ジョブ

- 置き場所: `.github/workflows/sync.yml` と `scripts/build.mjs`。
- 実行契機: 1 時間ごと（cron）、手動（workflow_dispatch）、`site/` と `scripts/` への push。
- 実装: Node 22 の標準機能だけで書く（`fetch`、`crypto.subtle`）。npm の依存を持たない。Supabase は PostgREST の REST API を `fetch` で直接叩く。
- 手順:
  1. Supabase から `services` を `id` 順に読む。
  2. `github_repo` のある行について GitHub API を呼ぶ。404 や権限エラーは警告を出して `repo: null` にし、ジョブは止めない。
  3. UptimeRobot の監視一覧を 1 回で取り、各行に照合する。API エラーのときは全行 `uptime: null` にし、ジョブは止めない。
  4. インフラを決める（3.4）。
  5. `data.json` を組み立て、パスフレーズで暗号化して `dist/data.enc.json` に書く。`site/` の中身も `dist/` にコピーする。
  6. `actions/upload-pages-artifact` と `actions/deploy-pages` で配置する。
- 失敗の扱い: Supabase が読めないときだけジョブを失敗させる（前回の配置が残る）。外部 API の一部失敗は配置を止めない。
- ログの扱い: 公開リポジトリの Actions ログは誰でも読めるので、サービス名、URL、リポジトリ名をログに出さない。警告は通し番号（`#1` など）だけで示し、どのサービスかは登録画面で確かめる。

### Secrets

| 名前 | 内容 |
|---|---|
| `SUPABASE_URL` | Supabase プロジェクトの URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase の secret key（`sb_secret_...`）。旧形式の service_role キーでも動く。いずれも RLS を通過する |
| `GH_READ_TOKEN` | fine-grained PAT。対象リポジトリの Metadata と Contents の読み取り。非公開リポジトリを含めるために必要。公開リポジトリだけなら省略可（レート制限が 60 回/時になる） |
| `UPTIMEROBOT_API_KEY` | UptimeRobot の読み取り専用（read-only）キー |
| `SITE_PASSPHRASE` | 一覧ページを開くためのパスフレーズ |

## 5. 限定公開のしくみ

ログインの仕組みは作らず、データを暗号化して置く。

- 同期ジョブが `data.json` を AES-256-GCM で暗号化する。鍵はパスフレーズから PBKDF2（SHA-256、600,000 回、ランダムな salt）で導出する。
- 配置するファイルの形:

  ```json
  { "v": 1, "kdf": "PBKDF2-SHA256", "iter": 600000, "salt": "<base64>", "iv": "<base64>", "ct": "<base64>" }
  ```

- ブラウザはページを開くとパスフレーズを求め、WebCrypto で同じ手順で鍵を作って復号する。鍵が違うとき（`OperationError`）は「パスフレーズが違います」と出す。それ以外の失敗（データの形が違う、https でないなど）は原因をそのまま出す。
- 「このブラウザで記憶する」にチェックすると、パスフレーズを `localStorage` に保存して次回から自動で復号する。保存した値を消すのは、鍵が違うときと、画面の「このブラウザの記憶を消す」を押したときだけにする。
- `data.enc.json` が 404 のときだけ「データが見つかりません」とする（ローカルではサンプルを出す）。通信エラーや 5xx は読み込みの失敗として再読み込みを促す。
- 一覧ページには `<meta>` で CSP と `referrer: no-referrer` を指定する。スクリプトと通信は同じオリジンに限り、リンク先に一覧ページの場所を送らない。外部由来の URL をリンクにするのは http と https だけにする。
- パスフレーズは GitHub Secrets の `SITE_PASSPHRASE` と同じ値。変えるときは Secrets を更新して同期ジョブを手動実行する。

限界として、暗号化済みファイルは誰でも取得できるので、強度はパスフレーズの長さに依存する。推測されにくい、長めのパスフレーズ（英数字で 20 文字以上を目安）にする。HTML、CSS、JS は公開されるが、サービス名や URL は含まない。

将来、公開してよいサービスだけを誰でも見られるようにしたくなったら、`services` に `visibility` 列を足し、公開分を平文の `data.public.json` として別に配置すれば対応できる。

## 6. 画面設計

1 ページだけ。フレームワークもビルドも使わず、`site/index.html`、`site/style.css`、`site/app.js` で構成する。

### 6.1 構成

```
┌──────────────────────────────────────────────────────────────┐
│ My Services                          更新 2026-11-03 15:00   │
│ 公開中 8 ・ 開発中 3 ・ 停止中 1                               │
├──────────────────────────────────────────────────────────────┤
│ [検索          ] 5 / 6 件を表示  条件をクリア                 │
│ 段階: [企画][開発中][公開中][休止][終了]                       │
│ ▾ タグ: [nextjs][supabase][vercel][cloudflare] ...            │
├─────┬──┬──────────────┬──────┬────────────┬─────────┬────────┬──┤
│ No. │● │ サービス名     │ 段階  │ 技術タグ    │ 公開日   │ 最終更新 │⇗ ◇│
├─────┼──┼──────────────┼──────┼────────────┼─────────┼────────┼──┤
│ #001│● │ Small Piece    │公開中 │ nextjs sup…│ 2025-04 │ 3 日前  │⇗ ◇│
│     │  │ 小さな…の説明   │      │            │         │        │  │
│ #002│● │ xxx            │開発中 │ astro cf   │ —       │ 今日    │  ◇│
│ #003│○ │ yyy            │終了   │ rails      │ 2019-01 │ 2 年前  │⇗ ◇│
└─────┴──┴──────────────┴──────┴────────────┴─────────┴────────┴──┘
   ● 緑: 稼働中  ● 赤: 停止  ■ 灰: 一時停止/確認中  ○: 未監視
   ⇗ サイトを開く  ◇ リポジトリを開く
```

### 6.2 要素

- **ヘッダー**: タイトル、データの生成時刻、段階ごとの件数。死活で「停止」があれば、件数を赤い印で先頭に出す。
- **フィルタ**: 検索（名前、説明、補足、インフラ、タグ、リポジトリ名に部分一致）、段階のトグル（複数選択）、インフラのチップ（複数選択、AND）、タグのチップ（複数選択、AND）。既定では「終了」を隠す。表示件数（「5 / 6 件を表示」）を常に出し、既定から変えているときは「条件をクリア」を出す。インフラとタグは畳める。幅 720px 以上では最初から開き、それ未満では畳んで始める。畳んでいても選択中のものは見出しの横に出る。
- **表の列**（9 列）: 番号、死活の点、サービス名（下に説明を小さく 1 行）、段階のバッジ、インフラ（1 行に 1 つ）、技術タグ（3 つまで表示し、残りは「+n」）、公開日、最終更新（相対表示、ホバーで日時）、リンク 2 つ（サイト、リポジトリ）。
- **死活の点**: UP は緑の丸、DOWN と LOOKS_DOWN は外周つきの赤い丸、PAUSED と STARTED は灰の四角、未監視は灰の輪。ホバーで状態、24 時間の稼働率、最後の障害を出す。停止の行は左端に赤い線を引き、名前の横に「停止」と文字でも出す。
- **行の展開**: 行をクリックすると下に 1 段開き、説明の全文、note、最新リリース、アーカイブ済みの印、UptimeRobot の数値を出す。別ページは作らない。開閉しても、キーボードのフォーカスは名前のボタンに残す。
- **並べ替え**: 番号、公開日、最終更新の見出しをクリックで切り替える。既定は番号の昇順。状態は `aria-sort` でも伝える。見出しはスクロールしても画面上部に残す。
- **段階ごとの見た目**: 終了は名前とタグを薄くする（文字のコントラストは保つので、行全体の透明度は下げない）。休止はバッジだけ琥珀色にする。
- **タブレット幅（720〜959px）**: 表のまま列を詰め、公開日と技術の列を隠す。どちらも行を展開すると見られる。
- **スマホ幅（720px 未満）**: 表を横スクロールさせず、1 行を 1 枚のカードに変える。カードの 1 行目に番号、死活、名前、2 行目に段階とタグ、3 行目にインフラ、4 行目に日付とリンク。見出しは並べ替えのボタンだけを残す。入力欄の文字は 16px にする（iOS Safari の自動拡大を避ける）。
- **配色**: ライトとダークに `prefers-color-scheme` で追従する。文字は 4.5:1、入力欄の枠と死活の点は 3:1 以上のコントラストを保つ。死活の色は色覚多様性に配慮し、赤と緑に加えて形（丸、四角、輪）と文字でも区別する。
- **文字の大きさ**: 0.8rem、0.87rem、1rem の 3 段階（基準は 15px）。0.8rem を下限にする。
- **鍵の画面**: 復号前は表の代わりにパスフレーズの入力欄だけを出す。

### 6.3 登録画面（ローカル）

マスタの追加と編集は、Supabase の Table Editor ではなく、自分の PC で動かす登録画面で行う。

- 起動: `node scripts/admin.mjs`。`http://127.0.0.1:8787/` で `admin/index.html` を配信し、ブラウザを開く。Node 22 以上の標準機能だけで動き、npm の依存はない。
- 設定: リポジトリ直下の `.env` から `SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` を読む（`.env.example` を参照）。`.env` はコミットしない。
- 入力項目: サービス名（必須）、段階、GitHub リポジトリ。URL、インフラの追加分、説明、公開日、UptimeRobot の monitor ID、補足は「任意の項目」に畳んである。インフラの追加分はカンマ区切りで何でも入れられ、自動判定の結果に足される（3.4）。技術タグは入力させない。GitHub の Topics と使用言語から同期時に決める（3.2）。
- GitHub リポジトリ欄は候補を出す。候補は `GH_READ_TOKEN`、なければ gh CLI のログイン（`gh auth token`）、それもなければ公開リポジトリから取る。入力すると、そのリポジトリの説明、Website、技術、判定したインフラ、最終 push を表示し、同期で何が取れるかをその場で確かめられる。GitHub の URL を貼っても `owner/repo` に直す。
- 一覧には登録済みの行を出し、「編集」で同じフォームに読み込んで更新する。入力の途中で別の行の「編集」を押したときは、破棄してよいか確認する。幅 960px 以上ではフォームを画面に留める。
- 「一覧ページに反映する」は gh CLI で同期ジョブ（workflow_dispatch）を起動し、完了まで状態を表示する。起動前の最新の実行と比べて、今回の実行を見分ける。
- Supabase へは PostgREST の REST API（`/rest/v1/services`）を `fetch` で直接叩く。secret key は `apikey` ヘッダーだけで送り、旧形式の service_role キーなら `Authorization` にも付ける（同期ジョブと同じ）。入力の検証（必須、段階の値、`owner/repo` の形、URL の形、実在する日付）はサーバー側で行い、空文字は `null` にして保存する。
- 安全策: `127.0.0.1` にだけ待ち受ける。起動ごとに乱数トークンを作って HTML に埋め、API 呼び出しの `X-Admin-Token` を照合する。`Host` は HTML を含むすべての要求で照合する（別サイトからのフォーム送信や DNS rebinding への対策）。`frame-ancestors 'none'` で他サイトの iframe に入れさせない。書き込みは JSON だけ受け付ける。secret key はサーバー側で使うだけで、ブラウザには渡さない。

### 6.4 表記ゆれの点検（ローカル）

- 起動: `npm run check:variants`（中身は `node scripts/check-variants.mjs`）。画面は持たず、結果を端末に出す。Supabase は読むだけ。`--file <path>` で `data.json` の形のファイルを読むこともできる。
- 比べる範囲: サービス名とインフラの追加分は同じ語彙として比べ、インフラの判定（3.4）が返す表記も正しい表記として加える。技術タグの追加分はタグどうしで比べる。判定の表記どうしは別物として定義してあるので比べない。
- 候補にする組: 大文字小文字、全角半角、空白と記号、カタカナの伸ばす音（メーラー、メイラー、メーラ）の違いを消すと同じもの。GCP、Google、AWS などの社名と末尾の API を除くか、略称（GCE と Compute Engine など）をそろえると同じもの。1 文字（8 文字以上なら 2 文字）だけ違うもの。
- 候補は目で確かめる前提で、別物（react と preact など）も出ることがある。直すのは登録画面で行う。

## 7. 運用

### 初回セットアップ

1. Supabase でプロジェクトを作り、SQL Editor で `supabase/schema.sql` を実行する。
2. UptimeRobot の Integrations → API で読み取り専用キーを作る。
3. GitHub で fine-grained PAT を作る（対象リポジトリを選び、Metadata と Contents を Read）。
4. リポジトリの Settings → Secrets and variables → Actions に 4 章の Secrets を登録する。
5. Settings → Pages で Source を「GitHub Actions」にする。
6. Actions から同期ジョブを手動実行し、`https://yo16.github.io/my-service-list/` を開いてパスフレーズで復号できることを確かめる。

### サービスを 1 件追加する

1. `node scripts/admin.mjs` で登録画面を開き、サービス名、段階、GitHub リポジトリを入れて登録する（6.3）。
2. 対象リポジトリの GitHub 設定（About）で Website に URL を入れる。Topics に枠組みやサービス名（例: nextjs、supabase）を入れると技術タグに加わる。使用言語は自動で加わる。
3. 公開中なら UptimeRobot に同じ URL の監視を足す。
4. 登録画面の「一覧ページに反映する」で同期ジョブを起動する。押さなくても次の定時同期（最長 1 時間）で表に出る。

## 8. 決めていないこと

- 同期の間隔。1 時間で始め、短くしたければ cron を変える。GitHub Pages の配置は 1 時間あたり 10 回までの目安があるので、10 分未満にはしない。
- 30 日や 90 日の稼働率。必要になったら統計 API に `from` と `to` を渡して取る（最大 90 日）。
