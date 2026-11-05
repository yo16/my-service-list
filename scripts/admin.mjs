#!/usr/bin/env node
/* my-service-list: ローカルの登録画面
 *
 * 自分の PC で動く小さな Web サーバー。ブラウザのフォームに入力すると、Supabase の services に
 * 行を追加・更新する。Supabase の secret key は .env から読み、ブラウザには渡さない。
 * 技術タグは入力しない。同期ジョブが GitHub の Topics と使用言語から取る。
 * Node 22 以上の標準機能だけで動く。npm の依存はない。
 *
 * 使い方:
 *   node scripts/admin.mjs             http://127.0.0.1:8787/ で起動し、ブラウザを開く
 *   node scripts/admin.mjs --no-open   ブラウザを開かない
 *
 * 環境変数（リポジトリ直下の .env に書けば読む。.env はコミットしない）:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   必須。鍵は secret key（sb_secret_...）か旧形式の service_role キー
 *   GH_READ_TOKEN                             任意。リポジトリの候補と情報の取得に使う。なければ gh CLI のログイン、それもなければ無認証（公開リポジトリのみ）
 *   GITHUB_OWNERS                             任意。無認証のときに候補を出す owner（カンマ区切り）。なければ git の origin から取る
 *   ADMIN_PORT                                任意。既定は 8787
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify, parseEnv } from 'node:util';
import { pickLanguages } from './lib/tags.mjs';
import { probeSite, readRepoSignals, detectInfra } from './lib/infra.mjs';

const execFileP = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_HTML = path.join(ROOT, 'admin', 'index.html');
const SITE_CSS = path.join(ROOT, 'site', 'style.css');

const args = new Set(process.argv.slice(2));
const OPEN_BROWSER = !args.has('--no-open');

const HOST = '127.0.0.1';
const PORT = Number(process.env.ADMIN_PORT || 8787);
const TOKEN = randomBytes(16).toString('hex'); // 起動のたびに変わる。画面に埋め込み、API 呼び出しで照合する

const STAGES = ['planning', 'developing', 'released', 'paused', 'retired'];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const log = (...a) => console.log('[admin]', ...a);
const warn = (...a) => console.warn('[admin] 警告:', ...a);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- .env ----------

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

function env(name, { required = true } = {}) {
  const v = process.env[name];
  if (!v && required) throw new Error(`環境変数 ${name} が設定されていません。リポジトリ直下の .env に書いてください（.env.example を参照）`);
  return v || null;
}

// ---------- Supabase ----------

function supabaseHeaders(extra = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  // 新形式の secret key（sb_secret_...）は JWT ではないので apikey ヘッダーだけで送る。
  // 旧形式の service_role キー（JWT）は従来どおり Authorization にも付ける。
  const headers = { apikey: key, Accept: 'application/json', ...extra };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function supabase(method, pathname, body) {
  const base = env('SUPABASE_URL').replace(/\/+$/, '');
  const extra = body === undefined ? {} : { 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const res = await fetch(`${base}/rest/v1${pathname}`, {
    method,
    headers: supabaseHeaders(extra),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const j = JSON.parse(text);
      message = [j.message, j.details, j.hint].filter(Boolean).join(' / ') || text;
    } catch {
      /* JSON でなければそのまま */
    }
    throw new HttpError(502, `Supabase の応答が ${res.status}: ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------- 入力の検証 ----------

function normalizeRepo(v) {
  if (!v) return '';
  const m = v.match(/^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  return v.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
}

function isHttpUrl(v) {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname) && !/\s/.test(v);
  } catch {
    return false;
  }
}

// 2025-02-30 のように、形は合っていても実在しない日付を弾く
function isRealDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function validateService(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '入力の形が不正です');
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const str = (k) => {
    const v = input[k];
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${k} の形が不正です`);
    return String(v).trim();
  };
  const out = {};
  if (!partial || has('name')) {
    out.name = str('name');
    if (!out.name) throw new HttpError(400, 'サービス名を入力してください');
  }
  if (!partial || has('stage')) {
    out.stage = str('stage') || 'planning';
    if (!STAGES.includes(out.stage)) throw new HttpError(400, `段階の値が不正です: ${out.stage}`);
  }
  if (has('github_repo')) {
    const v = normalizeRepo(str('github_repo'));
    if (v && !REPO_RE.test(v)) throw new HttpError(400, 'GitHub リポジトリは owner/repo の形で入力してください');
    out.github_repo = v || null;
  }
  if (has('url')) {
    const v = str('url');
    if (v && !isHttpUrl(v)) throw new HttpError(400, 'URL は http:// か https:// で始まる正しい形で入力してください');
    out.url = v || null;
  }
  if (has('description')) out.description = str('description') || null;
  if (has('note')) out.note = str('note') || null;
  if (has('released_on')) {
    const v = str('released_on');
    if (v && !isRealDate(v)) throw new HttpError(400, '公開日は実在する日付を YYYY-MM-DD の形で入力してください');
    out.released_on = v || null;
  }
  if (has('uptimerobot_monitor_id')) {
    const v = str('uptimerobot_monitor_id');
    if (v && !/^\d+$/.test(v)) throw new HttpError(400, 'UptimeRobot の monitor ID は数字で入力してください');
    out.uptimerobot_monitor_id = v ? Number(v) : null;
  }
  // カンマ区切りで何でも入れられる。同期のときに判定の結果へ足す。-Name は判定の結果から除く
  if (has('infra')) out.infra = [...new Set(str('infra').split(/[,、]/).map((s) => s.trim()).filter(Boolean))];
  return out;
}

