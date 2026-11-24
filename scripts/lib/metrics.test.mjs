/* 取り込みの検証のテスト。実行: npm test（node --test）。値はすべて架空 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, monthOf, previousMonth, isMonth, isRealDate } from './metrics.mjs';

const context = { serviceIds: [1, 2, 3], categoryKeys: ['personal', 'sample-club'], now: new Date('2026-11-24T00:00:00Z') };
const check = (input) => validatePayload(input, context);

const valid = () => ({
  month: '2026-11',
  services: [
    { id: 1, cost_jpy: 1350, revenue_jpy: 500, breakdown: { クラウド: 1200, ドメイン: 150 }, keys: { count: 4, nearest_expiry: '2027-02-01' } },
    { id: 2, keys: { count: 0, nearest_expiry: null } },
    { id: 3, cost_jpy: 0 },
  ],
  shared: [{ provider: 'Sample Hosting', account: 'サンプルのチーム', category: 'sample-club', cost_jpy: 3000 }],
});

test('正しい JSON を受け付け、表ごとの行に直す', () => {
  const { errors, rows } = check(valid());
  assert.deepEqual(errors, []);
  assert.equal(rows.service_monthly.length, 2);
  assert.equal(rows.shared_monthly_costs.length, 1);
  assert.equal(rows.service_keys.length, 2);
  assert.deepEqual(rows.service_monthly[0], {
    service_id: 1,
    month: '2026-11-01',
    cost_jpy: 1350,
    revenue_jpy: 500,
    breakdown: { クラウド: 1200, ドメイン: 150 },
    source: 'import',
    updated_at: '2026-11-24T00:00:00.000Z',
  });
  // 書かなかった金額は 0 にする
  assert.equal(rows.service_monthly[1].revenue_jpy, 0);
  assert.deepEqual(rows.service_keys[1], { service_id: 2, key_count: 0, nearest_expiry: null, checked_at: '2026-11-24T00:00:00.000Z' });
  assert.deepEqual(rows.shared_monthly_costs[0], {
    month: '2026-11-01', provider: 'Sample Hosting', account: 'サンプルのチーム', category: 'sample-club', cost_jpy: 3000, updated_at: '2026-11-24T00:00:00.000Z',
  });
});

test('キーだけ、共通の費用だけでも受け付ける', () => {
  assert.deepEqual(check({ month: '2026-11', services: [{ id: 1, keys: { count: 2 } }] }).errors, []);
  assert.deepEqual(check({ month: '2026-11', shared: [{ provider: 'A', account: 'B', cost_jpy: 0 }] }).errors, []);
});

// 誤った JSON は、rows を返さない（呼び出し側は何も書き込まない）
const rejects = (name, mutate, pattern) => test(`拒む: ${name}`, () => {
  const input = valid();
  mutate(input);
  const { errors, rows } = check(input);
  assert.equal(rows, null);
  assert.ok(errors.some((e) => pattern.test(e)), `エラーに ${pattern} が無い: ${errors.join(' | ')}`);
});

rejects('知らない通し番号', (d) => { d.services[0].id = 99; }, /通し番号 99 のサービスは登録されていません/);
rejects('同じ通し番号が 2 回', (d) => { d.services[1].id = 1; }, /2 回出てきます/);
rejects('通し番号が文字列', (d) => { d.services[0].id = '1'; }, /正の整数/);
rejects('負の費用', (d) => { d.services[2].cost_jpy = -1; }, /負の金額/);
rejects('負の収益', (d) => { d.services[0].revenue_jpy = -500; }, /負の金額/);
rejects('小数の金額', (d) => { d.services[2].cost_jpy = 10.5; }, /円の整数/);
rejects('文字列の金額', (d) => { d.services[2].cost_jpy = '100'; }, /円の整数/);
rejects('けた違いの金額', (d) => { d.services[2].cost_jpy = 1e12; }, /大きすぎます/);
rejects('内訳の合計が合わない', (d) => { d.services[0].breakdown.ドメイン = 100; }, /内訳の合計/);
rejects('月の形が違う', (d) => { d.month = '2026-13'; }, /YYYY-MM/);
rejects('月が無い', (d) => { delete d.month; }, /YYYY-MM/);
rejects('実在しない期限', (d) => { d.services[0].keys.nearest_expiry = '2027-02-30'; }, /実在する日付/);
rejects('負のキーの本数', (d) => { d.services[0].keys.count = -1; }, /キーの本数/);
rejects('知らない項目（書き間違い）', (d) => { d.services[0].cost = 100; }, /知らない項目 cost/);
rejects('キーの詳細を載せようとする', (d) => { d.services[0].keys.location = 'x'; }, /知らない項目 location/);
rejects('中身のないサービス', (d) => { d.services[1] = { id: 2 }; }, /どれかを書いてください/);
rejects('登録されていない区分', (d) => { d.shared[0].category = 'nowhere'; }, /区分 nowhere は登録されていません/);
rejects('共通の費用の金額が無い', (d) => { delete d.shared[0].cost_jpy; }, /金額を書いてください/);
rejects('共通の費用の請求元が空', (d) => { d.shared[0].provider = ' '; }, /空でない文字列/);
rejects('共通の費用の同じ組が 2 回', (d) => { d.shared.push({ ...d.shared[0] }); }, /同じ組が 2 回/);
rejects('services が配列でない', (d) => { d.services = {}; }, /配列で書いてください/);

test('拒む: 空の取り込みと、オブジェクトでない入力', () => {
  assert.equal(check({ month: '2026-11' }).rows, null);
  assert.equal(check([]).rows, null);
  assert.equal(check(null).rows, null);
});

test('エラーは 1 つ目で止めず、すべて集める', () => {
  const input = valid();
  input.services[0].id = 99;
  input.services[2].cost_jpy = -1;
  input.shared[0].cost_jpy = -1;
  assert.equal(check(input).errors.length, 3);
});

test('月の計算は日本時間で行う', () => {
  assert.equal(monthOf(new Date('2026-10-31T14:59:00Z')), '2026-10');
  assert.equal(monthOf(new Date('2026-10-31T15:00:00Z')), '2026-11');
  assert.equal(previousMonth('2026-11'), '2026-10');
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(isMonth('2026-11'), true);
  assert.equal(isMonth('2026-1'), false);
  assert.equal(isRealDate('2028-02-29'), true);
  assert.equal(isRealDate('2027-02-29'), false);
});
