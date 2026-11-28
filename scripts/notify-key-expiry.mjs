#!/usr/bin/env node
/* my-service-list: 期限が近い API キーを、GitHub の Issue で知らせる
 *
 * 同期ジョブ（.github/workflows/sync.yml の notify）から、同期のたびに動かす。
 * Supabase の service_keys から、いちばん近い期限を読み、期限まで 30 日以内、7 日以内、期限切れのサービスがあれば、
 * このリポジトリに Issue を作る。GitHub がリポジトリの持ち主にメールなどで知らせる。
 * 同じ期限の同じ段階については 1 回だけ作る。記録は Issue の本文の目印に持ち、Supabase には書き戻さない。
 * 段階が進んだときと、キーを更新して期限が変わったときは、前の Issue を閉じる。
 * リポジトリは公開なので、Issue とログに出すのは通し番号と日数までにし、サービス名は出さない。
 * Node 22 以上の標準機能だけで動く。npm の依存はない。
 *
 * 使い方:
 *   node scripts/notify-key-expiry.mjs             Issue を作り、要らなくなった Issue を閉じる
 *   node scripts/notify-key-expiry.mjs --dry-run   何も書き換えず、作る予定と閉じる予定だけを出す
 *
 * 環境変数:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   必須
 *   GITHUB_TOKEN                              必須。このリポジトリの Issue を読み書きできるトークン（Actions の github.token）
 *   GITHUB_REPOSITORY                         必須。owner/repo の形（Actions では自動で入る）
 */

import { LABEL, issueContent, planNotifications, todayJst } from './lib/key-expiry.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const log = (...a) => console.log('[key-expiry]', ...a);
const warn = (...a) => console.warn('[key-expiry] 警告:', ...a);

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が設定されていません`);
  return v;
}

/** service_keys の行。表がまだ無いときは null */
async function fetchKeys() {
  const base = env('SUPABASE_URL').replace(/\/+$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  // 新形式の secret key（sb_secret_...）は apikey ヘッダーだけで送る。旧形式の service_role キーは Authorization にも付ける
  const headers = { apikey: key, Accept: 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${base}/rest/v1/service_keys?select=service_id,nearest_expiry`, { headers });
  if (res.ok) return res.json();
  let code = '';
  try {
    code = String(JSON.parse(await res.text()).code || '');
  } catch {
    /* 本文はログに出さない */
  }
  if (res.status === 404 || ['PGRST205', '42P01'].includes(code)) return null;
  throw new Error(`Supabase の応答が ${res.status}${code ? `（${code}）` : ''}`);
}

async function github(method, pathname, body) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'my-service-list-key-expiry',
      Authorization: `Bearer ${env('GITHUB_TOKEN')}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = String(JSON.parse(await res.text()).message || '').slice(0, 120);
    } catch {
      /* 本文はログに出さない */
    }
    const err = new Error(`GitHub API の応答が ${res.status}${detail ? `（${detail}）` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** これまでの通知の Issue（閉じたものを含む）。プルリクエストは除く */
async function fetchIssues(repo) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await github('GET', `/repos/${repo}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    all.push(...batch.filter((i) => !i.pull_request).map((i) => ({ number: i.number, state: i.state, body: i.body || '' })));
    if (batch.length < 100) break;
  }
  return all;
}

async function createIssue(repo, content) {
  const owner = repo.split('/')[0];
  try {
    // 持ち主を担当にして、通知が確実に届くようにする
    return await github('POST', `/repos/${repo}/issues`, { ...content, labels: [LABEL], assignees: [owner] });
  } catch (e) {
    if (e.status !== 422) throw e;
    // 持ち主が組織のときなど、担当にできないことがある。担当なしで作り直す
    return github('POST', `/repos/${repo}/issues`, { ...content, labels: [LABEL] });
  }
}

async function main() {
  const repo = env('GITHUB_REPOSITORY');
  const keys = await fetchKeys();
  if (!keys) {
    log('service_keys はまだ無いので、何もしません');
    return;
  }
  const { create, close } = planNotifications(keys, await fetchIssues(repo), todayJst());
  log(`キーの行 ${keys.length} 件を調べました。作る通知 ${create.length} 件、閉じる Issue ${close.length} 件`);

  for (const c of create) {
    const content = issueContent(c);
    if (DRY_RUN) {
      log(`作る予定: ${content.title}`);
      continue;
    }
    const issue = await createIssue(repo, content);
    log(`作りました: Issue #${issue.number}（${content.title}）`);
  }
  for (const number of close) {
    if (DRY_RUN) {
      log(`閉じる予定: Issue #${number}`);
      continue;
    }
    try {
      await github('POST', `/repos/${repo}/issues/${number}/comments`, { body: '期限の状態が変わったので閉じます（段階が進んだか、キーが更新されました）。' });
      await github('PATCH', `/repos/${repo}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
      log(`閉じました: Issue #${number}`);
    } catch (e) {
      warn(`Issue #${number} を閉じられませんでした: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error('[key-expiry] 失敗:', e.message);
  process.exit(1);
});
