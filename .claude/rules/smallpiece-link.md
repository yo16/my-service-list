# Small Piece へのリンクには UTM パラメータを付ける

Small Piece（https://smallpiece.jp/）へのリンクを置くときは、GA4 でどのサービスのどこから来たかが分かるように、次の形にする。README、Web ページ、テンプレート、メールの文面など、置き場所を問わず同じ。

- このリポジトリの `utm_source` の値: `my-service-list`

## リンクの形

```
https://smallpiece.jp/?utm_source=my-service-list&utm_medium=referral
```

- `utm_source` には上のサービス名を入れる。リポジトリ内のすべてのリンクで同じ値にする。
- `utm_medium` は常に `referral`。
- 設置場所まで分けたいときだけ、`utm_content` を足す。値は英小文字、数字、ハイフンで書く（例: `footer`、`blog-sidebar`）。
- トップページ以外へのリンクも同じ形にする。パスのあとに `?` を続ける。
- HTML の属性の中では、`&` を `&amp;` と書いてよい。ブラウザが `&` に戻すので同じ URL になる。

## 例

```
https://smallpiece.jp/?utm_source=my-service-list&utm_medium=referral
https://smallpiece.jp/?utm_source=my-service-list&utm_medium=referral&utm_content=footer
https://smallpiece.jp/case-studies?utm_source=my-service-list&utm_medium=referral
```

## 既存のリンク

- Small Piece へのリンクを編集するときは、この形に直す。
- 編集していない既存のリンクをまとめて直すのは、ユーザーの指示があるときだけにする。
