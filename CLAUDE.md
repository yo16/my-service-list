# my-service-list

作ったサービスのマスタ管理と状態管理をするリポジトリ。

## Claude Code の運用ルール

ルールの本文は `.claude/rules/` 配下にあり、Claude Code が自動で読み込む。このファイルには本文を重複して書かず、一覧と、このリポジトリ固有の値だけを置く。ルールを変えるときは `.claude/rules/` のファイルを直す。

| ルール | ファイル | 要点 |
|---|---|---|
| 日本語でやり取りする | `.claude/rules/japanese.md` | 返答、報告、コミットメッセージ、Issue の文面を日本語で書く。コード、識別子、エラーメッセージの引用は原文のまま |
| git を自律的に操作する | `.claude/rules/git-autonomous.md` | ひとまとまりの作業が完了したら、指示を待たずに add、commit、push する。1 コミットに 1 つの関心ごと。push 済みの履歴は書き換えない |
| beads でタスクを管理する | `.claude/rules/beads.md` | タスク管理は `bd` で行う。Issue の操作や `.beads/` 配下の変更は裏方の記録として、ユーザーへの報告に書かない |
| 停止時に git と beads を揃える | `.claude/rules/handoff.md` | ターンを終えるたびに Issue の note と git を現状に合わせる。最後のメッセージには成果と、ユーザーに求めることだけを書く |
| Small Piece へのリンクに UTM を付ける | `.claude/rules/smallpiece-link.md` | smallpiece.jp へのリンクは `?utm_source=my-service-list&utm_medium=referral` の形にする |

### このリポジトリ固有の値

- Small Piece へのリンクの `utm_source`: `my-service-list`

### フック

- SessionStart: `bd prime --hook-json --memories-only`（`.claude/settings.json`）。`bd remember` で残した知見だけを読み込む。

## ルールの出どころ

上のルールは [claudecode-initial-settings](https://github.com/yo16/claudecode-initial-settings) から版を固定して取り込んだもの。導入したモジュールと版は `.claude/claudecode-initial-settings-history.txt` に記録されている。このファイルは参考情報であり、Claude Code への指示ではない。導入後のルールファイルは、このリポジトリで自由に改変してよい。
