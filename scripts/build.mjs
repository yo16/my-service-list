#!/usr/bin/env node
/* my-service-list: 同期ジョブ
 *
 * Supabase の services を読み、GitHub API（リポジトリ情報、Topics、使用言語、Release、ファイル）、UptimeRobot API v3、
 * サイトの応答ヘッダーで派生データを付け、パスフレーズで暗号化した data.enc.json と site/ の中身を dist/ に書き出す。
 * Node 22 以上の標準機能だけで動く（fetch、crypto.subtle）。npm の依存はない。
 *
 * 使い方:
 *   node scripts/build.mjs            通常の同期
 *   node scripts/build.mjs --sample   Supabase 等を呼ばず site/sample/data.json を暗号化する（動作確認用）
 *   node scripts/build.mjs --plain    dist/data.json に暗号化前の JSON も書く（デバッグ用。dist/ はコミットしない）
 *
 * 環境変数:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   必須（--sample のときは不要）。鍵は secret key（sb_secret_...）か旧形式の service_role キー
 *   SITE_PASSPHRASE                           必須
 *   GH_READ_TOKEN_1 〜 GH_READ_TOKEN_9         任意。持ち主ごとのトークン。値は「持ち主=トークン」（例: my-org=github_pat_xxx）
 *   GH_READ_TOKEN                             任意。持ち主ごとのトークンがないときに使う。なければ GITHUB_TOKEN、それもなければ無認証（公開リポジトリのみ、60 回/時）
 *   UPTIMEROBOT_API_KEY                       任意。なければ全件「未監視」
 */

import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickLanguages, mergeTags } from './lib/tags.mjs';
import { probeSite, readRepoSignals, detectInfra, applyManualInfra } from './lib/infra.mjs';
import { monthOf, previousMonth } from './lib/metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = path.join(ROOT, 'site');
const DIST_DIR = path.join(ROOT, 'dist');
const SAMPLE_FILE = path.join(SITE_DIR, 'sample', 'data.json');

const args = new Set(process.argv.slice(2));
const SAMPLE_MODE = args.has('--sample');
const WRITE_PLAIN = args.has('--plain');

const PBKDF2_ITERATIONS = 600000;

// 公開リポジトリの Actions ログは誰でも読める。サービス名、URL、リポジトリ名はログに出さず、通し番号（#1 など）だけで示す。
const log = (...a) => console.log('[sync]', ...a);
const warn = (...a) => console.warn('[sync] 警告:', ...a);

function env(name, { required = true } = {}) {
  const v = process.env[name];
  if (!v && required) throw new Error(`環境変数 ${name} が設定されていません`);
  return v || null;
}

// ---------- Supabase ----------

