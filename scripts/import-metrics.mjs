#!/usr/bin/env node
/* my-service-list: 費用、収益、キーの本数と期限の取り込み
 *
 * 決まった形の JSON ファイル（docs/design.md の 3.6）を検証し、Supabase の
 * service_monthly、shared_monthly_costs、service_keys に upsert する。
 * 検証でエラーが 1 つでもあれば、何も書き込まずに終了コード 1 で止まる。
 * 同じファイルを何度取り込んでも、同じ行を上書きするだけで結果は変わらない。
 * 費用は取得元（JSON の source）ごとに持つ。同じ取得元をもう一度取り込むと、その取得元の分だけが置き換わる。
 * Node 22 以上の標準機能だけで動く。npm の依存はない。
 *
 * 使い方:
 *   node scripts/import-metrics.mjs <ファイル.json>             検証して書き込む
 *   node scripts/import-metrics.mjs <ファイル.json> --dry-run   書き込まず、検証と書き込む予定の件数だけを出す
 *
 * --dry-run でも、登録済みの通し番号と区分を確かめるために Supabase を読む（読むだけ）。
 *
 * 環境変数（リポジトリ直下の .env に書けば読む。登録画面と同じ）:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   必須
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { validatePayload } from './lib/metrics.mjs';
import { writeMetrics } from './lib/metrics-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const files = argv.filter((a) => !a.startsWith('--'));
const unknownFlags = argv.filter((a) => a.startsWith('--') && a !== '--dry-run');

// 金額やサービス名は出さない。件数と、JSON の中の位置（services[2] など）だけを出す
const log = (...a) => console.log('[import]', ...a);

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
    headers.Prefer = 'resolution=merge-duplicates,return=minimal';
  }
  const res = await fetch(`${base}/rest/v1${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      message = [j.code, j.message, j.hint].filter(Boolean).join(' / ') || message;
    } catch {
      /* JSON でなければそのまま */
    }
    // 表が無い（404、PGRST205、42P01）か、あとから足した列が無い（42703、PGRST204）
    const missing = res.status === 404 || /\b(PGRST204|PGRST205|42P01|42703)\b/.test(message);
    const hint = missing ? '（表や列がまだ無いなら、supabase/schema.sql を SQL Editor で実行してください。何度実行しても同じ結果になります）' : '';
    throw new Error(`Supabase の応答が ${res.status}: ${message}${hint}`);
  }
  return text ? JSON.parse(text) : null;
}

const io = {
  get: (pathname) => supabase('GET', pathname),
  upsert: (table, conflict, rows) => supabase('POST', `/${table}?on_conflict=${conflict}`, rows),
};

async function main() {
  if (unknownFlags.length) throw new Error(`知らないオプションです: ${unknownFlags.join(' ')}`);
  if (files.length !== 1) throw new Error('使い方: node scripts/import-metrics.mjs <ファイル.json> [--dry-run]');

  let input;
  try {
    input = JSON.parse((await readFile(path.resolve(files[0]), 'utf8')).replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`ファイルを JSON として読めません: ${e.message}`);
  }

  await loadDotEnv();
  const serviceIds = (await supabase('GET', '/services?select=id')).map((r) => r.id);
  const categoryKeys = (await supabase('GET', '/service_categories?select=key')).map((r) => r.key);

  const { errors, rows } = validatePayload(input, { serviceIds, categoryKeys });
  if (errors.length) {
    for (const e of errors) console.error(`[import] エラー: ${e}`);
    throw new Error(`検証で ${errors.length} 件のエラーがありました。何も書き込んでいません`);
  }

  const counts = `service_monthly ${rows.monthly_inputs.length} 行、shared_monthly_costs ${rows.shared_monthly_costs.length} 行、service_keys ${rows.service_keys.length} 行`;
  if (DRY_RUN) {
    log(`--dry-run: 検証を通りました（${input.month}）。書き込む予定: ${counts}。何も書き込んでいません`);
    return;
  }

  try {
    await writeMetrics(io, rows);
  } catch (e) {
    if (!e.table) throw e;
    const before = e.done.length ? `${e.done.join('、')} は書き込み済みです。` : 'まだ何も書き込んでいません。';
    throw new Error(`${e.table} の書き込みに失敗しました。${before}原因を直して同じファイルをもう一度取り込めば、同じ行が上書きされます: ${e.message}`);
  }
  log(`取り込みました（${input.month}）: ${counts}`);
  log('一覧ページには、次の同期（最長 1 時間）か、登録画面の「一覧ページに反映する」で出ます');
}

main().catch((e) => {
  console.error('[import] 失敗:', e.message);
  process.exit(1);
});
