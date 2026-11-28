/* キーの期限の通知のテスト。実行: npm test（node --test）。値はすべて架空 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { daysUntil, issueContent, markerOf, parseMarker, planNotifications, stageOf, todayJst } from './key-expiry.mjs';

const TODAY = '2026-11-28';
const key = (service_id, nearest_expiry) => ({ service_id, nearest_expiry });
// 通知を作ったことにする。作った Issue を、次の実行に渡す
const send = (plan, issues) => {
  for (const c of plan.create) issues.push({ number: issues.length + 1, state: 'open', body: issueContent(c).body });
  for (const n of plan.close) issues.find((i) => i.number === n).state = 'closed';
};

test('日数と段階', () => {
  assert.equal(daysUntil('2026-12-28', TODAY), 30);
  assert.equal(daysUntil('2026-11-27', TODAY), -1);
  assert.equal(stageOf(31), null);
  assert.equal(stageOf(30), 'd30');
  assert.equal(stageOf(8), 'd30');
  assert.equal(stageOf(7), 'd7');
  assert.equal(stageOf(0), 'd7');
  assert.equal(stageOf(-1), 'expired');
});

test('今日の日付は日本時間で数える', () => {
  assert.equal(todayJst(new Date('2026-11-27T14:59:00Z')), '2026-11-27');
  assert.equal(todayJst(new Date('2026-11-27T15:00:00Z')), '2026-11-28');
});

test('30 日以内、7 日以内、期限切れのそれぞれについて、通知が 1 回ずつ出る', () => {
  const keys = [key(1, '2026-12-20'), key(2, '2026-12-01'), key(3, '2026-11-01'), key(4, '2027-06-01'), key(5, null)];
  const plan = planNotifications(keys, [], TODAY);
  assert.deepEqual(plan.create.map((c) => [c.id, c.stage, c.days]), [[1, 'd30', 22], [2, 'd7', 3], [3, 'expired', -27]]);
  assert.deepEqual(plan.close, []);
});

test('期限が変わらないまま何度動いても、通知は繰り返されない', () => {
  const keys = [key(1, '2026-12-20'), key(3, '2026-11-01')];
  const issues = [];
  send(planNotifications(keys, issues, TODAY), issues);
  assert.equal(issues.length, 2);
  for (const day of ['2026-11-28', '2026-11-29', '2026-12-05']) {
    assert.deepEqual(planNotifications(keys, issues, day), { create: [], close: [] });
  }
  // 利用者が Issue を閉じても、同じ段階ではもう知らせない
  issues[0].state = 'closed';
  assert.deepEqual(planNotifications(keys, issues, TODAY), { create: [], close: [] });
});

test('段階が進むと、新しい通知を 1 回出し、前の段階の Issue を閉じる', () => {
  const keys = [key(1, '2026-12-20')];
  const issues = [];
  send(planNotifications(keys, issues, '2026-11-28'), issues); // 30 日以内
  const d7 = planNotifications(keys, issues, '2026-12-13');    // 7 日以内に入った
  assert.deepEqual(d7.create.map((c) => c.stage), ['d7']);
  assert.deepEqual(d7.close, [1]);
  send(d7, issues);
  const expired = planNotifications(keys, issues, '2026-12-21');
  assert.deepEqual(expired.create.map((c) => c.stage), ['expired']);
  assert.deepEqual(expired.close, [2]);
  send(expired, issues);
  assert.deepEqual(planNotifications(keys, issues, '2027-01-10'), { create: [], close: [] });
  assert.equal(issues.length, 3);
});

test('キーを更新して期限が先に延びたら、開いている Issue を閉じ、何も作らない', () => {
  const issues = [];
  send(planNotifications([key(1, '2026-12-01')], issues, TODAY), issues);
  const plan = planNotifications([key(1, '2027-12-01')], issues, TODAY);
  assert.deepEqual(plan, { create: [], close: [1] });
  // 期限のあるキーが無くなったときも同じ
  assert.deepEqual(planNotifications([key(1, null)], issues, TODAY), { create: [], close: [1] });
  assert.deepEqual(planNotifications([], issues, TODAY), { create: [], close: [1] });
});

test('期限のあるキーが 1 本も無いときは、何も送らない', () => {
  assert.deepEqual(planNotifications([key(1, null), key(2, null)], [], TODAY), { create: [], close: [] });
  assert.deepEqual(planNotifications([], [], TODAY), { create: [], close: [] });
});

test('Issue に載せるのは通し番号と日数まで。目印は読み戻せる', () => {
  const c = { id: 3, expiry: '2026-12-01', stage: 'd7', days: 3 };
  const { title, body } = issueContent(c);
  assert.equal(title, 'キーの期限: #003 はあと 3 日');
  assert.match(body, /通し番号 #003/);
  assert.deepEqual(parseMarker(body), { id: 3, expiry: '2026-12-01', stage: 'd7' });
  assert.equal(parseMarker('目印のない Issue'), null);
  assert.equal(markerOf(c), '<!-- key-expiry:3:2026-12-01:d7 -->');
  assert.equal(issueContent({ id: 12, expiry: '2026-11-01', stage: 'expired', days: -27 }).title, 'キーの期限: #012 は期限切れ');
});

test('目印のない Issue（人が同じラベルを付けたもの）には触れない', () => {
  const issues = [{ number: 9, state: 'open', body: 'メモ' }];
  assert.deepEqual(planNotifications([], issues, TODAY), { create: [], close: [] });
});
