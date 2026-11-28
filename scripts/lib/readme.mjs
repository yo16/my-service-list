/* my-service-list: README から登録情報の候補を読む（通信をしない部分）
 *
 * README からのメンテナンス（scripts/maintain-from-readme.mjs）が使う。
 * README は自由文なので、ここでできるのは「名前が出てくる」ことの検出までで、実際に使っているかは分からない。
 * そのため結果は候補として扱い、書き込む前に人が目で確かめる前提にする。
 */

/** 説明の長さの上限（文字）。一覧では 1 行に収めるので、短く保つ */
export const SUMMARY_MAX = 120;

/**
 * 技術タグの辞書。[正規表現, タグ]。タグは GitHub の Topics と同じく英小文字とハイフンで書く。
 * 使用言語は GitHub の languages から取れるので、ここには入れない。
 * 英単語として普通に出てくる名前（express、expo、remix など）は誤検出が多いので入れない。
 */
const TECH_RULES = [
  [/\bnext\.?js\b/i, 'nextjs'],
  [/\bnuxt(\.?js)?\b/i, 'nuxt'],
  [/\breact native\b/i, 'react-native'],
  [/\breact(\.?js)?\b/i, 'react'],
  [/\bvue(\.?js)?\b/i, 'vue'],
  [/\bsvelte ?kit\b/i, 'sveltekit'],
  [/\bsvelte\b/i, 'svelte'],
  [/\bastro\b/i, 'astro'],
  [/\bvite\b/i, 'vite'],
  [/\btailwind( ?css)?\b/i, 'tailwind'],
  [/\bprisma\b/i, 'prisma'],
  [/\bdrizzle\b/i, 'drizzle'],
  [/\bhono\b/i, 'hono'],
  [/\bexpress\.js\b/i, 'express'],
  [/\bnest\.?js\b/i, 'nestjs'],
  [/\bfastapi\b/i, 'fastapi'],
  [/\bflask\b/i, 'flask'],
  [/\bdjango\b/i, 'django'],
  [/\bstreamlit\b/i, 'streamlit'],
  [/\b(ruby on )?rails\b/i, 'rails'],
  [/\blaravel\b/i, 'laravel'],
  [/\belectron\b/i, 'electron'],
  [/\bflutter\b/i, 'flutter'],
  [/\blangchain\b/i, 'langchain'],
  [/\bn8n\b/i, 'n8n'],
  [/\bdocker\b/i, 'docker'],
  [/\bterraform\b/i, 'terraform'],
  [/\bplaywright\b/i, 'playwright'],
  [/\bpuppeteer\b/i, 'puppeteer'],
  [/\bthree\.js\b/i, 'threejs'],
  [/\bd3\.js\b/i, 'd3'],
  [/\bchart\.js\b/i, 'chartjs'],
  [/\bleaflet\b/i, 'leaflet'],
  [/\bwordpress\b/i, 'wordpress'],
  [/\bgoogle apps script\b/i, 'google-apps-script'],
  [/\bpandas\b/i, 'pandas'],
  [/\bpytorch\b/i, 'pytorch'],
  [/\btensorflow\b/i, 'tensorflow'],
  [/\bduckdb\b/i, 'duckdb'],
];

/**
 * インフラの辞書。[正規表現, 名前]。名前は scripts/lib/infra.mjs の判定と同じ表記にそろえる。
 * 「Cloudflare」「Firebase」「AWS」のような会社やまとまりの名前だけでは、何を使っているか決まらないので入れない。
 */