// ---------- GitHub ----------

let ghAuth = { token: null, source: '未解決' };

async function resolveGitHubToken() {
  if (process.env.GH_READ_TOKEN) return { token: process.env.GH_READ_TOKEN, source: 'GH_READ_TOKEN' };
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  try {
    const { stdout } = await execFileP('gh', ['auth', 'token'], { timeout: 10000 });
    const token = stdout.trim();
    if (token) return { token, source: 'gh CLI のログイン' };
  } catch {
    /* gh がないか、未ログイン */
  }
  return { token: null, source: '無認証（公開リポジトリのみ）' };
}

async function ghFetch(pathname) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'my-service-list-admin',
  };
  if (ghAuth.token) headers.Authorization = `Bearer ${ghAuth.token}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new HttpError(502, `GitHub API ${pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { status: res.status, body: await res.json() };
}

function repoSummary(r) {
  return {
    fullName: r.full_name,
    url: r.html_url,
    description: r.description || null,
    homepage: r.homepage || null,
    private: Boolean(r.private),
    archived: Boolean(r.archived),
    pushedAt: r.pushed_at || null,
  };
}

async function listOwners() {
  const fromEnv = (process.env.GITHUB_OWNERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  try {
    const { stdout } = await execFileP('git', ['config', '--get', 'remote.origin.url'], { cwd: ROOT, timeout: 5000 });
    const m = stdout.trim().match(/github\.com[:/]([^/]+)\//);
    if (m) return [m[1]];
  } catch {
    /* git がない */
  }
  return [];
}

let repoListCache = null;

async function listRepos({ refresh = false } = {}) {
  if (repoListCache && !refresh) return repoListCache;
  const repos = [];
  if (ghAuth.token) {
    for (let page = 1; page <= 5; page++) {
      const { body } = await ghFetch(`/user/repos?per_page=100&sort=pushed&affiliation=owner,organization_member&page=${page}`);
      if (!Array.isArray(body) || !body.length) break;
      repos.push(...body.map(repoSummary));
      if (body.length < 100) break;
    }
  } else {
    for (const owner of await listOwners()) {
      for (let page = 1; page <= 3; page++) {
        const { body } = await ghFetch(`/users/${owner}/repos?per_page=100&sort=pushed&type=owner&page=${page}`);
        if (!Array.isArray(body) || !body.length) break;
        repos.push(...body.map(repoSummary));
        if (body.length < 100) break;
      }
    }
  }
  repos.sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)));
  repoListCache = repos;
  return repos;
}

async function repoDetail(fullName, siteUrl) {
  if (!REPO_RE.test(fullName)) throw new HttpError(400, 'GitHub リポジトリは owner/repo の形で指定してください');
  const { status, body } = await ghFetch(`/repos/${fullName}`);
  if (status === 404 || !body) return null;
  let languages = [];
  try {
    const l = await ghFetch(`/repos/${fullName}/languages`);
    languages = pickLanguages(l.body || {});
  } catch (e) {
    warn(`${fullName} の使用言語の取得に失敗しました: ${e.message}`);
  }
  const topics = Array.isArray(body.topics) ? body.topics : [];
  // 同期ジョブと同じ判定を見せる。URL の欄が空ならリポジトリの Website を使う
  const url = [siteUrl, body.homepage].find((u) => u && isHttpUrl(u)) || null;
  let signals = null;
  try {
    signals = await readRepoSignals(async (p) => (await ghFetch(p)).body, body.full_name);
  } catch (e) {
    warn(`${fullName} の中身を読めませんでした: ${e.message}`);
  }
  const infra = detectInfra({ site: await probeSite(url, { userAgent: 'my-service-list-admin' }), repo: signals, topics });
  return { ...repoSummary(body), topics, languages, infra };
}

// ---------- 同期ジョブの起動（gh CLI 経由） ----------

async function runGh(ghArgs) {
  try {
    const { stdout } = await execFileP('gh', ghArgs, { cwd: ROOT, timeout: 30000 });
    return stdout;
  } catch (e) {
    const detail = String(e.stderr || e.message || '').trim().split('\n')[0] || '原因不明';
    throw new HttpError(502, `gh の実行に失敗しました: ${detail}`);
  }
}

