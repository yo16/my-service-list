/* my-service-list: 費用、収益、キーの本数と期限を Supabase に書く手順
 *
 * 取り込みのスクリプト（scripts/import-metrics.mjs）と登録画面（scripts/admin.mjs）が共有する。
 * 通信そのものは呼び出し側の関数に任せ、ここは「何を読んで、どの表に何を書くか」だけを持つ。
 */

import { mergeMonthly } from './metrics.mjs';

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