const INFRA_RULES = [
  [/\bvercel\b/i, 'Vercel'],
  [/\bnetlify\b/i, 'Netlify'],
  [/\bgithub pages\b/i, 'GitHub Pages'],
  [/\bcloudflare pages\b/i, 'Cloudflare Pages'],
  [/\bcloudflare workers\b/i, 'Cloudflare Workers'],
  [/\bcloudflare d1\b/i, 'Cloudflare D1'],
  [/\bcloudflare kv\b/i, 'Cloudflare KV'],
  [/\bcloudflare r2\b/i, 'Cloudflare R2'],
  [/\bfirebase hosting\b/i, 'Firebase Hosting'],
  [/\b(google )?cloud (run )?functions\b/i, 'Google Cloud Functions'],
  [/\bcloud run\b(?! functions)/i, 'Cloud Run'],
  [/\b(gce|(google )?compute engine)\b/i, 'GCE'],
  [/\b(google )?app engine\b/i, 'App Engine'],
  [/\b(google )?cloud storage\b/i, 'Cloud Storage'],
  [/\bcloud sql\b/i, 'Cloud SQL'],
  [/\bbigquery\b/i, 'BigQuery'],
  [/\bfirestore\b/i, 'Firestore'],
  [/\bgoogle maps\b/i, 'Google Maps API'],
  [/\bfly\.io\b/i, 'Fly.io'],
  [/\bheroku\b/i, 'Heroku'],
  [/\baws lambda\b/i, 'AWS Lambda'],
  [/\baws amplify\b/i, 'AWS Amplify'],
  [/\b(amazon |aws )s3\b/i, 'Amazon S3'],
  [/\bcloudfront\b/i, 'Amazon CloudFront'],
  [/\bdynamodb\b/i, 'DynamoDB'],
  [/\bsupabase\b/i, 'Supabase'],
  [/\bplanetscale\b/i, 'PlanetScale'],
  [/\bturso\b/i, 'Turso'],
  [/\bupstash\b/i, 'Upstash'],
  [/\bmongodb\b/i, 'MongoDB'],
  [/\bpostgres(ql)?\b/i, 'PostgreSQL'],
  [/\bmysql\b/i, 'MySQL'],
  [/\bsqlite\b/i, 'SQLite'],
  [/\bstripe\b/i, 'Stripe'],
  [/\bsendgrid\b/i, 'SendGrid'],
  [/\bauth0\b/i, 'Auth0'],
  [/\bopenai\b/i, 'OpenAI API'],
  [/\banthropic\b|\bclaude api\b/i, 'Anthropic API'],
  [/\bgemini api\b/i, 'Gemini API'],
  [/\bline messaging api\b/i, 'LINE Messaging API'],
  [/フォームメ[ーイ]ラー?|\bform ?mailer\b/i, 'フォームメーラー'],
];

/** 技術やインフラを書く節の見出し。辞書は、README の冒頭と、この見出しの節（その下の小見出しを含む）だけに当てる */
const STACK_HEADING = /技術|構成|スタック|インフラ|アーキテクチャ|使用(している)?(サービス|ツール|ライブラリ)|tech|stack|architecture|infrastructure|built with/i;

/** サービスの URL として採らないホスト。バッジ、ソースの置き場所、手元や例の URL */
/**
 * README を、冒頭（最初の ## より前）と、技術やインフラを書く節に分ける。
 * 比較や経緯の節に出てくる名前（使わなかったもの、監視の道具など）を拾わないため。
 * @returns {{ intro: string, stack: string }}
 */
export function pickSections(markdown) {
  const intro = [];
  const stack = [];
  let seenH2 = false;
  let stackLevel = 0; // 技術の節の中にいるときの、その見出しの深さ。0 なら外
  for (const line of stripCode(markdown).split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      if (level >= 2) seenH2 = true;
      if (stackLevel && level <= stackLevel) stackLevel = 0;
      if (!stackLevel && level >= 2 && STACK_HEADING.test(h[2])) stackLevel = level;
      continue;
    }
    if (!seenH2) intro.push(line);
    else if (stackLevel) stack.push(line);
  }
  return { intro: intro.join('\n'), stack: stack.join('\n') };
}

const IGNORED_URL_HOSTS =/(^|\.)(github\.com|githubusercontent\.com|shields\.io|badge\.fury\.io|npmjs\.com|example\.(com|org|net)|localhost)$|^127\.|^0\.0\.0\.0$/i;
/** この語がある行の URL だけを、サービスの URL の候補にする */
const URL_LINE_HINT = /(公開先|公開\s*URL|本番|サイト|デモ|アクセス|URL|demo|live|website|production)/i;

/** フェンスで囲んだコード、HTML のコメント、front matter を除く。辞書がコマンドの例に当たらないようにする */
export function stripCode(markdown) {
  return String(markdown || '')
    .replace(/^﻿/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

/** Markdown の行内の書式を外して、文字だけにする */
function plainText(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // 画像
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // リンク（画像を包んだリンクは、中身が空になって消える）
    .replace(/<[^>]+>/g, '')                        // HTML のタグ
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')            // 強調、コード、打ち消し
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 冒頭（最初の ## より前）の、最初の地の文の段落を、一言の説明にする。バッジだけの行、リスト、表、引用は飛ばす。
 * 2 つ目以降の節の文は、サービスの説明ではないことが多いので採らない。
 * 長いときは文の切れ目で切り、それでも長ければ末尾を「…」にする。見つからなければ null。
 */
export function summarize(markdown, max = SUMMARY_MAX) {
  const paragraphs = pickSections(markdown).intro.split(/\r?\n\s*\r?\n/);
  for (const p of paragraphs) {
    const lines = p.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // 見出し、リスト、表、引用、区切り線で始まる段落は、説明の文ではない
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|={3,}$|-{3,}$)/.test(lines[0])) continue;
    if (lines.length >= 2 && /^(={3,}|-{3,})$/.test(lines[1])) continue; // 下線の形の見出し
    const text = plainText(lines.join(' '));
    if (text.length < 8) continue; // バッジだけ、記号だけの段落
    if (text.length <= max) return text;
    const head = text.slice(0, max);
    const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('. '));
    return cut >= max / 3 ? head.slice(0, cut + 1).trim() : `${head.slice(0, max - 1).trim()}…`;
  }
  return null;
}

