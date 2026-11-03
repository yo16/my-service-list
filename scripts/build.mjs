#!/usr/bin/env node
/* my-service-list: 同期ジョブ
 *
 * Supabase の services を読み、GitHub API（リポジトリ情報、Topics、使用言語、Release）と UptimeRobot API v3 で派生データを付け、
 * パスフレーズで暗号化した data.enc.json と site/ の中身を dist/ に書き出す。
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
 *   GH_READ_TOKEN                             任意。なければ GITHUB_TOKEN、それもなければ無認証（公開リポジトリのみ、60 回/時）
 *   UPTIMEROBOT_API_KEY                       任意。なければ全件「未監視」
 */

import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickLanguages, mergeTags } from './lib/tags.mjs';

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

async function fetchServices() {
  const base = env('SUPABASE_URL').replace(/\/+$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  // 新形式の secret key（sb_secret_...）は JWT ではないので apikey ヘッダーだけで送る。
  // 旧形式の service_role キー（JWT）は従来どおり Authorization にも付ける。
  const headers = { apikey: key, Accept: 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${base}/rest/v1/services?select=*&order=id.asc`, { headers });
  if (!res.ok) throw new Error(`Supabase の読み取りに失敗しました: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- GitHub ----------

const GH_TOKEN = env('GH_READ_TOKEN', { required: false }) || env('GITHUB_TOKEN', { required: false });

async function ghGet(pathname) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'my-service-list-sync',
  };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
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
  const repo = await ghGet(`/repos/${fullName}`);
  if (!repo) return null;
  const releases = (await ghGet(`/repos/${fullName}/releases?per_page=100`)) || [];
  const languages = pickLanguages((await ghGet(`/repos/${fullName}/languages`)) || {});
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

function normalizeUrl(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    return `${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function uptimeRatio24h(monitor) {
  const hist = monitor && monitor.lastDayUptimes && Array.isArray(monitor.lastDayUptimes.histogram)
    ? monitor.lastDayUptimes.histogram
    : [];
  const values = hist.map((h) => Number(h.uptime)).filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(mean * 100) / 100;
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

function buildService(row, repo, monitor) {
  const url = row.url || (repo && repo.homepage) || null;
  return {
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
    releasedOn: row.released_on || (repo && repo.firstReleaseAt ? repo.firstReleaseAt.slice(0, 10) : null),
    uptime: monitor
      ? {
        monitorId: monitor.id,
        status: monitor.status,
        ratio24h: uptimeRatio24h(monitor),
        lastIncidentAt: monitor.lastIncident && monitor.lastIncident.startedAt ? monitor.lastIncident.startedAt : null,
      }
      : null,
    note: row.note || null,
  };
}

async function buildData() {
  if (SAMPLE_MODE) {
    log('--sample: site/sample/data.json を使います');
    const sample = JSON.parse(await readFile(SAMPLE_FILE, 'utf8'));
    return { ...sample, generatedAt: new Date().toISOString() };
  }

  const rows = await fetchServices();
  log(`Supabase から ${rows.length} 件を読みました`);

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
        if (!repo) warn(`#${row.id}: GitHub リポジトリが見つかりません（非公開なら GH_READ_TOKEN が必要です。名前も確かめてください）`);
      } catch (e) {
        warn(`#${row.id}: GitHub の取得に失敗しました: ${e.message}`);
      }
    }
    const url = row.url || (repo && repo.homepage) || null;
    const monitor = monitors.length ? matchMonitor(row, monitors, url) : null;
    services.push(buildService(row, repo, monitor));
  }

  return { generatedAt: new Date().toISOString(), services };
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
  const down = data.services.filter((s) => s.uptime && (s.uptime.status === 'DOWN' || s.uptime.status === 'LOOKS_DOWN')).length;
  const breakdown = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
  log(`dist/ に書き出しました: ${data.services.length} 件${breakdown ? `（${breakdown}）` : ''}、監視あり ${monitored} 件、停止 ${down} 件`);
}

main().catch((e) => {
  console.error('[sync] 失敗:', e.message);
  process.exit(1);
});
