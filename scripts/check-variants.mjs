#!/usr/bin/env node
/* my-service-list: 表記ゆれの点検
 *
 * Supabase の services から、サービス名、インフラの追加分、技術タグの追加分を読み、
 * 表記ゆれの可能性がある組を一覧にする。読むだけで、Supabase には書き込まない。
 * 例: 「フォームメーラー」と「フォームメイラー」、「Cloud Run」と「GCP Cloud Run」。
 * Node 22 以上の標準機能だけで動く。npm の依存はない。
 *
 * 使い方:
 *   npm run check:variants                      Supabase から読む
 *   node scripts/check-variants.mjs --file <path>   data.json の形のファイルから読む（例: site/sample/data.json）
 *
 * 環境変数（リポジトリ直下の .env に書けば読む）:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   --file を使わないときに必須
 *
 * 比べる範囲:
 *   - サービス名とインフラは同じ語彙として比べる（外部サービスの名前がどちらにも入りうるため）。
 *     インフラの判定（scripts/lib/infra.mjs）が返す表記も正しい表記として加える。
 *   - 技術タグは技術タグどうしで比べる。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { knownInfraLabels } from './lib/infra.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** そろえる先として決めた表記。インフラの判定の表記（infra.mjs）にないものをここに足す */
const PREFERRED_TERMS = ['フォームメーラー'];

// ---------- 読み込み ----------

