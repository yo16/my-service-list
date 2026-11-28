#!/usr/bin/env node
/* my-service-list: README から登録情報をメンテナンスする
 *
 * 登録済みのサービスの GitHub リポジトリの README を読み、Supabase の services に無い情報を足す。
 *   - 技術タグ: README に名前が出てくる枠組みやツール（GitHub の Topics と使用言語に無いもの）
 *   - インフラ: README に名前が出てくるサービス（自動判定の結果と登録済みの値に無いもの）
 *   - 説明: 登録にも GitHub の説明にも無いとき、README の最初の段落
 *   - URL: 登録にも GitHub の Website 欄にも無いとき、README の公開先の行の URL
 * 足すだけで、すでにある値は消さない。-Name で除いてあるインフラは、README にあっても足さない。
 * README は自由文で、名前が出てくることしか分からないので、既定では書き込まずに候補だけを出す。
 * Node 22 以上の標準機能だけで動く。npm の依存はない。
 *
 * 使い方:
 *   node scripts/maintain-from-readme.mjs                         候補を出す（書き込まない）
 *   node scripts/maintain-from-readme.mjs --apply                 候補を書き込む
 *   node scripts/maintain-from-readme.mjs --id 3,5                通し番号で対象を絞る
 *   node scripts/maintain-from-readme.mjs --rewrite-description   すでにある説明も、README の最初の段落に置き換える
 *
 * 環境変数（リポジトリ直下の .env に書けば読む。登録画面と同じ）:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   必須
 *   GH_READ_TOKEN_1〜9, GH_READ_TOKEN, GITHUB_TOKEN   任意。どれも無ければ gh CLI のログイン、それも無ければ無認証
 *
 * 端末にはサービス名や README の文を出す。自分の PC で動かす前提で、Actions では動かさない。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { pickLanguages } from './lib/tags.mjs';
import { probeSite, readRepoSignals, detectInfra } from './lib/infra.mjs';
import { extractFromReadme, planUpdate } from './lib/readme.mjs';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = (...a) => console.log('[readme]', ...a);
const warn = (...a) => console.warn('[readme] 警告:', ...a);

// ---------- 引数 ----------

function parseArgs(argv) {
  const opts = { apply: false, rewriteDescription: false, ids: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--rewrite-description') opts.rewriteDescription = true;
    else if (a === '--id' || a.startsWith('--id=')) {
      const v = a === '--id' ? argv[++i] : a.slice(5);
      const ids = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length || ids.some((s) => !/^\d+$/.test(s))) throw new Error('--id には通し番号をカンマ区切りで書いてください（例: --id 3,5）');
      opts.ids = new Set(ids.map(Number));
    } else throw new Error(`知らないオプションです: ${a}`);
  }
  return opts;
}

// ---------- .env と Supabase ----------

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

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が設定されていません。リポジトリ直下の .env に書いてください（.env.example を参照）`);
  return v;
}

async function supabase(method, pathname, body) {
  const base = env('SUPABASE_URL').replace(/\/+$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  // 新形式の secret key（sb_secret_...）は apikey ヘッダーだけで送る。旧形式の service_role キーは Authorization にも付ける
  const headers = { apikey: key, Accept: 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers.Prefer = 'return=representation';
  }
  const res = await fetch(`${base}/rest/v1${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      message = [j.code, j.message, j.hint].filter(Boolean).join(' / ') || message;
    } catch {
      /* JSON でなければそのまま */
    }
    throw new Error(`Supabase の応答が ${res.status}: ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------- GitHub ----------

// 同期ジョブと同じく、持ち主ごとのトークン（値は「持ち主=トークン」）→ GH_READ_TOKEN → GITHUB_TOKEN の順。
// どれも無ければ、登録画面と同じく gh CLI のログインを使う
let fallbackToken = null;

function ownerTokens() {
  const map = new Map();
  for (let i = 1; i <= 9; i++) {
    const v = String(process.env[`GH_READ_TOKEN_${i}`] || '').trim();
    const at = v.indexOf('=');
    if (at > 0 && v.slice(at + 1).trim()) map.set(v.slice(0, at).trim().toLowerCase(), v.slice(at + 1).trim());
  }
  return map;
}

async function resolveFallbackToken() {
  if (process.env.GH_READ_TOKEN) return { token: process.env.GH_READ_TOKEN, source: 'GH_READ_TOKEN' };
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  try {
    const { stdout } = await execFileP('gh', ['auth', 'token'], { timeout: 10000 });
    if (stdout.trim()) return { token: stdout.trim(), source: 'gh CLI のログイン' };
  } catch {
    /* gh がないか、未ログイン */
  }
  return { token: null, source: '無認証（公開リポジトリのみ）' };
}

async function ghGet(pathname, token) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'my-service-list-readme' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API の応答が ${res.status}`);
  return res.json();
}

