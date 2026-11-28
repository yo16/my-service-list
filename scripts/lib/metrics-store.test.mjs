/* 書き込みの手順のテスト。Supabase の代わりに、メモリの上の表を使う。値はすべて架空 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload } from './metrics.mjs';
import { writeMetrics } from './metrics-store.mjs';

const KEY_COLUMNS = { service_monthly: ['service_id', 'month'], shared_monthly_costs: ['month', 'provider', 'account'], service_keys: ['service_id'] };

// upsert を、重複を判定する列が同じ行の上書きとしてまねる
function fakeDb({ failOn = null } = {}) {
  const tables = { service_monthly: [], shared_monthly_costs: [], service_keys: [] };
  return {
    tables,
    io: {
      get: async (pathname) => {
        const month = /month=eq\.([\d-]+)/.exec(pathname)[1];
        const ids = /service_id=in\.\(([\d,]+)\)/.exec(pathname)[1].split(',').map(Number);
        return tables.service_monthly.filter((r) => r.month === month && ids.includes(r.service_id));
      },
      upsert: async (table, conflict, rows) => {
        if (table === failOn) throw new Error('書けない');
        assert.equal(conflict, KEY_COLUMNS[table].join(','));
        for (const row of rows) {
          const i = tables[table].findIndex((r) => KEY_COLUMNS[table].every((k) => r[k] === row[k]));
          if (i >= 0) tables[table][i] = row; else tables[table].push(row);
        }
      },
    },
  };
}

const context = { serviceIds: [1, 2], categoryKeys: ['personal'] };
const importFile = (db, input) => {
  const { errors, rows } = validatePayload(input, context);
  assert.deepEqual(errors, []);
  return writeMetrics(db.io, rows);
};

test('2 つの取得元から同じ月を取り込むと、両方が残り、合計が正しい', async () => {
  const db = fakeDb();
  await importFile(db, { month: '2026-11', source: 'cloud-a', services: [{ id: 1, cost_jpy: 1200 }, { id: 2, cost_jpy: 300 }] });
  await importFile(db, { month: '2026-11', source: 'manual', services: [{ id: 1, cost_jpy: 150, revenue_jpy: 500 }] });
  const row = db.tables.service_monthly.find((r) => r.service_id === 1);
  assert.equal(db.tables.service_monthly.length, 2);
  assert.equal(row.cost_jpy, 1350);
  assert.equal(row.revenue_jpy, 500);
  assert.deepEqual(Object.keys(row.cost_sources).sort(), ['cloud-a', 'manual']);
});

test('同じ取得元をもう一度取り込むと、その分だけが置き換わる。別の月には触れない', async () => {
  const db = fakeDb();
  await importFile(db, { month: '2026-10', source: 'cloud-a', services: [{ id: 1, cost_jpy: 1000 }] });
  await importFile(db, { month: '2026-11', source: 'cloud-a', services: [{ id: 1, cost_jpy: 1200 }] });
  await importFile(db, { month: '2026-11', source: 'manual', services: [{ id: 1, cost_jpy: 150 }] });
  await importFile(db, { month: '2026-11', source: 'cloud-a', services: [{ id: 1, cost_jpy: 900 }] });
  const of = (month) => db.tables.service_monthly.find((r) => r.month === month);
  assert.equal(of('2026-11-01').cost_jpy, 1050);
  assert.equal(of('2026-10-01').cost_jpy, 1000);
});

test('今までの形の JSON（source なし）が、今までどおり取り込める', async () => {
  const db = fakeDb();
  const counts = await importFile(db, {
    month: '2026-11',
    services: [{ id: 1, cost_jpy: 1350, revenue_jpy: 0, breakdown: { クラウド: 1200, ドメイン: 150 }, keys: { count: 4, nearest_expiry: '2027-02-01' } }],
    shared: [{ provider: 'Sample Hosting', account: 'サンプルのチーム', category: 'personal', cost_jpy: 3000 }],
  });
  assert.deepEqual(counts, { service_monthly: 1, shared_monthly_costs: 1, service_keys: 1 });
  const row = db.tables.service_monthly[0];
  assert.equal(row.cost_jpy, 1350);
  assert.deepEqual(row.breakdown, { クラウド: 1200, ドメイン: 150 });
  assert.equal(row.source, 'import');
});

test('途中で失敗したら、失敗した表と、書き終えた表が分かる', async () => {
  const db = fakeDb({ failOn: 'shared_monthly_costs' });
  const { rows } = validatePayload({
    month: '2026-11',
    services: [{ id: 1, cost_jpy: 100 }],
    shared: [{ provider: 'A', account: 'B', cost_jpy: 1 }],
  }, context);
  await assert.rejects(writeMetrics(db.io, rows), (e) => e.table === 'shared_monthly_costs' && e.done.join() === 'service_monthly');
});
