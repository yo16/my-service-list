/* 書き込みの手順のテスト。Supabase の代わりに、メモリの上の表を使う。値はすべて架空 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload } from './metrics.mjs';
import { writeMetrics, editSources } from './metrics-store.mjs';

const KEY_COLUMNS = { service_monthly: ['service_id', 'month'], shared_monthly_costs: ['month', 'provider', 'account'], service_keys: ['service_id'] };

// upsert を、重複を判定する列が同じ行の上書きとしてまねる
function fakeDb({ failOn = null } = {}) {
  const tables = { service_monthly: [], shared_monthly_costs: [], service_keys: [] };
  return {
    tables,
    io: {
      get: async (pathname) => {
        const month = /month=eq\.([\d-]+)/.exec(pathname)[1];
        const picked = /service_id=in\.\(([\d,]+)\)/.exec(pathname);
        const ids = picked ? picked[1].split(',').map(Number) : null; // 絞り込みが無ければ、その月のすべての行
        return tables.service_monthly.filter((r) => r.month === month && (!ids || ids.includes(r.service_id)));
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

// ---------- 取得元の名前の付け替えと、取得元の削除 ----------

// 取り込んだときの長い説明文が、そのまま取得元の名前になっている月
const LONG = 'Sample Cloud billing report screenshot, month to date as of 2026-11-24';
async function messyMonth() {
  const db = fakeDb();
  await importFile(db, { month: '2026-10', source: LONG, services: [{ id: 1, cost_jpy: 1000 }] });
  await importFile(db, { month: '2026-11', source: LONG, provisional: true, services: [{ id: 1, cost_jpy: 1200, breakdown: { 計算: 1200 } }, { id: 2, cost_jpy: 300 }] });
  await importFile(db, { month: '2026-11', source: 'manual', services: [{ id: 1, cost_jpy: 150, revenue_jpy: 500, breakdown: { ドメイン: 150 } }] });
  const row = (id, month = '2026-11-01') => db.tables.service_monthly.find((r) => r.service_id === id && r.month === month);
  return { db, row };
}

test('取得元の名前を付け替えると、その月のすべてのサービスで名前だけが変わる', async () => {
  const { db, row } = await messyMonth();
  const before = structuredClone(row(1).cost_sources[LONG]);
  const done = await editSources(db.io, { month: '2026-11', action: 'rename', source: LONG, to: ' sample-cloud ' });
  assert.deepEqual(done, { service_monthly: 2, cost_jpy: 1500 });
  assert.deepEqual(Object.keys(row(1).cost_sources), ['sample-cloud', 'manual']); // 並びの位置は変わらない
  assert.deepEqual(row(1).cost_sources['sample-cloud'], before); // 金額、内訳、暫定の印、取り込んだ日時はそのまま
  assert.equal(row(1).cost_jpy, 1350);
  assert.equal(row(1).revenue_jpy, 500);
  assert.deepEqual(row(1).breakdown, { 計算: 1200, ドメイン: 150 });
  assert.deepEqual(Object.keys(row(2).cost_sources), ['sample-cloud']);
  assert.equal(row(2).source, 'sample-cloud');
  // 別の月には触れない
  assert.deepEqual(Object.keys(row(1, '2026-10-01').cost_sources), [LONG]);
  // 付け替えたあとに同じ名前で取り込み直すと、二重にならずに置き換わる
  await importFile(db, { month: '2026-11', source: 'sample-cloud', services: [{ id: 1, cost_jpy: 1400 }] });
  assert.equal(row(1).cost_jpy, 1550);
});

test('取得元を消すと、月の費用と内訳が残りの取得元から作り直され、収益は残る', async () => {
  const { db, row } = await messyMonth();
  const done = await editSources(db.io, { month: '2026-11', action: 'remove', source: LONG });
  assert.deepEqual(done, { service_monthly: 2, cost_jpy: 1500 });
  assert.deepEqual(Object.keys(row(1).cost_sources), ['manual']);
  assert.equal(row(1).cost_jpy, 150);
  assert.deepEqual(row(1).breakdown, { ドメイン: 150 });
  assert.equal(row(1).revenue_jpy, 500);
  // 取得元が 1 つも無くなった行は、費用 0 円で残る
  assert.deepEqual(row(2).cost_sources, {});
  assert.equal(row(2).cost_jpy, 0);
  assert.equal(row(2).breakdown, null);
  assert.equal(row(1, '2026-10-01').cost_jpy, 1000);
});

test('取得元ごとの列ができる前の行も、付け替えと削除ができる', async () => {
  const db = fakeDb();
  db.tables.service_monthly.push({ service_id: 1, month: '2026-11-01', cost_jpy: 1350, revenue_jpy: 500, breakdown: { クラウド: 1350 }, source: 'import', updated_at: '2026-11-20T00:00:00.000Z' });
  await editSources(db.io, { month: '2026-11', action: 'rename', source: 'import', to: 'sample-cloud' });
  const row = db.tables.service_monthly[0];
  assert.deepEqual(Object.keys(row.cost_sources), ['sample-cloud']);
  assert.equal(row.cost_jpy, 1350);
  assert.equal(row.source, 'sample-cloud');
});

test('付け替え先の名前がすでにあるサービスが 1 つでもあれば、何も書かない', async () => {
  const { db, row } = await messyMonth();
  const before = structuredClone(db.tables.service_monthly);
  await assert.rejects(
    editSources(db.io, { month: '2026-11', action: 'rename', source: LONG, to: 'manual' }),
    (e) => e.invalid === true && e.message.includes('#001') && !e.message.includes('#002'),
  );
  assert.deepEqual(db.tables.service_monthly, before);
  assert.equal(row(2).cost_sources[LONG].cost_jpy, 300);
});

test('誤った指定は、何も書かずに断る', async () => {
  const { db } = await messyMonth();
  const before = structuredClone(db.tables.service_monthly);
  const refuse = (edit) => assert.rejects(editSources(db.io, { month: '2026-11', action: 'rename', source: LONG, to: 'x', ...edit }), (e) => e.invalid === true);
  await refuse({ month: '2026-13' });
  await refuse({ action: 'delete' });
  await refuse({ source: '' });
  await refuse({ source: 'どこにも無い取得元' });
  await refuse({ to: '   ' });
  await refuse({ to: 'x'.repeat(101) });
  await refuse({ to: 42 });
  await refuse({ to: LONG });
  await refuse({ action: 'remove', month: '2026-09' }); // その月に、その取得元が無い
  assert.deepEqual(db.tables.service_monthly, before);
});