/** 1 つのリポジトリについて、README と、すでに一覧に出ている値（Topics、使用言語、自動判定のインフラ）を読む */
async function readRepo(row, tokens) {
  const fullName = row.github_repo;
  const token = tokens.get(fullName.split('/')[0].toLowerCase()) || fallbackToken;
  const get = (p) => ghGet(p, token);
  const repo = await get(`/repos/${fullName}`);
  if (!repo) return null;
  const readmeFile = await get(`/repos/${fullName}/readme`);
  const readme = readmeFile && readmeFile.encoding === 'base64' ? Buffer.from(readmeFile.content, 'base64').toString('utf8') : null;
  const topics = Array.isArray(repo.topics) ? repo.topics : [];
  const languages = pickLanguages((await get(`/repos/${fullName}/languages`)) || {});
  let signals = null;
  try {
    signals = await readRepoSignals(get, repo.full_name);
  } catch (e) {
    warn(`#${row.id}: リポジトリの中身を読めないので、ファイルからはインフラを判定しません: ${e.message}`);
  }
  const url = row.url || repo.homepage || null;
  const detectedInfra = detectInfra({ site: await probeSite(url, { userAgent: 'my-service-list-readme' }), repo: signals, topics });
  return { readme, knownTags: [...topics, ...languages], detectedInfra, repoDescription: repo.description || null, repoHomepage: repo.homepage || null };
}

// ---------- 本体 ----------

const no = (id) => `#${String(id).padStart(3, '0')}`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await loadDotEnv();

  const tokens = ownerTokens();
  const fallback = await resolveFallbackToken();
  fallbackToken = fallback.token;
  log(`GitHub の認証: ${tokens.size ? `持ち主ごとのトークン ${tokens.size} 本、ほかは ` : ''}${fallback.source}`);

  const all = await supabase('GET', '/services?select=id,name,description,url,github_repo,tags,infra&order=id.asc');
  const rows = all.filter((r) => !opts.ids || opts.ids.has(r.id));
  if (opts.ids) {
    for (const id of opts.ids) if (!all.some((r) => r.id === id)) warn(`${no(id)} は登録されていません`);
  }

  const plans = [];
  let noRepo = 0;
  let noReadme = 0;
  for (const row of rows) {
    if (!row.github_repo) {
      noRepo++;
      continue;
    }
    let info;
    try {
      info = await readRepo(row, tokens);
    } catch (e) {
      warn(`${no(row.id)} ${row.name}: GitHub から読めません: ${e.message}`);
      continue;
    }
    if (!info) {
      warn(`${no(row.id)} ${row.name}: リポジトリが見つかりません（非公開なら、読めるトークンが要ります）`);
      continue;
    }
    if (!info.readme) {
      noReadme++;
      continue;
    }
    const plan = planUpdate(row, extractFromReadme(info.readme), { ...info, rewriteDescription: opts.rewriteDescription });
    if (plan.changes.length) plans.push({ row, ...plan });
  }

  log(`${rows.length} 件を調べました（リポジトリ未設定 ${noRepo} 件、README なし ${noReadme} 件）。変更の候補は ${plans.length} 件です`);
  for (const { row, changes } of plans) {
    console.log('');
    console.log(`${no(row.id)} ${row.name}（${row.github_repo}）`);
    for (const c of changes) console.log(`  - ${c}`);
  }
  if (!plans.length) return;
  console.log('');

  if (!opts.apply) {
    log('何も書き込んでいません。README に名前が出てくるだけで、使っていないものが混ざることがあります。目で確かめてください');
    log('書き込むときは --apply を付けます。一部だけ書き込むときは --id 3,5 のように通し番号で絞ります');
    return;
  }

  let done = 0;
  for (const { row, patch } of plans) {
    try {
      const updated = await supabase('PATCH', `/services?id=eq.${row.id}`, patch);
      if (!Array.isArray(updated) || !updated.length) throw new Error('更新された行がありません');
      done++;
    } catch (e) {
      warn(`${no(row.id)} ${row.name}: 書き込みに失敗しました: ${e.message}`);
    }
  }
  log(`${done} / ${plans.length} 件を書き込みました`);
  log('一覧ページには、次の同期（最長 1 時間）か、登録画面の「一覧ページに反映する」で出ます');
  if (done < plans.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[readme] 失敗:', e.message);
  process.exit(1);
});
