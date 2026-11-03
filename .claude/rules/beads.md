# beads でタスクを管理する

- タスク管理には `bd`（beads）を使う。TodoWrite や Markdown の TODO リストは使わない。
- セッション開始時のフックは `bd prime --hook-json --memories-only` で、`bd remember` で残した知見だけを読み込む。コマンドの使い方は `bd <コマンド> --help` で確認する。
- 着手前に Issue を作り（`bd create`）、作業中は claim し（`bd update <id> --claim`）、終わったら閉じる（`bd close <id>`）。
- 1 コミットで終わる軽微な修正（誤字の修正、空行の調整など）は Issue を作らなくてよい。Issue が役に立つのは、作業がセッションをまたぐ可能性があるときと、あとから経緯を探す必要があるときである。
- 作業中に見つかった残作業や後回しにしたことは、その場で Issue にする。
- 次のセッションに引き継ぎたい知見は `bd remember` で残す。
- beads は裏方の記録である。Issue の作成、claim、close、note、`bd remember`、`.beads/` 配下の変更は、ユーザーへの報告に書かない。報告するのは作業の成果と、ユーザーに判断を求めることだけにする。Issue の状態は、ユーザーが尋ねたときに答える。
- Issue のデータは `.beads/` 配下の Dolt データベースにある。リモートとの同期は `bd dolt push` と `bd dolt pull` で行う。
- `bd edit` はエディタを開いて止まるので使わない。
