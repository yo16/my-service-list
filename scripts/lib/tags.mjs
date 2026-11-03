// 技術タグの決め方。同期ジョブ（build.mjs）と登録画面（admin.mjs）で共有する。

/** 使用言語をタグにする最低の割合（バイト数ベース）。設定ファイル程度の少量のものを除く */
export const LANGUAGE_MIN_SHARE = 0.05;
/** 使用言語をタグにする最大数 */
export const LANGUAGE_MAX = 5;
/** 使用言語のうち、技術タグとしては情報量が少ないので除くもの（マークアップ、スタイル、シェル、ビルド補助）。小文字で比べる */
export const LANGUAGE_EXCLUDE = new Set([
  'html', 'css', 'scss', 'less',
  'shell', 'batchfile', 'powershell',
  'dockerfile', 'makefile', 'cmake', 'procfile', 'nix',
]);

/**
 * GitHub の languages API の応答（{ 言語名: バイト数 }）から、タグにする言語名を選ぶ。
 * 全体に占める割合が LANGUAGE_MIN_SHARE 以上の言語を多い順に並べ、LANGUAGE_EXCLUDE を除き、
 * LANGUAGE_MAX 件までを小文字で返す。
 */
export function pickLanguages(byteMap) {
  const entries = Object.entries(byteMap || {})
    .map(([name, n]) => [name, Number(n)])
    .filter(([, n]) => Number.isFinite(n) && n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return [];
  return entries
    .sort((a, b) => b[1] - a[1])
    .filter(([name, n]) => n / total >= LANGUAGE_MIN_SHARE && !LANGUAGE_EXCLUDE.has(name.toLowerCase()))
    .slice(0, LANGUAGE_MAX)
    .map(([name]) => name.toLowerCase());
}

/** 複数のタグの列を順に結合し、大文字小文字を無視して重複を除く。先に出たものの表記を残す */
export function mergeTags(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of list || []) {
      const t = String(raw ?? '').trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}
