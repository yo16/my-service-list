/* my-service-list: 費用、収益、キーの本数と期限の取り込み（検証と行への変換）
 *
 * 取り込みのスクリプト（scripts/import-metrics.mjs）が使う。ここは通信をしない。
 * JSON の形は docs/design.md の 3.6 にある。
 */

// 1 件の金額の上限（円）。けた違いの入力を止めるためのもので、PostgreSQL の integer にも収まる
export const MAX_AMOUNT_JPY = 100_000_000;

const CATEGORY_RE = /^[a-z0-9][a-z0-9-]*$/;
const TOP_KEYS = ['month', 'source', 'provisional', 'services', 'shared'];
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
 * service_monthly の 1 行から、取得元ごとの費用を取り出す。
 * cost_sources の列ができる前に入った行は、source の列の名前の取得元が 1 つあるものとして読む。
 *
 * @returns {Record<string, { cost_jpy: number, breakdown: object|null, provisional: boolean, updated_at: string|null }>}
 */
export function sourcesOf(row) {
  if (!row) return {};
  if (isObject(row.cost_sources)) return { ...row.cost_sources };
  if (row.cost_jpy > 0 || isObject(row.breakdown)) {
    return { [row.source || 'import']: { cost_jpy: row.cost_jpy, breakdown: row.breakdown || null, provisional: false, updated_at: row.updated_at || null } };
  }
  return {};
}

/**
 * すでにある月の行（無ければ null）に、取り込む 1 件（validatePayload の monthly_inputs の要素）を重ねて、書き込む行を作る。
 * - 費用は、その取得元の分だけを置き換える。ほかの取得元の分は残す。月の費用は、取得元ごとの金額の合計にする
 * - 収益は、書いてあれば置き換え、書いてなければ今の値を残す
 * - 内訳は、金額のある取得元がすべて内訳を持つときだけ、名前ごとに足し合わせて持つ（合計が費用と一致する形を保つ）
 */
export function mergeMonthly(existing, input) {
  const sources = sourcesOf(existing);
  if (input.cost) sources[input.source] = { ...input.cost, updated_at: input.updated_at };
  return {
    service_id: input.service_id,
    month: input.month,
    ...totalsOf(sources),
    revenue_jpy: input.revenue_jpy ?? (existing ? existing.revenue_jpy : 0),
    source: input.source,
    cost_sources: sources,
    updated_at: input.updated_at,
  };
}

/** 取得元ごとの費用から、月の費用（合計）と月の内訳を作る */
function totalsOf(sources) {
  const entries = Object.values(sources);
  const priced = entries.filter((e) => e.cost_jpy > 0);
  let breakdown = null;
  if (priced.length && priced.every((e) => isObject(e.breakdown))) {
    breakdown = {};
    for (const e of priced) {
      for (const [name, amount] of Object.entries(e.breakdown)) breakdown[name] = (breakdown[name] || 0) + amount;
    }
  }
  return { cost_jpy: entries.reduce((sum, e) => sum + e.cost_jpy, 0), breakdown };
}

/** 取得元の名前として使えなければ、理由の文を返す。使えれば null */
export function sourceNameError(v) {
  const errors = [];
  checkText(v, '取得元の名前', errors);
  return errors[0] || null;
}

/**
 * 月の行の、取得元 1 つの名前を付け替えるか、取得元 1 つを消して、書き込む行を作る。
 * 金額、内訳、暫定の印、取り込んだ日時は変えない。月の費用と月の内訳は、残った取得元から作り直す。収益には触れない。
 * その取得元が行に無ければ null を返す。付け替え先の名前がすでに行にあるかどうかは、呼び出し側が先に確かめる。
 *
 * @param {object} existing service_monthly の今の行
 * @param {{ action: 'rename'|'remove', source: string, to?: string, updated_at: string }} edit
 */
export function editSource(existing, { action, source, to, updated_at }) {
  const current = sourcesOf(existing);
  if (!has(current, source)) return null;
  const sources = {};
  for (const [name, entry] of Object.entries(current)) {
    if (name !== source) sources[name] = entry;
    else if (action === 'rename') sources[to] = entry; // 並びの位置を保つ
  }
  return {
    service_id: existing.service_id,
    month: existing.month,
    ...totalsOf(sources),
    revenue_jpy: existing.revenue_jpy,
    source: action === 'rename' && existing.source === source ? to : existing.source,
    cost_sources: sources,
    updated_at,
  };
}

/**
 * 取り込む JSON を検証し、表ごとの行に直す。
 * エラーが 1 つでもあれば rows は null。エラーはすべて集めて返す（1 つ目で止めない）。
 * 費用と収益は、すでにある行に重ねる必要があるので、行ではなく monthly_inputs として返す（mergeMonthly に渡す）。
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

  // 月が締まる前の、途中の金額か。確定した金額をもう一度取り込むと false に戻る
  const provisional = has(input, 'provisional') ? input.provisional : false;
  if (typeof provisional !== 'boolean') errors.push('provisional: true か false で書いてください');

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
      // 費用は、この取得元の分だけを置き換える。収益は、書いたときだけ置き換える
      const hasCost = has(s, 'cost_jpy') || (has(s, 'breakdown') && s.breakdown !== null);
      const hasRevenue = has(s, 'revenue_jpy');
      const cost = has(s, 'cost_jpy') ? s.cost_jpy : 0;
      const costOk = hasCost ? checkAmount(cost, `${where}.cost_jpy`, errors) : true;
      if (hasRevenue) checkAmount(s.revenue_jpy, `${where}.revenue_jpy`, errors);
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
      monthly.push({
        service_id: s.id,
        month,
        source,
        cost: hasCost ? { cost_jpy: cost, breakdown, provisional: provisional === true } : null,
        revenue_jpy: hasRevenue ? s.revenue_jpy : null,
        updated_at: stamp,
      });
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
    sharedRows.push({ month, provider, account, category, cost_jpy: c.cost_jpy, provisional: provisional === true, updated_at: stamp });
  });

  if (!errors.length && !monthly.length && !keys.length && !sharedRows.length) {
    errors.push('取り込む内容がありません（services と shared がどちらも空です）');
  }

  if (errors.length) return { errors, rows: null };
  return { errors: [], rows: { monthly_inputs: monthly, shared_monthly_costs: sharedRows, service_keys: keys } };
}
