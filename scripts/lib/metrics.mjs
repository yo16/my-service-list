/* my-service-list: 費用、収益、キーの本数と期限の取り込み（検証と行への変換）
 *
 * 取り込みのスクリプト（scripts/import-metrics.mjs）が使う。ここは通信をしない。
 * JSON の形は docs/design.md の 3.6 にある。
 */

// 1 件の金額の上限（円）。けた違いの入力を止めるためのもので、PostgreSQL の integer にも収まる
export const MAX_AMOUNT_JPY = 100_000_000;

const CATEGORY_RE = /^[a-z0-9][a-z0-9-]*$/;
const TOP_KEYS = ['month', 'source', 'services', 'shared'];
const SERVICE_KEYS = ['id', 'cost_jpy', 'revenue_jpy', 'breakdown', 'keys'];
const KEYS_KEYS = ['count', 'nearest_expiry'];
const SHARED_KEYS = ['provider', 'account', 'category', 'cost_jpy'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** YYYY-MM の形で、実在する月か */
export function isMonth(v) {
  if (typeof v !== 'string') return false;
  const m = v.match(/^(\d{4})-(\d{2})$/);
  return Boolean(m) && Number(m[1]) >= 2000 && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** YYYY-MM-DD の形で、実在する日付か（2025-02-30 などを弾く） */
export function isRealDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** 基準の時刻の、日本時間での月（YYYY-MM） */
export function monthOf(date = new Date()) {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 7);
}

/** YYYY-MM の前の月 */
export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}: 知らない項目 ${k} があります（使える項目: ${allowed.join(', ')}）`);
  }
}

function checkAmount(v, where, errors) {
  if (!Number.isInteger(v)) {
    errors.push(`${where}: 円の整数で書いてください`);
    return false;
  }
  if (v < 0) {
    errors.push(`${where}: 負の金額は入れられません`);
    return false;
  }
  if (v > MAX_AMOUNT_JPY) {
    errors.push(`${where}: 金額が大きすぎます（上限は ${MAX_AMOUNT_JPY} 円）`);
    return false;
  }
  return true;
}

function checkText(v, where, errors) {
  if (typeof v !== 'string' || !v.trim()) {
    errors.push(`${where}: 空でない文字列で書いてください`);
    return null;
  }
  if (v.trim().length > 100) {
    errors.push(`${where}: 100 文字以内で書いてください`);
    return null;
  }
  return v.trim();
}

/**
 * 取り込む JSON を検証し、表ごとの行に直す。
 * エラーが 1 つでもあれば rows は null。エラーはすべて集めて返す（1 つ目で止めない）。
 *
 * @param {unknown} input 取り込む JSON
 * @param {{ serviceIds: Iterable<number>, categoryKeys?: Iterable<string>, now?: Date }} context
 *   serviceIds は登録済みの通し番号、categoryKeys は登録済みの区分
 */
export function validatePayload(input, { serviceIds, categoryKeys = [], now = new Date() }) {
  const errors = [];
  const known = new Set([...serviceIds].map(Number));
  const categories = new Set(categoryKeys);
  const stamp = now.toISOString();

  if (!isObject(input)) return { errors: ['JSON の一番外側はオブジェクトにしてください'], rows: null };
  unknownKeys(input, TOP_KEYS, '一番外側', errors);

  const monthOk = isMonth(input.month);
  if (!monthOk) errors.push('month: YYYY-MM の形で書いてください（例: 2026-11）');
  const month = monthOk ? `${input.month}-01` : null;

  let source = 'import';
  if (has(input, 'source') && input.source !== null) source = checkText(input.source, 'source', errors) || source;

  const services = has(input, 'services') ? input.services : [];
  const shared = has(input, 'shared') ? input.shared : [];
  if (!Array.isArray(services)) errors.push('services: 配列で書いてください');
  if (!Array.isArray(shared)) errors.push('shared: 配列で書いてください');

  const monthly = [];
  const keys = [];
  const seenIds = new Set();
  (Array.isArray(services) ? services : []).forEach((s, i) => {
    const where = `services[${i}]`;
    if (!isObject(s)) {
      errors.push(`${where}: オブジェクトで書いてください`);
      return;
    }
    unknownKeys(s, SERVICE_KEYS, where, errors);
    const idOk = Number.isInteger(s.id) && s.id > 0;
    if (!idOk) errors.push(`${where}.id: 通し番号を正の整数で書いてください`);
    else if (!known.has(s.id)) errors.push(`${where}.id: 通し番号 ${s.id} のサービスは登録されていません`);
    else if (seenIds.has(s.id)) errors.push(`${where}.id: 通し番号 ${s.id} が 2 回出てきます`);
    if (idOk) seenIds.add(s.id);

    const hasMoney = ['cost_jpy', 'revenue_jpy', 'breakdown'].some((k) => has(s, k));
    if (!hasMoney && !has(s, 'keys')) errors.push(`${where}: cost_jpy、revenue_jpy、keys のどれかを書いてください`);

    if (hasMoney) {
      // 月の行は丸ごと置き換える。書かなかった金額は 0 として保存する
      const cost = has(s, 'cost_jpy') ? s.cost_jpy : 0;
      const revenue = has(s, 'revenue_jpy') ? s.revenue_jpy : 0;
      const costOk = checkAmount(cost, `${where}.cost_jpy`, errors);
      checkAmount(revenue, `${where}.revenue_jpy`, errors);
      let breakdown = null;
      if (has(s, 'breakdown') && s.breakdown !== null) {
        if (!isObject(s.breakdown)) {
          errors.push(`${where}.breakdown: 名前から金額への対応（オブジェクト）で書いてください`);
        } else {
          let sum = 0;
          let allOk = true;
          for (const [name, amount] of Object.entries(s.breakdown)) {
            if (!name.trim()) {
              errors.push(`${where}.breakdown: 名前が空の項目があります`);
              allOk = false;
            }
            if (checkAmount(amount, `${where}.breakdown の ${Object.keys(s.breakdown).indexOf(name) + 1} 番目`, errors)) sum += amount;
            else allOk = false;
          }
          if (allOk && costOk && sum !== cost) errors.push(`${where}.breakdown: 内訳の合計が cost_jpy と一致しません`);
          breakdown = s.breakdown;
        }
      }
      monthly.push({ service_id: s.id, month, cost_jpy: cost, revenue_jpy: revenue, breakdown, source, updated_at: stamp });
    }

    if (has(s, 'keys')) {
      const k = s.keys;
      if (!isObject(k)) {
        errors.push(`${where}.keys: オブジェクトで書いてください`);
        return;
      }
      unknownKeys(k, KEYS_KEYS, `${where}.keys`, errors);
      if (!Number.isInteger(k.count) || k.count < 0 || k.count > 10000) {
        errors.push(`${where}.keys.count: キーの本数を 0 以上の整数で書いてください`);
      }
      const expiry = has(k, 'nearest_expiry') ? k.nearest_expiry : null;
      if (expiry !== null && !isRealDate(expiry)) {
        errors.push(`${where}.keys.nearest_expiry: 実在する日付を YYYY-MM-DD の形で書くか、null にしてください`);
      }
      keys.push({ service_id: s.id, key_count: k.count, nearest_expiry: expiry, checked_at: stamp });
    }
  });

  const sharedRows = [];
  const seenShared = new Set();
  (Array.isArray(shared) ? shared : []).forEach((c, i) => {
    const where = `shared[${i}]`;
    if (!isObject(c)) {
      errors.push(`${where}: オブジェクトで書いてください`);
      return;
    }
    unknownKeys(c, SHARED_KEYS, where, errors);
    const provider = checkText(c.provider, `${where}.provider`, errors);
    const account = checkText(c.account, `${where}.account`, errors);
    let category = null;
    if (has(c, 'category') && c.category !== null) {
      if (typeof c.category !== 'string' || !CATEGORY_RE.test(c.category)) {
        errors.push(`${where}.category: 区分のキー（英小文字、数字、ハイフン）で書いてください`);
      } else if (!categories.has(c.category)) {
        errors.push(`${where}.category: 区分 ${c.category} は登録されていません`);
      } else {
        category = c.category;
      }
    }
    if (!has(c, 'cost_jpy')) errors.push(`${where}.cost_jpy: 金額を書いてください`);
    else checkAmount(c.cost_jpy, `${where}.cost_jpy`, errors);
    if (provider && account) {
      const pair = JSON.stringify([provider, account]);
      if (seenShared.has(pair)) errors.push(`${where}: provider と account の同じ組が 2 回出てきます`);
      seenShared.add(pair);
    }
    sharedRows.push({ month, provider, account, category, cost_jpy: c.cost_jpy, updated_at: stamp });
  });

  if (!errors.length && !monthly.length && !keys.length && !sharedRows.length) {
    errors.push('取り込む内容がありません（services と shared がどちらも空です）');
  }

  if (errors.length) return { errors, rows: null };
  return { errors: [], rows: { service_monthly: monthly, shared_monthly_costs: sharedRows, service_keys: keys } };
}
