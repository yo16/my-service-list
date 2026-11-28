/* my-service-list: 費用、収益、キーの本数と期限を Supabase に書く手順
 *
 * 取り込みのスクリプト（scripts/import-metrics.mjs）と登録画面（scripts/admin.mjs）が共有する。
 * 通信そのものは呼び出し側の関数に任せ、ここは「何を読んで、どの表に何を書くか」だけを持つ。
 */

import { mergeMonthly, editSource, sourcesOf, sourceNameError, isMonth } from './metrics.mjs';

/** service_monthly から読む列。取得元ごとの費用（cost_sources）を重ねるために、今の行を丸ごと読む */
export const MONTHLY_COLUMNS = 'service_id,month,cost_jpy,revenue_jpy,breakdown,source,cost_sources,updated_at';

/**
 * validatePayload が返した rows を、service_monthly、shared_monthly_costs、service_keys の順に書く。
 * 3 つの表への書き込みは 1 つの取引にはなっていない。途中で失敗したときは、投げるエラーの
 * table に失敗した表、done に書き終えた表の名前を入れる。同じ内容をもう一度書けば、同じ行が上書きされてそろう。
 *
 * @param {{ get: (pathname: string) => Promise<object[]>, upsert: (table: string, conflict: string, rows: object[]) => Promise<unknown> }} io
 * @param {{ monthly_inputs: object[], shared_monthly_costs: object[], service_keys: object[] }} rows
 * @returns {Promise<Record<string, number>>} 表ごとの、書いた行数
 */
export async function writeMetrics({ get, upsert }, rows) {
  const counts = { service_monthly: 0, shared_monthly_costs: 0, service_keys: 0 };
  const done = [];
  const step = async (table, write) => {
    try {
      counts[table] = await write();
    } catch (e) {
      e.table = table;
      e.done = [...done];
      throw e;
    }
    if (counts[table]) done.push(table);
  };

  await step('service_monthly', async () => {
    const inputs = rows.monthly_inputs;
    if (!inputs.length) return 0;
    // 費用は取得元ごとに重ねるので、先に今の行を読む。1 回の取り込みは 1 か月分
    const ids = inputs.map((i) => i.service_id).join(',');
    const existing = await get(`/service_monthly?select=${MONTHLY_COLUMNS}&month=eq.${inputs[0].month}&service_id=in.(${ids})`);
    const byId = new Map(existing.map((r) => [Number(r.service_id), r]));
    await upsert('service_monthly', 'service_id,month', inputs.map((i) => mergeMonthly(byId.get(i.service_id) || null, i)));
    return inputs.length;
  });

  await step('shared_monthly_costs', async () => {
    if (!rows.shared_monthly_costs.length) return 0;
    await upsert('shared_monthly_costs', 'month,provider,account', rows.shared_monthly_costs);
    return rows.shared_monthly_costs.length;
  });

  await step('service_keys', async () => {
    if (!rows.service_keys.length) return 0;
    await upsert('service_keys', 'service_id', rows.service_keys);
    return rows.service_keys.length;
  });

  return counts;
}

/**
 * ある月の、取得元 1 つの名前を付け替えるか、取得元 1 つを消す。その月の、その取得元を持つすべてのサービスの行を書き直す。
 * 入力の誤りや、付け替え先の名前がすでにある行が 1 つでもあれば、何も書かずに、invalid が true のエラーを投げる。
 *
 * @param {{ get: (pathname: string) => Promise<object[]>, upsert: (table: string, conflict: string, rows: object[]) => Promise<unknown> }} io
 * @param {{ month: string, action: 'rename'|'remove', source: string, to?: string, now?: Date }} edit month は YYYY-MM
 * @returns {Promise<{ service_monthly: number, cost_jpy: number }>} 書いた行数と、その取得元に入っていた金額の合計
 */
export async function editSources({ get, upsert }, { month, action, source, to, now = new Date() }) {
  const invalid = (message) => Object.assign(new Error(message), { invalid: true });
  if (!isMonth(month)) throw invalid('月は YYYY-MM の形で指定してください');
  if (action !== 'rename' && action !== 'remove') throw invalid('操作は rename か remove で指定してください');
  if (typeof source !== 'string' || !source) throw invalid('取得元を選んでください');
  let target;
  if (action === 'rename') {
    const error = sourceNameError(to);
    if (error) throw invalid(error);
    target = to.trim();
    if (target === source) throw invalid('今と同じ名前です');
  }

  const existing = await get(`/service_monthly?select=${MONTHLY_COLUMNS}&month=eq.${month}-01`);
  const holders = existing.filter((r) => Object.prototype.hasOwnProperty.call(sourcesOf(r), source));
  if (!holders.length) throw invalid(`${month} に、取得元「${source}」の費用はありません`);
  if (action === 'rename') {
    const taken = holders.filter((r) => Object.prototype.hasOwnProperty.call(sourcesOf(r), target));
    if (taken.length) {
      const ids = taken.map((r) => `#${String(r.service_id).padStart(3, '0')}`).join('、');
      throw invalid(`付け替え先の名前「${target}」の費用が、すでに入っているサービスがあります（${ids}）。金額が二重にならないよう、どちらかを消してから付け替えてください`);
    }
  }

  const updated_at = now.toISOString();
  const rows = holders.map((r) => editSource(r, { action, source, to: target, updated_at }));
  await upsert('service_monthly', 'service_id,month', rows);
  return {
    service_monthly: rows.length,
    cost_jpy: holders.reduce((sum, r) => sum + sourcesOf(r)[source].cost_jpy, 0),
  };
}