async function triggerSync() {
  await runGh(['workflow', 'run', 'sync.yml', '--ref', 'main']);
  return { ok: true };
}

async function syncStatus() {
  const out = await runGh(['run', 'list', '--workflow=sync.yml', '--limit', '1', '--json', 'status,conclusion,createdAt,url,event']);
  const arr = JSON.parse(out || '[]');
  return arr[0] || null;
}

// ---------- HTTP ----------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  res.end(data);
}

async function readJson(req) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Content-Type は application/json にしてください');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, '入力が大きすぎます');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON として読めません');
  }
}

// 同じ PC の他のサイトやプログラムから API を叩かれないようにする（DNS rebinding、別サイトからのフォーム送信）
function checkHost(req) {
  const host = req.headers.host || '';
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) throw new HttpError(403, 'Host が一致しません');
}

function checkToken(req) {
  if (req.headers['x-admin-token'] !== TOKEN) throw new HttpError(403, 'トークンが一致しません。画面を読み込み直してください');
}

async function route(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  checkHost(req); // トークン入りの HTML も、API と同じく Host を確かめてから返す

  if (req.method === 'GET' && p === '/') {
    const html = (await readFile(ADMIN_HTML, 'utf8')).replace('__ADMIN_TOKEN__', TOKEN);
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && p === '/style.css') {
    return send(res, 200, await readFile(SITE_CSS), 'text/css; charset=utf-8');
  }
  if (!p.startsWith('/api/')) throw new HttpError(404, 'Not Found');

  checkToken(req);

  if (req.method === 'GET' && p === '/api/config') {
    return send(res, 200, { supabaseHost: new URL(env('SUPABASE_URL')).host, githubAuth: ghAuth.source, stages: STAGES });
  }
  if (req.method === 'GET' && p === '/api/services') {
    return send(res, 200, await supabase('GET', '/services?select=*&order=id.asc'));
  }
  if (req.method === 'POST' && p === '/api/services') {
    const row = validateService(await readJson(req));
    const created = await supabase('POST', '/services', row);
    return send(res, 201, Array.isArray(created) ? created[0] : created);
  }
  const m = p.match(/^\/api\/services\/(\d+)$/);
  if (req.method === 'PATCH' && m) {
    const row = validateService(await readJson(req), { partial: true });
    if (!Object.keys(row).length) throw new HttpError(400, '変更がありません');
    const updated = await supabase('PATCH', `/services?id=eq.${m[1]}`, row);
    if (!Array.isArray(updated) || !updated.length) throw new HttpError(404, `#${m[1]} が見つかりません`);
    return send(res, 200, updated[0]);
  }
  if (req.method === 'GET' && p === '/api/github/repos') {
    return send(res, 200, await listRepos({ refresh: url.searchParams.has('refresh') }));
  }
  if (req.method === 'GET' && p === '/api/github/repo') {
    const fullName = normalizeRepo((url.searchParams.get('full_name') || '').trim());
    const detail = await repoDetail(fullName, (url.searchParams.get('url') || '').trim());
    if (!detail) throw new HttpError(404, `リポジトリ ${fullName} が見つかりません（名前が違うか、見る権限がありません）`);
    return send(res, 200, detail);
  }
  if (req.method === 'POST' && p === '/api/sync') {
    await readJson(req);
    return send(res, 202, await triggerSync());
  }
  if (req.method === 'GET' && p === '/api/sync/status') {
    return send(res, 200, await syncStatus());
  }
  throw new HttpError(404, 'Not Found');
}

function openBrowser(url) {
  const opts = { stdio: 'ignore', detached: true };
  let child;
  if (process.platform === 'win32') child = spawn('cmd', ['/c', 'start', '', url], opts);
  else if (process.platform === 'darwin') child = spawn('open', [url], opts);
  else child = spawn('xdg-open', [url], opts);
  child.on('error', () => {});
  child.unref();
}

async function main() {
  await loadDotEnv();
  env('SUPABASE_URL');
  env('SUPABASE_SERVICE_ROLE_KEY');
  ghAuth = await resolveGitHubToken();

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) warn(e.message);
      send(res, status, { error: e.message });
    });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`[admin] 失敗: ポート ${PORT} は使用中です。ADMIN_PORT=8788 のように別の番号を指定してください`);
    else console.error('[admin] 失敗:', e.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/`;
    log(`登録画面を起動しました: ${url}`);
    log(`Supabase: ${new URL(env('SUPABASE_URL')).host}、GitHub の認証: ${ghAuth.source}`);
    log('止めるときは Ctrl+C');
    if (OPEN_BROWSER) openBrowser(url);
  });
}

main().catch((e) => {
  console.error('[admin] 失敗:', e.message);
  process.exit(1);
});