function matchRules(text, rules) {
  const found = [];
  for (const [re, label] of rules) {
    if (re.test(text) && !found.includes(label)) found.push(label);
  }
  return found;
}

/** サービスの URL の候補。公開先を示す語がある行の、最初の http(s) の URL。なければ null */
export function findSiteUrl(markdown) {
  for (const line of stripCode(markdown).split(/\r?\n/)) {
    if (!URL_LINE_HINT.test(line)) continue;
    // URL に使える ASCII の文字だけを続きとみなす（全角のかっこや句読点を巻き込まない）
    for (const m of line.matchAll(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g)) {
      const raw = m[0].replace(/[.,;:!?]+$/, '');
      try {
        const u = new URL(raw);
        if (!IGNORED_URL_HOSTS.test(u.hostname)) return u.href;
      } catch {
        /* URL として読めないものは飛ばす */
      }
    }
  }
  return null;
}

/** README から候補を読む。{ summary, tags, infra, url } */
export function extractFromReadme(markdown) {
  const { intro, stack } = pickSections(markdown);
  const text = `${intro}\n${stack}`;
  let tags = matchRules(text, TECH_RULES);
  // 上位の名前が当たっているときは、含まれる名前を落とす（SvelteKit があれば svelte、React Native があれば react は足さない）
  if (tags.includes('sveltekit')) tags = tags.filter((t) => t !== 'svelte');
  if (tags.includes('react-native')) tags = tags.filter((t) => t !== 'react');
  return { summary: summarize(markdown), tags, infra: matchRules(text, INFRA_RULES), url: findSiteUrl(markdown) };
}

const lower = (list) => new Set((Array.isArray(list) ? list : []).map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean));

/**
 * 登録済みの行と README の候補から、書き込む差分を作る。足すだけで、すでにある値は消さない。
 *
 * @param {object} row Supabase の services の行
 * @param {{ summary: string|null, tags: string[], infra: string[], url: string|null }} extracted
 * @param {object} context
 *   knownTags       GitHub の Topics と使用言語（すでに一覧に出ているタグ）
 *   detectedInfra   同期ジョブの自動判定が返すインフラ（すでに一覧に出ているもの）
 *   repoDescription GitHub のリポジトリの説明
 *   repoHomepage    GitHub の Website 欄
 *   rewriteDescription true なら、すでにある説明も README の内容に置き換える
 * @returns {{ patch: object, changes: string[] }} patch が空なら変更なし
 */
export function planUpdate(row, extracted, { knownTags = [], detectedInfra = [], repoDescription = null, repoHomepage = null, rewriteDescription = false } = {}) {
  const patch = {};
  const changes = [];

  const haveTags = new Set([...lower(knownTags), ...lower(row.tags)]);
  const newTags = extracted.tags.filter((t) => !haveTags.has(t.toLowerCase()));
  if (newTags.length) {
    patch.tags = [...(Array.isArray(row.tags) ? row.tags : []), ...newTags];
    changes.push(`技術タグに足す: ${newTags.join(', ')}`);
  }

  // -Name と書いて除いてあるものは、README に出てきても足さない（人が誤判定として消したもの）
  const manual = Array.isArray(row.infra) ? row.infra : [];
  const excluded = lower(manual.filter((v) => String(v).trim().startsWith('-')).map((v) => String(v).trim().slice(1)));
  const haveInfra = new Set([...lower(detectedInfra), ...lower(manual)]);
  const newInfra = extracted.infra.filter((v) => !haveInfra.has(v.toLowerCase()) && !excluded.has(v.toLowerCase()));
  if (newInfra.length) {
    patch.infra = [...manual, ...newInfra];
    changes.push(`インフラに足す: ${newInfra.join(', ')}`);
  }

  if (extracted.summary) {
    const current = row.description || null;
    if (!current && !repoDescription) {
      patch.description = extracted.summary;
      changes.push(`説明を入れる: ${extracted.summary}`);
    } else if (rewriteDescription && extracted.summary !== (current || repoDescription)) {
      patch.description = extracted.summary;
      changes.push(`説明を書き換える: ${current || repoDescription} → ${extracted.summary}`);
    }
  }

  if (extracted.url && !row.url && !repoHomepage) {
    patch.url = extracted.url;
    changes.push(`URL を入れる: ${extracted.url}`);
  }

  return { patch, changes };
}