function supabaseGet(pathname) {
  const base = env('SUPABASE_URL').replace(/\/+$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  // 新形式の secret key（sb_secret_...）は JWT ではないので apikey ヘッダーだけで送る。
  // 旧形式の service_role キー（JWT）は従来どおり Authorization にも付ける。
  const headers = { apikey: key, Accept: 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  return fetch(`${base}/rest/v1${pathname}`, { headers });
}

async function fetchServices() {
  const res = await supabaseGet('/services?select=*&order=id.asc');
  if (!res.ok) throw new Error(`Supabase の読み取りに失敗しました: ${res.status} ${await res.text()}`);
  return res.json();
}

// あとから足した表（区分、費用と収益、共通の費用、キー）を読む。
// 表がまだ無いときや読めないときは null を返し、ジョブは止めない（その分を出力に含めないだけ）。
// スキーマの適用とコードの反映の順番が前後しても、今までどおりの一覧を出し続けるため。
async function fetchOptional(table, query) {
  try {
    const res = await supabaseGet(`/${table}?${query}`);
    if (res.ok) return await res.json();
    let code = '';
    try {
      code = String(JSON.parse(await res.text()).code || '');
    } catch {
      /* 本文はログに出さない */
    }
    // PGRST205 と 42P01 は表が無い、42703 は列が無い
    if (res.status === 404 || ['PGRST205', '42P01', '42703'].includes(code)) {
      log(`${table} はまだ無いので、その分を含めずに続けます（supabase/schema.sql を実行すると出ます）`);
    } else {
      warn(`${table} を読めないので、その分を含めずに続けます: 応答が ${res.status}${code ? `（${code}）` : ''}`);
    }
  } catch (e) {
    warn(`${table} を読めないので、その分を含めずに続けます: ${e.message}`);
  }
  return null;
}

// 今月と先月（日本時間）の費用と収益、共通の費用、キー、区分をまとめて読む
async function fetchMetrics(now = new Date()) {
  const current = monthOf(now);
  const previous = previousMonth(current);
  const range = `month=in.(${previous}-01,${current}-01)`;
  const [categories, monthly, shared, keys] = await Promise.all([
    fetchOptional('service_categories', 'select=key,label,sort_order&order=sort_order.asc,key.asc'),
    fetchOptional('service_monthly', `select=service_id,month,cost_jpy,revenue_jpy,breakdown&${range}`),
    fetchOptional('shared_monthly_costs', `select=month,provider,account,category,cost_jpy&${range}&order=month.desc,provider.asc,account.asc`),
    fetchOptional('service_keys', 'select=service_id,key_count,nearest_expiry,checked_at'),
  ]);
  return { months: { current, previous }, categories, monthly, shared, keys };
}

// ---------- GitHub ----------

// fine-grained PAT は 1 本で 1 つの持ち主（個人か 1 つの組織）しか読めないので、持ち主ごとのトークンを使い分ける。
// 持ち主の名前をワークフローに書かずに済むよう、番号付きの Secret（GH_READ_TOKEN_1〜GH_READ_TOKEN_9）の値に
// 「持ち主=トークン」と書く。持ち主を増やすときは、空いている番号に足すだけでよい。
// Secrets 全体（toJSON(secrets)）をジョブに渡すと、実行が action_required で止まるので使わない。
const OWNER_TOKEN_SLOTS = 9;
const OWNER_TOKENS = new Map(
  Array.from({ length: OWNER_TOKEN_SLOTS }, (_, i) => String(process.env[`GH_READ_TOKEN_${i + 1}`] || '').trim())
    .filter((v) => v.includes('='))
    .map((v) => {
      const i = v.indexOf('=');
      return [v.slice(0, i).trim().toLowerCase(), v.slice(i + 1).trim()];
    })
    .filter(([owner, token]) => owner && token),
);

/** リポジトリ（owner/repo）を読むためのトークン。持ち主ごとのもの → GH_READ_TOKEN → GITHUB_TOKEN の順 */
function tokenFor(fullName) {
  const owner = String(fullName).split('/')[0].toLowerCase();
  return OWNER_TOKENS.get(owner) || env('GH_READ_TOKEN', { required: false }) || env('GITHUB_TOKEN', { required: false });
}

async function ghGet(pathname, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'my-service-list-sync',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${pathname}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    let detail = '';
    try {
      detail = String(JSON.parse(await res.text()).message || '').slice(0, 120);
    } catch {
      /* 本文はログに出さない */
    }
    throw new Error(`GitHub API の応答が ${res.status}${detail ? `（${detail}）` : ''}`);
  }
  return res.json();
}

async function fetchRepo(fullName) {
  const token = tokenFor(fullName);
  const repo = await ghGet(`/repos/${fullName}`, token);
  if (!repo) return null;
  const releases = (await ghGet(`/repos/${fullName}/releases?per_page=100`, token)) || [];
  const languages = pickLanguages((await ghGet(`/repos/${fullName}/languages`, token)) || {});
  const published = releases
    .filter((r) => !r.draft && r.published_at)
    .sort((a, b) => a.published_at.localeCompare(b.published_at));
  const first = published[0] || null;
  const latest = published[published.length - 1] || null;
  return {
    fullName: repo.full_name,
    url: repo.html_url,
    homepage: repo.homepage || null,
    description: repo.description || null,
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    languages,
    pushedAt: repo.pushed_at || null,
    archived: Boolean(repo.archived),
    private: Boolean(repo.private),
    firstReleaseAt: first ? first.published_at : null,
    latestRelease: latest ? { tag: latest.tag_name, publishedAt: latest.published_at } : null,
  };
}

// ---------- UptimeRobot v3 ----------

const UR_BASE = 'https://api.uptimerobot.com/v3';

async function fetchMonitors() {
  const key = env('UPTIMEROBOT_API_KEY', { required: false });
  if (!key) {
    warn('UPTIMEROBOT_API_KEY がないので、死活はすべて「未監視」にします');
    return [];
  }
  const all = [];
  let url = `${UR_BASE}/monitors?limit=200`;
  for (let page = 0; url && page < 50; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`UptimeRobot API: ${res.status} ${await res.text()}`);
    const body = await res.json();
    all.push(...(Array.isArray(body.data) ? body.data : []));
    const next = body.nextLink || null;
    url = next && next.startsWith('/') ? `${UR_BASE}${next}` : next;
  }
  return all;
}

// 値を含めず、項目名と型だけを文字列にする。公開ログに出してよい形にするため
function describeShape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? `[${v.length}件 ${describeShape(v[0], depth + 1)}]` : '[0件]';
  if (typeof v !== 'object') return typeof v;
  if (depth >= 3) return 'object';
  return `{${Object.entries(v).map(([k, x]) => `${k}: ${describeShape(x, depth + 1)}`).join(', ')}}`;
}

function normalizeUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    return `${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

// 直近 24 時間の稼働率（0〜100 の百分率）を監視ごとの統計 API で取る。
// 監視一覧の lastDayUptimes.histogram は実際の応答では空だったので使わない。
// 無料プランは 10 回/分なので、429 が返ったら Retry-After だけ待って 1 回やり直す。
async function fetchUptimeRatio24h(monitorId) {
  const key = env('UPTIMEROBOT_API_KEY');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${UR_BASE}/monitors/${monitorId}/stats/uptime`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (res.status === 429 && attempt === 0) {
      const waitSec = Math.min(Number(res.headers.get('retry-after')) || 60, 70);
      log(`UptimeRobot のレート制限に達したので ${waitSec} 秒待ちます`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`応答が ${res.status}`);
    const body = await res.json();
    const ratio = Number(body.uptime);
    if (body.uptime === null || body.uptime === undefined || !Number.isFinite(ratio)) {
      throw new Error(`uptime がありません。応答の形: ${describeShape(body)}`);
    }
    return Math.round(ratio * 100) / 100;
  }
}

function matchMonitor(row, monitors, serviceUrl) {
  if (row.uptimerobot_monitor_id != null) {
    const byId = monitors.find((m) => String(m.id) === String(row.uptimerobot_monitor_id));
    if (byId) return byId;
    warn(`#${row.id}: 指定した monitor ID が UptimeRobot に見つかりません`);
  }
  const target = normalizeUrl(serviceUrl);
  if (!target) return null;
  return monitors.find((m) => normalizeUrl(m.url) === target) || null;
}

// ---------- 結合 ----------

// インフラを決める。判定の結果に手入力（Supabase の infra）を重ねる
async function resolveInfra(row, repo, url) {
  const site = await probeSite(url, { userAgent: 'my-service-list-sync' });
  if (url && !site) warn(`#${row.id}: サイトに接続できないので、応答からは配信先を判定しません`);
  let signals = null;
  if (repo) {
    try {
      const token = tokenFor(repo.fullName);
      signals = await readRepoSignals((p) => ghGet(p, token), repo.fullName);
    } catch (e) {
      warn(`#${row.id}: リポジトリの中身を読めないので、ファイルからは判定しません: ${e.message}`);
    }
  }
  return applyManualInfra(detectInfra({ site, repo: signals, topics: repo ? repo.topics : [] }), row.infra);
}

// 1 か月分の費用と収益。行が無ければ null（0 円とは区別する）
function monthMoney(rows, serviceId, month) {
  const r = rows.find((x) => String(x.service_id) === String(serviceId) && String(x.month).slice(0, 7) === month);
  if (!r) return null;
  return { costJpy: r.cost_jpy, revenueJpy: r.revenue_jpy, breakdown: r.breakdown || null };
}

// 区分、費用と収益、キーをサービスに足す。読めなかった表の分は項目ごと足さない（今までどおりの形になる）
function addMetrics(service, row, metrics) {
  if (!metrics) return service;
  if (metrics.categories && row.category !== undefined) service.category = row.category || null;
  if (metrics.monthly) {
    service.money = {
      current: monthMoney(metrics.monthly, row.id, metrics.months.current),
      previous: monthMoney(metrics.monthly, row.id, metrics.months.previous),
    };
  }
  if (metrics.keys) {
    const k = metrics.keys.find((x) => String(x.service_id) === String(row.id));
    service.keys = k ? { count: k.key_count, nearestExpiry: k.nearest_expiry || null, checkedAt: k.checked_at || null } : null;
  }
  return service;
}

function buildService(row, repo, monitor, ratio24h, infra, metrics = null) {
  const url = row.url || (repo && repo.homepage) || null;
  return addMetrics({
    id: row.id,
    name: row.name,
    description: row.description || (repo && repo.description) || null,
    stage: row.stage,
    url,
    repo: repo
      ? {
        fullName: repo.fullName,
        url: repo.url,
        private: repo.private,
        archived: repo.archived,
        pushedAt: repo.pushedAt,
        latestRelease: repo.latestRelease,
      }
      : null,
    // Topics（手で付けた分類）→ 使用言語（自動）→ Supabase の tags（上書き・追加分）の順。重複は大文字小文字を無視して除く
    tags: mergeTags(repo ? repo.topics : [], repo ? repo.languages : [], Array.isArray(row.tags) ? row.tags : []),
    infra,
    releasedOn: row.released_on || (repo && repo.firstReleaseAt ? repo.firstReleaseAt.slice(0, 10) : null),
    uptime: monitor
      ? {
        monitorId: monitor.id,
        status: monitor.status,
        ratio24h,
        lastIncidentAt: monitor.lastIncident && monitor.lastIncident.startedAt ? monitor.lastIncident.startedAt : null,
      }
      : null,
    note: row.note || null,
  }, row, metrics);
}