async function loadDotEnv() {
  let text;
  try {
    text = await readFile(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (process.env[k] === undefined) process.env[k] = v; // 実際の環境変数を優先する
  }
}

async function fetchServices() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    throw new Error('SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が設定されていません。リポジトリ直下の .env に書いてください（.env.example を参照）');
  }
  // 新形式の secret key（sb_secret_...）は apikey ヘッダーだけで送る。旧形式の service_role キーは Authorization にも付ける
  const headers = { apikey: key, Accept: 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${base.replace(/\/+$/, '')}/rest/v1/services?select=id,name,infra,tags&order=id`, { headers });
  if (!res.ok) throw new Error(`Supabase の応答が ${res.status}: ${await res.text()}`);
  return res.json();
}

async function readServicesFile(file) {
  const data = JSON.parse(await readFile(path.resolve(file), 'utf8'));
  const services = Array.isArray(data) ? data : data.services;
  if (!Array.isArray(services)) throw new Error(`${file} に services の配列がありません`);
  return services;
}

// ---------- 正規化 ----------

const VOWEL_ROWS = {
  ア: 'アカガサザタダナハバパマヤラワ',
  イ: 'イキギシジチヂニヒビピミリ',
  ウ: 'ウクグスズツヅヌフブプムユル',
  エ: 'エケゲセゼテデネヘベペメレ',
  オ: 'オコゴソゾトドノホボポモヨロヲ',
};
const VOWEL_OF = new Map(Object.entries(VOWEL_ROWS).flatMap(([v, row]) => [...row].map((c) => [c, v])));

/** カタカナの読みをそろえる。長音、エイ/オウの伸ばし、小書き、ヴ、ヂ/ヅの違いを消す */
function normalizeKana(s) {
  let t = s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)); // ひらがな → カタカナ
  t = t.replace(/ヴ[ァィェォ]/g, (m) => ({ ァ: 'バ', ィ: 'ビ', ェ: 'ベ', ォ: 'ボ' })[m[1]]).replace(/ヴ/g, 'ブ');
  t = t.replace(/[ァィゥェォャュョッヮ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 1)); // 小書き → 並字
  t = t.replace(/ヂ/g, 'ジ').replace(/ヅ/g, 'ズ');
  // 伸ばす音を消す: メーラー、メイラー、メーラ → メラ
  let out = '';
  for (const c of t) {
    const prev = out.at(-1);
    const v = prev && VOWEL_OF.get(prev);
    if (c === 'ー') continue;
    if (v && c === v) continue; // カア → カ
    if (v === 'エ' && c === 'イ') continue; // メイ → メ
    if (v === 'オ' && c === 'ウ') continue; // コウ → コ
    out += c;
  }
  return out;
}

/** 大文字小文字、全角半角、空白と記号、カナの伸ばしの違いを消した比較用の文字列 */
function baseKey(s) {
  const t = s.normalize('NFKC').toLowerCase();
  return normalizeKana(t).replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 社名や接頭辞（GCP、Google Cloud、AWS など）と、末尾の API を除いた比較用の文字列 */
// 「Google Cloud」は除かない。Cloud Storage や Cloud Run の「Cloud」まで消えて、GCS などの略称と合わなくなるため
const VENDOR_WORDS = ['google cloud platform', 'gcp', 'google', 'amazon web services', 'aws', 'amazon', 'microsoft', 'azure'];
/** 略称と正式名。どちらで書いても同じものとして比べる */
const ALIASES = {
  gce: 'computeengine',
  gae: 'appengine',
  gcs: 'cloudstorage',
  gcf: 'cloudfunctions',
  bq: 'bigquery',
  gke: 'kubernetesengine',
  s3: 'amazons3',
};

function coreKey(s) {
  let t = s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ');
  for (const w of VENDOR_WORDS) t = t.replace(new RegExp(`(^|\\s)${w}(?=\\s|$)`, 'g'), ' ');
  t = t.replace(/(^|\s)api(?=\s|$)/g, ' ');
  const key = baseKey(t);
  return ALIASES[key] || key;
}

function editDistance(a, b) {
  const A = [...a];
  const B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[B.length];
}

// ---------- 比較 ----------

/**
 * terms は Map<表記, { uses: string[], known: boolean }>。
 * 似ている表記の組をつなぎ、つながった塊ごとに { members, reasons } を返す。
 */
function findVariantGroups(terms) {
  const list = [...terms.keys()].map((text) => ({ text, base: baseKey(text), core: coreKey(text), known: terms.get(text).known }));
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const reasons = new Map(); // 塊の代表 → 理由の集合
  const link = (i, j, reason) => {
    const a = find(i);
    const b = find(j);
    const merged = new Set([...(reasons.get(a) || []), ...(reasons.get(b) || []), reason]);
    parent[b] = a;
    reasons.delete(b);
    reasons.set(a, merged);
  };

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const x = list[i];
      const y = list[j];
      if (x.known && y.known) continue; // そろえる表記どうしは別物として定義してある
      if (!x.base || !y.base) continue;
      if (x.base === y.base) {
        link(i, j, '大文字小文字、記号、空白、伸ばす音の違い');
      } else if (x.core && x.core.length >= 2 && x.core === y.core) {
        link(i, j, '社名や略称、API の有無の違い');
      } else {
        const len = Math.min([...x.base].length, [...y.base].length);
        const d = editDistance(x.base, y.base);
        if ((len >= 4 && d === 1) || (len >= 8 && d === 2)) link(i, j, `${d} 文字の違い`);
      }
    }
  }

  const groups = new Map();
  list.forEach((t, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t.text);
  });
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([r, members]) => ({ members, reasons: [...(reasons.get(r) || [])] }));
}

function addTerm(terms, text, use, known = false) {
  const t = String(text ?? '').trim();
  if (!t) return;
  if (!terms.has(t)) terms.set(t, { uses: [], known: false });
  const entry = terms.get(t);
  if (use) entry.uses.push(use);
  if (known) entry.known = true;
}

function printGroups(title, groups, terms) {
  console.log(`■ ${title}: ${groups.length} 組`);
  if (!groups.length) {
    console.log('  候補はありません。');
    console.log('');
    return;
  }
  groups.forEach((g, n) => {
    console.log(`  ${n + 1}. ${g.reasons.join('、')}`);
    const width = Math.max(...g.members.map((m) => displayWidth(m)));
    for (const m of g.members) {
      const { uses, known } = terms.get(m);
      const where = [...uses, ...(known ? ['← そろえる表記'] : [])].join(', ');
      console.log(`     ${m}${' '.repeat(width - displayWidth(m))}   ${where}`);
    }
  });
  console.log('');
}

/** 端末での表示幅。全角は 2 として数える */
function displayWidth(s) {
  let w = 0;
  for (const c of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1;
  return w;
}

async function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  let services;
  if (fileIndex >= 0) {
    if (!args[fileIndex + 1]) throw new Error('--file のあとにファイルのパスを書いてください');
    services = await readServicesFile(args[fileIndex + 1]);
  } else {
    await loadDotEnv();
    services = await fetchServices();
  }

  const words = new Map(); // サービス名とインフラ
  const tags = new Map();
  for (const s of services) {
    const no = `#${String(s.id).padStart(3, '0')}`;
    addTerm(words, s.name, `${no} 名前`);
    for (const v of s.infra || []) addTerm(words, String(v).replace(/^-/, ''), `${no} インフラ`);
    for (const v of s.tags || []) addTerm(tags, v, `${no} タグ`);
  }
  for (const label of [...knownInfraLabels(), ...PREFERRED_TERMS]) addTerm(words, label, null, true);

  console.log(`${services.length} 件のサービスを点検しました。表記ゆれの可能性がある組を出します（直すかどうかは目で確かめてください）。`);
  console.log('');
  printGroups('サービス名とインフラ', findVariantGroups(words), words);
  printGroups('技術タグ', findVariantGroups(tags), tags);
}

main().catch((e) => {
  console.error(`[check-variants] ${e.message}`);
  process.exit(1);
});