async function buildData() {
  if (SAMPLE_MODE) {
    log('--sample: site/sample/data.json を使います');
    const sample = JSON.parse(await readFile(SAMPLE_FILE, 'utf8'));
    return { ...sample, generatedAt: new Date().toISOString() };
  }

  const rows = await fetchServices();
  log(`Supabase から ${rows.length} 件を読みました`);
  log(`持ち主ごとの GitHub トークン: ${OWNER_TOKENS.size} 本`);

  // 金額はログに出さない。件数だけを出す
  const metrics = await fetchMetrics();
  const n = (rows_) => (rows_ ? `${rows_.length} 行` : 'なし');
  log(`区分 ${n(metrics.categories)}、費用と収益 ${n(metrics.monthly)}、共通の費用 ${n(metrics.shared)}、キー ${n(metrics.keys)}`);

  let monitors = [];
  try {
    monitors = await fetchMonitors();
    log(`UptimeRobot の監視 ${monitors.length} 件を読みました`);
  } catch (e) {
    warn(`UptimeRobot の取得に失敗したので、死活はすべて「未監視」にします: ${e.message}`);
  }

  const services = [];
  for (const row of rows) {
    let repo = null;
    if (row.github_repo) {
      try {
        repo = await fetchRepo(row.github_repo);
        if (!repo) warn(`#${row.id}: GitHub リポジトリが見つかりません（非公開なら、GH_READ_TOKEN_1〜9 のどれかにその持ち主のトークンを書くか、GH_READ_TOKEN が必要です。名前も確かめてください）`);
      } catch (e) {
        warn(`#${row.id}: GitHub の取得に失敗しました: ${e.message}`);
      }
    }
    const url = row.url || (repo && repo.homepage) || null;
    const monitor = monitors.length ? matchMonitor(row, monitors, url) : null;
    let ratio24h = null;
    if (monitor) {
      try {
        ratio24h = await fetchUptimeRatio24h(monitor.id);
      } catch (e) {
        warn(`#${row.id}: 稼働率の取得に失敗しました: ${e.message}`);
      }
    }
    const infra = await resolveInfra(row, repo, url);
    services.push(buildService(row, repo, monitor, ratio24h, infra, metrics));
  }

  const data = { generatedAt: new Date().toISOString(), services };
  if (metrics.categories) data.categories = metrics.categories.map((c) => ({ key: c.key, label: c.label }));
  if (metrics.monthly || metrics.shared) data.months = metrics.months;
  if (metrics.shared) {
    data.sharedCosts = metrics.shared.map((c) => ({
      month: String(c.month).slice(0, 7),
      provider: c.provider,
      account: c.account,
      category: c.category || null,
      costJpy: c.cost_jpy,
    }));
  }
  return data;
}

// ---------- 暗号化 ----------

async function encrypt(plaintext, passphrase) {
  const subtle = globalThis.crypto.subtle;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

// ---------- 出力 ----------

async function writeDist(data) {
  const passphrase = env('SITE_PASSPHRASE');
  if (passphrase.length < 12) warn('SITE_PASSPHRASE が短いです。20 文字以上を勧めます');

  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });
  await cp(SITE_DIR, DIST_DIR, {
    recursive: true,
    filter: (src) => !src.startsWith(path.join(SITE_DIR, 'sample')),
  });
  await writeFile(path.join(DIST_DIR, '.nojekyll'), '');

  const plaintext = JSON.stringify(data);
  const enc = await encrypt(plaintext, passphrase);
  await writeFile(path.join(DIST_DIR, 'data.enc.json'), JSON.stringify(enc));
  if (WRITE_PLAIN) {
    await writeFile(path.join(DIST_DIR, 'data.json'), JSON.stringify(data, null, 2));
    warn('--plain: dist/data.json に暗号化前の JSON を書きました。コミットしないでください');
  }
}

async function main() {
  const data = await buildData();
  await writeDist(data);
  const counts = {};
  for (const s of data.services) counts[s.stage] = (counts[s.stage] || 0) + 1;
  const monitored = data.services.filter((s) => s.uptime).length;
  const withRatio = data.services.filter((s) => s.uptime && typeof s.uptime.ratio24h === 'number').length;
  const down = data.services.filter((s) => s.uptime && (s.uptime.status === 'DOWN' || s.uptime.status === 'LOOKS_DOWN')).length;
  const breakdown = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
  log(`dist/ に書き出しました: ${data.services.length} 件${breakdown ? `（${breakdown}）` : ''}、監視あり ${monitored} 件、稼働率あり ${withRatio} 件、停止 ${down} 件`);
}

main().catch((e) => {
  console.error('[sync] 失敗:', e.message);
  process.exit(1);
});
