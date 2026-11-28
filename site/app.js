/* my-service-list: 一覧ページ。
 * data.enc.json をパスフレーズで復号し、1 つの表に描画する。
 * フレームワークなし。DOM は createElement と textContent だけで組み立てる。
 */
(() => {
  'use strict';

  const STAGES = [
    { key: 'planning', label: '企画' },
    { key: 'developing', label: '開発中' },
    { key: 'released', label: '公開中' },
    { key: 'paused', label: '休止' },
    { key: 'retired', label: '終了' },
  ];
  const DEFAULT_STAGES = ['planning', 'developing', 'released', 'paused'];
  const STATUS_LABEL = {
    UP: '稼働中',
    DOWN: '停止',
    LOOKS_DOWN: '停止の疑い',
    PAUSED: '監視を一時停止',
    STARTED: '確認中',
  };
  const STORAGE_KEY = 'msl.passphrase';

  const state = {
    data: null,
    query: '',
    stages: new Set(DEFAULT_STAGES),
    tags: new Set(),
    infra: new Set(),
    categories: new Set(), // 空なら、すべての区分を出す
    month: 'current',      // 費用と収益を出す月。current（今月）か previous（先月）
    view: 'list',          // list（一覧）か trends（推移と集計）
    trendMonth: null,      // 区分ごとの集計を出す月（YYYY-MM）
    sort: { key: 'id', dir: 'asc' },
    expanded: new Set(),
  };
  const MONTHS = [
    { key: 'current', label: '今月' },
    { key: 'previous', label: '先月' },
  ];
  const EXPIRY_SOON_DAYS = 30;

  const $ = (sel) => document.querySelector(sel);

  // ---------- DOM ヘルパー ----------

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function svgIcon(kind) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const paths = kind === 'site'
      ? ['M14 4h6v6', 'M20 4l-9 9', 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5']
      : ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5', 'M14 4l-4 16'];
    for (const d of paths) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  // 外部由来の URL をリンクにするのは http と https だけ
  function safeUrl(u) {
    if (!u) return null;
    try {
      return ['http:', 'https:'].includes(new URL(u).protocol) ? u : null;
    } catch (_) {
      return null;
    }
  }

  // ---------- 日付 ----------

  const pad = (n) => String(n).padStart(2, '0');

  function fmtDate(iso) {
    if (!iso) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso; // 日付だけの値は UTC に解釈させない
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function fmtDateTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${fmtDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function relTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return '今日';
    if (days === 1) return '昨日';
    if (days < 30) return `${days} 日前`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} か月前`;
    return `${Math.max(1, Math.floor(days / 365))} 年前`;
  }

  // 今日から日付（YYYY-MM-DD）までの日数。過ぎていれば負。日付は端末の時刻で数える
  function daysUntil(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    if (!m) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - today) / 86400000);
  }

  // ---------- 区分、費用と収益、キー ----------

  const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;
  // 差し引きは色だけに頼らず、符号でも正負を示す
  const signedYen = (n) => (n > 0 ? `+${yen(n)}` : n < 0 ? `−${yen(-n)}` : yen(0));
  const netClass = (n) => (n > 0 ? 'is-plus' : n < 0 ? 'is-minus' : '');

  // 同期ジョブが費用や期限を出力に含めているか。含めていなければ、その列ごと出さない
  const hasMetrics = () => Boolean(state.data.months) || state.data.services.some((s) => 'money' in s || 'keys' in s);
  const hasCategories = () => Array.isArray(state.data.categories) && state.data.categories.length > 0;

  function categoryLabel(key) {
    if (!key) return null;
    const c = (state.data.categories || []).find((x) => x.key === key);
    return c ? c.label : key;
  }

  const monthName = (key) => (state.data.months && state.data.months[key]) || null;
  const moneyOf = (s, month = state.month) => (s.money && s.money[month]) || null;
  const netOf = (s, month = state.month) => {
    const m = moneyOf(s, month);
    return m ? m.revenueJpy - m.costJpy : null;
  };
  const sharedOf = (month = state.month) => (state.data.sharedCosts || []).filter((c) => c.month === monthName(month));

  // 費用の取得元の表示名。決まった名前以外は、取り込みの JSON の source をそのまま出す
  const SOURCE_LABEL = { manual: '手入力', import: '取り込み' };
  const sourceLabel = (key) => SOURCE_LABEL[key] || key;
  // 月が締まる前の、途中の金額に付ける印
  const provisionalFlag = () => el('span', { class: 'provisional-flag', text: '暫定', title: '月が締まる前の、途中の金額です' });
  const breakdownText = (b) => (b ? Object.entries(b).map(([name, v]) => `${name} ${yen(v)}`).join('、') : null);

  // キーのいちばん近い期限の状態: expired（過ぎた）、soon（30 日以内）、ok、null（期限なし）
  function expiryOf(s) {
    const days = s.keys ? daysUntil(s.keys.nearestExpiry) : null;
    if (days == null) return null;
    return { days, state: days < 0 ? 'expired' : days <= EXPIRY_SOON_DAYS ? 'soon' : 'ok' };
  }

  function expiryFlag(exp) {
    if (!exp || exp.state === 'ok') return null;
    const text = exp.state === 'expired' ? '期限切れ' : exp.days === 0 ? '今日まで' : `あと ${exp.days} 日`;
    return el('span', { class: `expiry-flag is-${exp.state}`, text });
  }

  // ---------- 復号 ----------

  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function decrypt(enc, passphrase) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) throw new Error('この環境では復号できません（https か localhost で開いてください）');
    const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      { name: 'PBKDF2', salt: b64(enc.salt), iterations: enc.iter, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function storage(action, value) {
    try {
      if (action === 'get') return localStorage.getItem(STORAGE_KEY);
      if (action === 'set') localStorage.setItem(STORAGE_KEY, value);
      if (action === 'del') localStorage.removeItem(STORAGE_KEY);
    } catch (_) { /* プライベートモードなどで使えないときは黙って続ける */ }
    return null;
  }

  // ---------- 読み込み ----------

  // 404 と、それ以外の失敗（通信エラー、5xx、JSON でない）を呼び出し側で分けられるように返す
  async function fetchJson(path) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (res.status === 404) return { notFound: true };
      if (!res.ok) return { failed: true };
      return { json: await res.json() };
    } catch (_) {
      return { failed: true };
    }
  }

  function showFatal(message) {
    const fatal = $('#fatal');
    fatal.textContent = message;
    fatal.hidden = false;
  }

  // 鍵が違うと AES-GCM の復号は OperationError になる。それ以外はパスフレーズの問題ではない
  const isWrongPassphrase = (e) => e && e.name === 'OperationError';

  async function openData(enc, passphrase) {
    const data = await decrypt(enc, passphrase);
    if (!data || !Array.isArray(data.services)) throw new Error('データの形が想定と違います');
    return data;
  }

  async function main() {
    const res = await fetchJson('data.enc.json');
    try {
      if (res.json && res.json.ct) {
        const remembered = storage('get');
        if (remembered) {
          try {
            show(await openData(res.json, remembered));
            return;
          } catch (e) {
            if (!isWrongPassphrase(e)) {
              showFatal(`データを読めません: ${e.message}`);
              return;
            }
            storage('del');
          }
        }
        showUnlock(res.json);
        return;
      }
      if (!res.notFound) {
        showFatal('データの読み込みに失敗しました。時間をおいて再読み込みしてください。');
        return;
      }
      // サンプルは Pages に配置されないので、ここに来るのはローカルで確かめているときだけ
      const sample = await fetchJson('sample/data.json');
      if (sample.json) {
        const banner = $('#banner');
        banner.textContent = 'サンプルデータを表示しています（data.enc.json がありません）';
        banner.hidden = false;
        show(sample.json);
        return;
      }
      showFatal('データが見つかりません。同期ジョブが実行されているか確認してください。');
    } finally {
      $('#loading').hidden = true;
    }
  }

  function showUnlock(enc) {
    const section = $('#unlock');
    const form = $('#unlock-form');
    const input = $('#passphrase');
    const error = $('#unlock-error');
    const submit = form.querySelector('button');
    section.hidden = false;
    input.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const pass = input.value;
      if (!pass) { error.textContent = 'パスフレーズを入力してください'; return; }
      submit.disabled = true;
      submit.textContent = '確かめています…';
      let data;
      try {
        data = await openData(enc, pass);
      } catch (err) {
        error.textContent = isWrongPassphrase(err) ? 'パスフレーズが違います' : `データを読めません: ${err.message}`;
        input.select();
        return;
      } finally {
        submit.disabled = false;
        submit.textContent = '開く';
      }
      if ($('#remember').checked) storage('set', pass);
      input.value = '';
      section.hidden = true;
      show(data);
      $('#app').focus();
    });
  }

  // ---------- 描画 ----------

  function show(data) {
    state.data = data;
    $('#app').hidden = false;
    // 費用は月が締まってから入ることが多い。今月の分がまだ無ければ、先月を先に見せる
    const filled = (month) => data.services.some((s) => moneyOf(s, month)) || sharedOf(month).length > 0;
    state.month = !filled('current') && filled('previous') ? 'previous' : 'current';
    $('#services-table').classList.toggle('no-metrics', !hasMetrics());
    renderMeta();
    renderStageFilter();
    renderCategoryFilter();
    renderInfraFilter();
    renderTagFilter();
    renderLegend();
    bindControls();
    state.trendMonth = monthName(state.month);
    setView('list');
    renderSummary();
    renderShared();
    renderRows();
  }

  function renderLegend() {
    $('#legend-site').replaceChildren(svgIcon('site'), 'サイト');
    $('#legend-repo').replaceChildren(svgIcon('repo'), 'リポジトリ');
    $('#legend-expiry').hidden = !hasMetrics();
    $('#lock').hidden = !storage('get');
  }

  // 月を切り替えたときに、合計、共通の費用、表をそろえて描き直す
  function setMonth(key) {
    state.month = key;
    renderSummary();
    renderShared();
    renderRows();
  }

  // 合計は絞り込みに連動させない（隠している「終了」のサービスの費用も含めるため）
  function renderSummary() {
    const section = $('#summary');
    section.hidden = !state.data.months;
    if (section.hidden) return;

    const sw = $('#month-switch');
    // ボタンを作り直すので、キーボードで押したときにフォーカスを失わないよう、あとで戻す
    const hadFocus = sw.contains(document.activeElement);
    sw.replaceChildren();
    for (const m of MONTHS) {
      sw.append(el('button', {
        type: 'button',
        class: 'toggle',
        'aria-pressed': String(state.month === m.key),
        onclick: () => setMonth(m.key),
      }, [m.label, el('span', { class: 'month-name', text: monthName(m.key) })]));
    }
    if (hadFocus) sw.querySelector('[aria-pressed="true"]').focus();

    const services = state.data.services;
    const entered = services.filter((s) => moneyOf(s));
    const serviceCost = entered.reduce((sum, s) => sum + moneyOf(s).costJpy, 0);
    const revenue = entered.reduce((sum, s) => sum + moneyOf(s).revenueJpy, 0);
    const sharedCost = sharedOf().reduce((sum, c) => sum + c.costJpy, 0);
    const net = revenue - serviceCost - sharedCost;

    const figures = $('#summary-figures');
    figures.replaceChildren();
    const figure = (label, value, cls) => figures.append(el('div', { class: `figure ${cls || ''}` }, [
      el('dt', { text: label }),
      el('dd', { text: value }),
    ]));
    // 何も入っていない月は、0 円と区別するために — を出す（表の未入力と同じ扱い）
    const hasAny = entered.length > 0 || sharedOf().length > 0;
    const shown = (text) => (hasAny ? text : '—');
    figure('費用の合計', shown(yen(serviceCost + sharedCost)), 'is-main');
    figure('うちサービスごと', shown(yen(serviceCost)));
    figure('うち共通', shown(yen(sharedCost)));
    figure('収益の合計', shown(yen(revenue)), 'is-main');
    figure('差し引き', shown(signedYen(net)), `is-main ${hasAny ? netClass(net) : ''}`);

    const provisional = entered.some((s) => moneyOf(s).provisional) || sharedOf().some((c) => c.provisional);
    $('#summary-note').textContent = hasAny
      ? `${monthName(state.month)} の分。サービス ${services.length} 件のうち ${entered.length} 件に金額が入っています。上の合計は絞り込みに連動しません。${provisional ? '月が締まる前の、暫定の金額を含みます。' : ''}`
      : `${monthName(state.month)} の金額は、まだ入っていません。`;
  }

  // 絞り込んでいるときだけ、表に出ているサービスの分の合計を、全体の合計の下に出す。
  // 共通の費用はサービスに割り振っていないので、ここには含めない
  function renderFilteredSummary(rows) {
    const box = $('#summary-filtered');
    box.hidden = !state.data.months || !isFiltered();
    if (box.hidden) return;
    const entered = rows.filter((s) => moneyOf(s));
    const cost = entered.reduce((sum, s) => sum + moneyOf(s).costJpy, 0);
    const revenue = entered.reduce((sum, s) => sum + moneyOf(s).revenueJpy, 0);
    const item = (label, value, cls) => el('span', { class: 'filtered-item' }, [
      el('span', { class: 'amt-label', text: label }),
      el('span', { class: `amt-value ${cls || ''}`, text: entered.length ? value : '—' }),
    ]);
    box.replaceChildren(
      el('span', { class: 'filtered-title', text: `絞り込んだ ${rows.length} 件の分（共通の費用を除く）` }),
      item('費用', yen(cost)),
      item('収益', yen(revenue)),
      item('差し引き', signedYen(revenue - cost), entered.length ? netClass(revenue - cost) : ''),
    );
  }

  function renderShared() {
    const section = $('#shared');
    section.hidden = !Array.isArray(state.data.sharedCosts);
    if (section.hidden) return;
    const rows = sharedOf();
    const body = $('#shared-rows');
    const foot = $('#shared-foot');
    body.replaceChildren();
    foot.replaceChildren();
    $('#shared-title').textContent = `共通の費用（${monthName(state.month)}）`;
    $('.shared-wrap').hidden = rows.length === 0;
    const empty = $('#shared-empty');
    empty.hidden = rows.length > 0;
    empty.textContent = `${monthName(state.month)} の共通の費用は、まだ入っていません。`;
    for (const c of rows) {
      body.append(el('tr', {}, [
        el('td', {}, [c.provider, c.provisional ? provisionalFlag() : null]),
        el('td', { text: c.account }),
        el('td', {}, c.category ? categoryLabel(c.category) : el('span', { class: 'none', text: '—' })),
        el('td', { class: 'num', text: yen(c.costJpy) }),
      ]));
    }
    if (rows.length) {
      foot.append(el('tr', {}, [
        el('th', { colspan: '3', scope: 'row', text: '合計' }),
        el('td', { class: 'num', text: yen(rows.reduce((sum, c) => sum + c.costJpy, 0)) }),
      ]));
    }
  }

  const isDown = (s) => Boolean(s.uptime) && (s.uptime.status === 'DOWN' || s.uptime.status === 'LOOKS_DOWN');

  function renderMeta() {
    const meta = $('#meta');
    meta.replaceChildren();
    const services = state.data.services;
    const counts = Object.fromEntries(STAGES.map((s) => [s.key, 0]));
    let down = 0;
    for (const s of services) {
      counts[s.stage] = (counts[s.stage] || 0) + 1;
      if (isDown(s)) down++;
    }
    const parts = [];
    if (down) parts.push(el('span', { class: 'down-count', text: `停止中 ${down}` }));
    const expiring = services.filter((s) => {
      const exp = expiryOf(s);
      return exp && exp.state !== 'ok';
    }).length;
    if (expiring) parts.push(el('span', { class: 'expiry-count', text: `キーの期限が近い ${expiring}` }));
    const when = fmtDateTime(state.data.generatedAt);
    if (when) parts.push(el('span', { text: `更新 ${when}` }));
    for (const s of STAGES) {
      if (counts[s.key]) parts.push(el('span', { text: `${s.label} ${counts[s.key]}` }));
    }
    parts.forEach((p, i) => {
      if (i) meta.append(el('span', { class: 'sep', text: '・' }));
      meta.append(p);
    });
  }

  function renderStageFilter() {
    const group = $('#stage-filter');
    group.replaceChildren(el('span', { class: 'group-label', text: '段階' }));
    for (const s of STAGES) {
      const btn = el('button', {
        type: 'button',
        class: 'toggle',
        'aria-pressed': String(state.stages.has(s.key)),
        text: s.label,
        onclick: () => {
          if (state.stages.has(s.key)) state.stages.delete(s.key); else state.stages.add(s.key);
          btn.setAttribute('aria-pressed', String(state.stages.has(s.key)));
          renderRows();
        },
      });
      group.append(btn);
    }
  }

  // 区分の絞り込み。何も選んでいなければ、すべての区分を出す
  function renderCategoryFilter() {
    const group = $('#category-filter');
    group.hidden = !hasCategories();
    if (group.hidden) return;
    group.replaceChildren(el('span', { class: 'group-label', text: '区分' }));
    for (const c of state.data.categories) {
      const n = state.data.services.filter((s) => s.category === c.key).length;
      const btn = el('button', {
        type: 'button',
        class: 'toggle',
        'aria-pressed': String(state.categories.has(c.key)),
        onclick: () => {
          if (state.categories.has(c.key)) state.categories.delete(c.key); else state.categories.add(c.key);
          btn.setAttribute('aria-pressed', String(state.categories.has(c.key)));
          renderRows();
        },
      }, [c.label, el('span', { class: 'count', text: String(n) })]);
      group.append(btn);
    }
  }

  const infraValues = (s) => (Array.isArray(s.infra) ? s.infra : []);

  // チップの絞り込み（技術タグとインフラで共通）。多く使われている順に並べる
  function renderChipFilter(name, selected, valuesOf) {
    const group = $(`#${name}-filter`);
    group.replaceChildren();
    const freq = new Map();
    for (const s of state.data.services) for (const t of new Set(valuesOf(s))) freq.set(t, (freq.get(t) || 0) + 1);
    $(`#${name}-details`).hidden = !freq.size;
    // 畳んでいても、選んでいるものが分かるようにする
    const updateSummary = () => {
      $(`#${name}-summary`).textContent = selected().size ? `選択中: ${[...selected()].join(', ')}` : '';
    };
    updateSummary();
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [value, n] of sorted) {
      const btn = el('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(selected().has(value)),
        onclick: () => {
          if (selected().has(value)) selected().delete(value); else selected().add(value);
          btn.setAttribute('aria-pressed', String(selected().has(value)));
          updateSummary();
          renderRows();
        },
      }, [value, el('span', { class: 'count', text: String(n) })]);
      group.append(btn);
    }
  }

  const renderTagFilter = () => renderChipFilter('tag', () => state.tags, (s) => s.tags || []);
  const renderInfraFilter = () => renderChipFilter('infra', () => state.infra, infraValues);

  const isFiltered = () => state.query !== ''
    || state.tags.size > 0
    || state.infra.size > 0
    || state.categories.size > 0
    || state.stages.size !== DEFAULT_STAGES.length
    || DEFAULT_STAGES.some((k) => !state.stages.has(k));

  function clearFilters() {
    state.query = '';
    state.stages = new Set(DEFAULT_STAGES);
    state.tags = new Set();
    state.infra = new Set();
    state.categories = new Set();
    $('#search').value = '';
    renderStageFilter();
    renderCategoryFilter();
    renderInfraFilter();
    renderTagFilter();
    renderRows();
    $('#search').focus();
  }

  let controlsBound = false;
  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;
    // タグが多くなるので、狭い画面では最初は畳む
    const wide = window.matchMedia('(min-width: 720px)').matches;
    $('#tag-details').open = wide;
    $('#infra-details').open = wide;
    $('#clear-filters').addEventListener('click', clearFilters);
    $('#category-month').addEventListener('change', (e) => {
      state.trendMonth = e.target.value;
      renderTrends();
      $('#category-month').focus();
    });
    $('#search').addEventListener('input', (e) => {
      state.query = e.target.value.trim().toLowerCase();
      renderRows();
    });
    for (const btn of document.querySelectorAll('button.sort')) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sort;
        if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        // 番号は小さい順、キーの期限は近い順から。ほかは大きい（新しい）順から
        else state.sort = { key, dir: key === 'id' || key === 'keyExpiry' ? 'asc' : 'desc' };
        renderRows();
      });
    }
    // PDF への出力は、ブラウザの印刷に任せる（印刷の画面で「PDF に保存」を選ぶ）。外部のライブラリは足さない。
    // 印刷のあいだだけ、配色をライトにし、保存するファイルの名前になるタイトルに日付を付ける
    let titleBeforePrint = null;
    let themeBeforePrint = null;
    window.addEventListener('beforeprint', () => {
      if (titleBeforePrint !== null) return;
      titleBeforePrint = document.title;
      themeBeforePrint = document.documentElement.getAttribute('data-theme');
      const d = new Date();
      document.title = `my-services-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      document.documentElement.setAttribute('data-theme', 'light');
      // グラフの値を紙でも読めるよう、「表で見る」の表を開いて出す
      const details = $('.viz-table-details');
      details.dataset.openBeforePrint = details.open ? '1' : '';
      details.open = true;
    });
    window.addEventListener('afterprint', () => {
      if (titleBeforePrint === null) return;
      document.title = titleBeforePrint;
      if (themeBeforePrint === null) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', themeBeforePrint);
      titleBeforePrint = null;
      $('.viz-table-details').open = Boolean($('.viz-table-details').dataset.openBeforePrint);
      // 紙の幅で描いたグラフを、画面の幅で描き直す
      for (const host of document.querySelectorAll('.viz')) if (host.vizRedraw) host.vizRedraw();
    });
    $('#print').addEventListener('click', () => window.print());
    $('#lock').addEventListener('click', () => {
      storage('del');
      location.reload();
    });
  }

  function matches(s) {
    if (!state.stages.has(s.stage)) return false;
    if (state.categories.size && !state.categories.has(s.category)) return false;
    for (const t of state.tags) if (!(s.tags || []).includes(t)) return false;
    for (const t of state.infra) if (!infraValues(s).includes(t)) return false;
    if (state.query) {
      const hay = [s.name, s.description, s.note, ...(s.tags || []), ...infraValues(s), s.repo && s.repo.fullName, categoryLabel(s.category)]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  }

  function sortKey(s) {
    switch (state.sort.key) {
      case 'releasedOn': return s.releasedOn || null;
      case 'pushedAt': return (s.repo && s.repo.pushedAt) || null;
      case 'cost': return moneyOf(s) ? moneyOf(s).costJpy : null;
      case 'net': return netOf(s);
      case 'keyExpiry': return (s.keys && s.keys.nearestExpiry) || null;
      default: return s.id;
    }
  }

  function compare(a, b) {
    const ka = sortKey(a); const kb = sortKey(b);
    if (ka == null && kb == null) return a.id - b.id;
    if (ka == null) return 1;   // 値のない行は常に最後
    if (kb == null) return -1;
    let c = ka < kb ? -1 : ka > kb ? 1 : 0;
    if (state.sort.dir === 'desc') c = -c;
    return c || a.id - b.id;
  }

  function renderRows() {
    for (const btn of document.querySelectorAll('button.sort')) {
      const th = btn.closest('th');
      if (btn.dataset.sort === state.sort.key) {
        btn.dataset.dir = state.sort.dir;
        th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      } else {
        delete btn.dataset.dir;
        th.removeAttribute('aria-sort');
      }
    }
    const tbody = $('#rows');
    tbody.replaceChildren();
    const rows = state.data.services.filter(matches).sort(compare);
    $('#empty').hidden = rows.length > 0;
    $('.table-wrap').hidden = rows.length === 0;
    $('#result-count').textContent = `${rows.length} / ${state.data.services.length} 件を表示`;
    $('#clear-filters').hidden = !isFiltered();
    renderFilteredSummary(rows);
    for (const s of rows) {
      tbody.append(renderRow(s));
      if (state.expanded.has(s.id)) tbody.append(renderDetail(s));
    }
  }

  function uptimeDot(s) {
    const u = s.uptime;
    let cls = 'dot-none';
    let title = '未監視';
    if (u) {
      const st = u.status;
      cls = st === 'UP' ? 'dot-up' : (st === 'DOWN' || st === 'LOOKS_DOWN') ? 'dot-down' : 'dot-idle';
      const bits = [STATUS_LABEL[st] || st];
      if (typeof u.ratio24h === 'number') bits.push(`24h 稼働率 ${u.ratio24h.toFixed(u.ratio24h === 100 ? 0 : 2)}%`);
      if (u.lastIncidentAt) bits.push(`最後の障害 ${fmtDateTime(u.lastIncidentAt)}`);
      title = bits.join(' ・ ');
    }
    return el('i', { class: `dot ${cls}`, title, role: 'img', 'aria-label': title });
  }

  function stageBadge(s) {
    const def = STAGES.find((x) => x.key === s.stage);
    return el('span', { class: `badge badge-${s.stage}`, text: def ? def.label : s.stage });
  }

  function tagList(tags, limit) {
    const wrap = el('div', { class: 'tags' });
    const shown = limit ? tags.slice(0, limit) : tags;
    for (const t of shown) wrap.append(el('span', { class: 'tag', text: t }));
    if (limit && tags.length > limit) {
      wrap.append(el('span', { class: 'tag more', text: `+${tags.length - limit}`, title: tags.slice(limit).join(', ') }));
    }
    return wrap;
  }

  // 1 行に 1 つ出す。なければ — だけを出す
  function infraList(s) {
    const values = infraValues(s);
    if (!values.length) return el('span', { class: 'none', text: '—' });
    return el('ul', { class: 'infra' }, values.map((v) => el('li', { text: v })));
  }

  function iconLink(kind, rawHref, label) {
    const href = safeUrl(rawHref);
    if (!href) return el('span', { class: 'icon-link disabled', 'aria-hidden': 'true' }, svgIcon(kind));
    return el('a', {
      class: 'icon-link', href, target: '_blank', rel: 'noopener', title: label, 'aria-label': label,
      onclick: (e) => e.stopPropagation(),
    }, svgIcon(kind));
  }

  function renderRow(s) {
    // 全体を描き直すとボタンのフォーカスが失われるので、詳細の行だけを足し引きする
    const toggle = () => {
      const open = !state.expanded.has(s.id);
      if (open) {
        state.expanded.add(s.id);
        tr.after(renderDetail(s));
      } else {
        state.expanded.delete(s.id);
        tr.nextElementSibling.remove();
      }
      nameBtn.setAttribute('aria-expanded', String(open));
    };
    const rowClass = ['row', s.stage === 'retired' ? 'is-retired' : null, isDown(s) ? 'is-down' : null].filter(Boolean).join(' ');
    const tr = el('tr', { class: rowClass, onclick: toggle });

    tr.append(el('td', { class: 'id', text: `#${String(s.id).padStart(3, '0')}` }));
    tr.append(el('td', { class: 'up' }, uptimeDot(s)));

    const nameBtn = el('button', {
      type: 'button', class: 'name', text: s.name, 'aria-expanded': String(state.expanded.has(s.id)),
      onclick: (e) => { e.stopPropagation(); toggle(); },
    });
    const nameCell = el('td', { class: 'name-cell' }, nameBtn);
    // 点の色とツールチップに頼らず、停止は文字でも出す
    if (isDown(s)) nameCell.append(el('span', { class: 'down-flag', text: STATUS_LABEL[s.uptime.status] }));
    if (s.description) nameCell.append(el('span', { class: 'desc', text: s.description }));
    tr.append(nameCell);

    const stageCell = el('td', { class: 'stage' }, stageBadge(s));
    if (s.repo && s.repo.archived) stageCell.append(el('span', { class: 'flag', text: 'archived' }));
    if (s.category) stageCell.append(el('span', { class: 'category', text: categoryLabel(s.category) }));
    tr.append(stageCell);

    tr.append(el('td', { class: 'infra-cell' }, infraList(s)));
    tr.append(el('td', { class: 'tags-cell' }, tagList(s.tags || [], 3)));

    // 見出しのない狭い画面でも読めるように、金額とキーにはセルの中にも名前を付ける
    const amount = (label, value, cls) => el('span', { class: `amt ${cls || ''}` }, [
      el('span', { class: 'amt-label', text: label }),
      el('span', { class: 'amt-value', text: value }),
    ]);
    const none = () => el('span', { class: 'none', text: '—' });
    const money = moneyOf(s);
    const net = netOf(s);
    tr.append(el('td', { class: 'money metric' }, money
      ? [amount('費用', yen(money.costJpy)), amount('収益', yen(money.revenueJpy)), money.provisional ? provisionalFlag() : null]
      : [el('span', { class: 'amt-label', text: '費用' }), none()]));
    tr.append(el('td', { class: 'net metric' }, net != null
      ? amount('差し引き', signedYen(net), netClass(net))
      : [el('span', { class: 'amt-label', text: '差し引き' }), none()]));

    const keysCell = el('td', { class: 'keys metric' }, el('span', { class: 'amt-label', text: 'キー' }));
    if (s.keys) {
      const exp = expiryOf(s);
      keysCell.append(el('span', { class: 'key-count', text: `${s.keys.count} 本` }));
      if (s.keys.nearestExpiry) keysCell.append(el('span', { class: 'expiry', text: `${s.keys.nearestExpiry} まで` }));
      else if (s.keys.count > 0) keysCell.append(el('span', { class: 'expiry', text: '期限なし' }));
      const flag = expiryFlag(exp);
      if (flag) keysCell.append(flag);
    } else {
      keysCell.append(none());
    }
    tr.append(keysCell);

    const released = fmtDate(s.releasedOn);
    tr.append(el('td', { class: 'date released', 'data-label': '公開' },
      released ? el('span', { text: released }) : el('span', { class: 'none', text: '—' })));

    const pushed = s.repo && s.repo.pushedAt;
    tr.append(el('td', { class: 'date pushed', 'data-label': '更新' },
      pushed ? el('span', { text: relTime(pushed), title: fmtDateTime(pushed) }) : el('span', { class: 'none', text: '—' })));

    tr.append(el('td', { class: 'links' }, [
      iconLink('site', s.url, 'サイトを開く'),
      iconLink('repo', s.repo && s.repo.url, 'リポジトリを開く'),
    ]));
    return tr;
  }

  function renderDetail(s) {
    const td = el('td', { colspan: '12' });
    if (s.description) td.append(el('p', { class: 'full-desc', text: s.description }));
    if (s.note) td.append(el('p', { class: 'note', text: s.note }));

    const grid = el('div', { class: 'grid' });
    const dl = (items) => {
      const d = el('dl');
      for (const [k, v] of items) {
        if (v == null || v === '') continue;
        d.append(el('dt', { text: k }));
        d.append(el('dd', {}, typeof v === 'string' ? v : v));
      }
      return d;
    };

    const r = s.repo;
    if (r) {
      const releaseDate = r.latestRelease && fmtDate(r.latestRelease.publishedAt);
      const latest = r.latestRelease
        ? `${r.latestRelease.tag}${releaseDate ? `（${releaseDate}）` : ''}`
        : 'なし';
      grid.append(dl([
        ['リポジトリ', safeUrl(r.url) ? el('a', { href: r.url, target: '_blank', rel: 'noopener', text: r.fullName }) : r.fullName],
        ['最新リリース', latest],
        ['最終 push', fmtDateTime(r.pushedAt)],
        ['状態', [r.private ? '非公開' : '公開', r.archived ? 'アーカイブ済み' : null].filter(Boolean).join(' ・ ')],
      ]));
    } else {
      grid.append(dl([['リポジトリ', '未設定']]));
    }

    const u = s.uptime;
    if (u) {
      grid.append(dl([
        ['死活', isDown(s) ? el('span', { class: 'down-text', text: STATUS_LABEL[u.status] }) : (STATUS_LABEL[u.status] || u.status)],
        ['24 時間の稼働率', typeof u.ratio24h === 'number' ? `${u.ratio24h.toFixed(2)}%` : null],
        ['最後の障害', u.lastIncidentAt ? fmtDateTime(u.lastIncidentAt) : 'なし'],
        ['monitor ID', u.monitorId != null ? String(u.monitorId) : null],
      ]));
    } else {
      grid.append(dl([['死活', '未監視']]));
    }

    if (hasMetrics()) {
      const monthLine = (key) => {
        const m = moneyOf(s, key);
        if (!monthName(key)) return null;
        return m ? `費用 ${yen(m.costJpy)} ・ 収益 ${yen(m.revenueJpy)} ・ 差し引き ${signedYen(netOf(s, key))}` : '未入力';
      };
      const shown = moneyOf(s);
      // 取得元ごとの費用があれば、取得元ごとに 1 行で出す（金額、内訳、取り込んだ日、暫定の印）。無ければ月の内訳だけ
      const sources = shown && Array.isArray(shown.sources) && shown.sources.length ? shown.sources : null;
      const breakdown = sources
        ? el('ul', { class: 'cost-sources' }, sources.map((e) => {
          const detail = breakdownText(e.breakdown);
          const when = fmtDate(e.updatedAt);
          return el('li', {}, [
            el('span', { class: 'source-name', text: sourceLabel(e.source) }),
            ` ${yen(e.costJpy)}`,
            detail ? `（${detail}）` : null,
            when ? el('span', { class: 'source-when', text: ` ${when} に取り込み` }) : null,
            e.provisional ? provisionalFlag() : null,
          ]);
        }))
        : breakdownText(shown && shown.breakdown);
      const exp = expiryOf(s);
      const k = s.keys;
      grid.append(dl([
        [`今月（${monthName('current') || '—'}）`, monthLine('current')],
        [`先月（${monthName('previous') || '—'}）`, monthLine('previous')],
        [`費用の${sources ? '取得元' : '内訳'}（${monthName(state.month) || '—'}）`, breakdown],
        ['キー', k ? `${k.count} 本` : '未入力'],
        ['いちばん近い期限', k ? el('span', {}, [k.nearestExpiry || 'なし', expiryFlag(exp)]) : null],
        ['キーを確かめた日', k ? fmtDate(k.checkedAt) : null],
      ]));
    }

    grid.append(dl([
      ['区分', categoryLabel(s.category)],
      ['URL', safeUrl(s.url) ? el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.url }) : (s.url || '未設定')],
      ['公開日', fmtDate(s.releasedOn)],
      ['インフラ', infraValues(s).join(', ') || '不明'],
      ['技術', (s.tags && s.tags.length) ? tagList(s.tags) : null],
    ]));

    td.append(grid);

    // そのサービスの月ごとの費用と収益。金額の入っている月が無ければ出さない
    const months = trendMonths().filter((m) => historyOf(s, m));
    if (months.length) {
      const first = trendMonths().indexOf(months[0]);
      const rows = trendMonths().slice(first).map((m) => {
        const h = historyOf(s, m);
        return { month: m, values: { cost: h ? h.costJpy : null, revenue: h ? h.revenueJpy : null } };
      });
      const columns = [[SERIES.cost], [SERIES.revenue]];
      const host = el('div', { class: 'viz' });
      td.append(el('div', { class: 'service-trend' }, [
        el('h3', { text: '月ごとの費用と収益' }),
        legend(columns.flat()),
        host,
      ]));
      drawChart(host, rows, columns, { height: 150, label: `${s.name} の月ごとの費用と収益` });
    }
    return el('tr', { class: 'detail' }, td);
  }

  // ---------- 推移と集計 ----------

  // グラフの系列。色は系列に付けて固定する（表示する系列が減っても、残った系列の色は変えない）
  const SERIES = {
    cost: { key: 'cost', label: '費用', cls: 'viz-s1' },
    serviceCost: { key: 'serviceCost', label: 'サービスごとの費用', cls: 'viz-s1' },
    sharedCost: { key: 'sharedCost', label: '共通の費用', cls: 'viz-s2' },
    revenue: { key: 'revenue', label: '収益', cls: 'viz-s3' },
  };

  // 出力に入っている月（古い順）。12 か月分の出力が無いとき（古い形のデータ）は、先月と今月だけ
  function trendMonths() {
    const m = state.data.months;
    if (!m) return [];
    if (Array.isArray(m.list) && m.list.length) return m.list;
    return [m.previous, m.current].filter(Boolean);
  }

  // ある月（YYYY-MM）の、サービスの費用と収益。行が無ければ null
  function historyOf(s, month) {
    const money = s.money;
    if (!money) return null;
    if (money.history && money.history[month]) return money.history[month];
    const m = state.data.months || {};
    if (month === m.current) return money.current || null;
    if (month === m.previous) return money.previous || null;
    return null;
  }
  const sharedIn = (month) => (state.data.sharedCosts || []).filter((c) => c.month === month);

  // 月ごとの合計。金額が 1 件も入っていない月は entered を false にする
  function monthTotals(month) {
    const entered = state.data.services.map((s) => historyOf(s, month)).filter(Boolean);
    const shared = sharedIn(month);
    const serviceCost = entered.reduce((sum, h) => sum + h.costJpy, 0);
    const sharedCost = shared.reduce((sum, c) => sum + c.costJpy, 0);
    const revenue = entered.reduce((sum, h) => sum + h.revenueJpy, 0);
    return { month, entered: entered.length > 0 || shared.length > 0, serviceCost, sharedCost, revenue, net: revenue - serviceCost - sharedCost };
  }

  // 区分ごとの集計。共通の費用は、区分が付いていればその区分に、付いていなければ「共通」に入れる。
  // 行の合計は、月の合計（monthTotals）と一致する
  function categoryRows(month) {
    const rows = new Map();
    const rowOf = (key, label) => {
      if (!rows.has(key)) rows.set(key, { key, label, serviceCost: 0, sharedCost: 0, revenue: 0, count: 0 });
      return rows.get(key);
    };
    for (const c of state.data.categories || []) rowOf(c.key, c.label);
    for (const s of state.data.services) {
      const h = historyOf(s, month);
      if (!h) continue;
      const row = rowOf(s.category || '', s.category ? categoryLabel(s.category) : '（区分なし）');
      row.serviceCost += h.costJpy;
      row.revenue += h.revenueJpy;
      row.count++;
    }
    for (const c of sharedIn(month)) {
      const row = c.category ? rowOf(c.category, categoryLabel(c.category)) : rowOf('\u0000shared', '共通');
      row.sharedCost += c.costJpy;
      row.count++;
    }
    return [...rows.values()].map((r) => ({ ...r, cost: r.serviceCost + r.sharedCost, net: r.revenue - r.serviceCost - r.sharedCost }));
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  // 軸の上端と目盛りの間隔を、切りのよい数にする（目盛りは 5 本まで）
  function niceScale(max) {
    if (!(max > 0)) return { top: 1000, step: 500 };
    const pow = 10 ** Math.floor(Math.log10(max));
    const step = [0.2, 0.5, 1, 2, 5, 10].map((k) => k * pow).find((st) => max / st <= 5);
    return { top: Math.ceil(max / step) * step, step };
  }
  // 目盛りの数字。1 万円以上の軸は「万」でまとめ、1 つの軸の中で書き方をそろえる
  const axisLabel = (v, top) => (top >= 10000 ? (v === 0 ? '0' : `${Number((v / 10000).toFixed(2))}万`) : v.toLocaleString('ja-JP'));

  function legend(seriesList) {
    return el('div', { class: 'viz-legend' }, seriesList.map((sr) => el('span', { class: 'viz-legend-item' }, [
      el('i', { class: `viz-swatch ${sr.cls}` }),
      sr.label,
    ])));
  }

  // 幅が変わったら描き直す。host ごとに、最後に描いた幅と描き直す関数を持つ
  const chartObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
      for (const e of entries) {
        const host = e.target;
        if (host.isConnected && host.vizRedraw && Math.round(e.contentRect.width) !== host.vizWidth) host.vizRedraw();
      }
    })
    : null;

  /**
   * 月ごとの棒グラフを SVG で描く。外部のライブラリは使わない。
   * rows は [{ month, values: { 系列のキー: 金額か null } }]、columns は月ごとに並べる棒の列で、
   * 1 本の棒は下から積む系列の配列（例: [[サービスごとの費用, 共通の費用], [収益]]）。縦軸は 1 本だけ。
   * 色だけに頼らないよう、凡例、月ごとの値の吹き出し（ホバーとフォーカス）、表（呼び出し側）を併せて出す。
   */
  function drawChart(host, rows, columns, { height = 220, label = '', selected = null, onSelect = null } = {}) {
    host.vizRedraw = () => drawChart(host, rows, columns, { height, label, selected, onSelect });
    if (chartObserver) chartObserver.observe(host);
    const hadFocus = host.contains(document.activeElement) ? document.activeElement.dataset.month : null;
    const width = Math.max(Math.round(host.clientWidth), 260);
    host.vizWidth = Math.round(host.clientWidth);
    const m = { top: 10, right: 8, bottom: 38, left: 44 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    // 月が少ないときに棒の間が開きすぎないよう、1 か月の幅に上限を置いて左に寄せる
    const band = Math.min(plotW / rows.length, 84);
    const gap = 2;
    const barW = Math.max(3, Math.min(24, (band - 8 - gap * (columns.length - 1)) / columns.length));
    const groupW = barW * columns.length + gap * (columns.length - 1);
    const total = (row, col) => col.reduce((sum, sr) => sum + (row.values[sr.key] || 0), 0);
    const { top, step } = niceScale(Math.max(0, ...rows.flatMap((r) => columns.map((c) => total(r, c)))));
    const y = (v) => m.top + plotH - (v / top) * plotH;

    const svg = svgEl('svg', { class: 'viz-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': label });
    for (let v = 0; v <= top + step / 2; v += step) {
      svg.append(svgEl('line', { class: v === 0 ? 'viz-axis' : 'viz-grid', x1: m.left, x2: width - m.right, y1: y(v), y2: y(v) }));
      svg.append(svgEl('text', { class: 'viz-tick', x: m.left - 6, y: y(v) + 4, 'text-anchor': 'end', text: axisLabel(v, top) }));
    }

    const tip = el('div', { class: 'viz-tip', hidden: true, role: 'status' });
    const showTip = (row, centerX) => {
      const seriesList = columns.flat();
      const has = seriesList.some((sr) => row.values[sr.key] != null);
      tip.replaceChildren(
        el('div', { class: 'viz-tip-title', text: row.month }),
        ...(has
          ? seriesList.map((sr) => el('div', { class: 'viz-tip-row' }, [
            el('i', { class: `viz-swatch ${sr.cls}` }),
            el('span', { class: 'viz-tip-label', text: sr.label }),
            el('span', { class: 'viz-tip-value', text: row.values[sr.key] == null ? '—' : yen(row.values[sr.key]) }),
          ]))
          : [el('div', { class: 'viz-tip-row', text: '金額は入っていません' })]),
      );
      if (has && row.net != null) {
        tip.append(el('div', { class: 'viz-tip-row viz-tip-net' }, [
          el('span', { class: 'viz-tip-label', text: '差し引き' }),
          el('span', { class: `viz-tip-value ${netClass(row.net)}`, text: signedYen(row.net) }),
        ]));
      }
      tip.hidden = false;
      // 棒に重ねないよう、その月の右隣に出す。右に入らなければ左隣に出す
      const w = tip.offsetWidth;
      const right = centerX + band / 2 + 6;
      const side = right + w <= width ? right : centerX - band / 2 - 6 - w;
      // スマホ幅では、横に出すとほかの月の棒を隠すので、グラフの下に、その月に寄せて出す
      const below = width < 480 || side < 0;
      tip.style.top = below ? '100%' : '0';
      tip.style.left = `${Math.max(0, Math.min(width - w, below ? centerX - w / 2 : side))}px`;
    };
    const hideTip = () => { tip.hidden = true; };
    let restoringFocus = false;

    rows.forEach((row, i) => {
      const x0 = m.left + i * band;
      const center = x0 + band / 2;
      const parts = columns.flat().map((sr) => `${sr.label} ${row.values[sr.key] == null ? 'なし' : yen(row.values[sr.key])}`);
      const g = svgEl('g', {
        class: `viz-band${row.month === selected ? ' is-selected' : ''}`,
        tabindex: '0',
        role: onSelect ? 'button' : 'img',
        'aria-label': `${row.month}: ${parts.join('、')}${onSelect ? '。押すと、この月の集計を出します' : ''}`,
        'aria-pressed': onSelect ? String(row.month === selected) : null,
        'data-month': row.month,
      });
      // 月の幅いっぱいを、ホバーとクリックの当たり判定にする（棒より広く取る）
      g.append(svgEl('rect', { class: 'viz-hit', x: x0, y: m.top, width: band, height: plotH + m.bottom }));
      columns.forEach((col, j) => {
        const x = x0 + (band - groupW) / 2 + j * (barW + gap);
        const segments = col.filter((sr) => (row.values[sr.key] || 0) > 0);
        let base = 0;
        segments.forEach((sr, k) => {
          const v = row.values[sr.key];
          const yb = y(base) - (k > 0 ? gap : 0); // 積んだ系列の間は、地の色のすき間で分ける
          const yt = Math.min(y(base + v), yb - 1);
          const r = k === segments.length - 1 ? Math.min(4, (yb - yt), barW / 2) : 0; // 丸めるのは先端だけ。基線の側は四角
          g.append(svgEl('path', {
            class: `viz-bar ${sr.cls}`,
            d: `M${x},${yb}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + barW - r}Q${x + barW},${yt} ${x + barW},${yt + r}V${yb}Z`,
          }));
          base += v;
        });
      });
      const [year, mon] = row.month.split('-');
      g.append(svgEl('text', { class: 'viz-tick', x: center, y: m.top + plotH + 16, 'text-anchor': 'middle', text: String(Number(mon)) }));
      // 年は、左端の月と 1 月にだけ出す。左端のすぐあとに 1 月が来て文字が重なるときは、左端の分を出さない
      const nextJan = rows.findIndex((r, k) => k > 0 && r.month.endsWith('-01'));
      const crowded = i === 0 && mon !== '01' && nextJan > 0 && nextJan * band < 64;
      if ((i === 0 || mon === '01') && !crowded) {
        g.append(svgEl('text', { class: 'viz-tick viz-year', x: center, y: m.top + plotH + 31, 'text-anchor': i === 0 ? 'start' : 'middle', dx: i === 0 ? -band / 2 + 2 : 0, text: `${year}年` }));
      }
      g.addEventListener('pointerenter', () => showTip(row, center));
      g.addEventListener('pointerleave', hideTip);
      // スマホ幅で月を押して選んだあとは、吹き出しを出し直さない（下に出すので、選んだ月の集計の見出しを隠してしまう）
      g.addEventListener('focus', () => { if (!(restoringFocus && width < 480)) showTip(row, center); });
      g.addEventListener('blur', hideTip);
      if (onSelect) {
        g.addEventListener('click', () => onSelect(row.month));
        g.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onSelect(row.month);
        });
      }
      svg.append(g);
    });

    host.replaceChildren(svg, tip);
    if (hadFocus) {
      const again = host.querySelector(`[data-month="${hadFocus}"]`);
      restoringFocus = true;
      if (again) again.focus();
      restoringFocus = false;
    }
  }

  function setView(view) {
    state.view = view;
    renderViewSwitch();
    $('#list-view').hidden = view !== 'list';
    $('#trends-view').hidden = view !== 'trends';
    if (view === 'trends') renderTrends();
  }

  function renderViewSwitch() {
    const sw = $('#view-switch');
    // 月ごとの金額が出力に無いときは、切り替えそのものを出さない
    sw.hidden = !state.data.months;
    if (sw.hidden) return;
    const hadFocus = sw.contains(document.activeElement);
    sw.replaceChildren(...[['list', '一覧'], ['trends', '推移と集計']].map(([key, label]) => el('button', {
      type: 'button',
      class: 'toggle',
      'aria-pressed': String(state.view === key),
      text: label,
      onclick: () => setView(key),
    })));
    if (hadFocus) sw.querySelector('[aria-pressed="true"]').focus();
  }

  const num = (text, cls) => el('td', { class: `num ${cls || ''}`, text });

  function renderTrends() {
    // 金額が入っている最初の月から出す。1 件も無ければ、今月だけを空で出す
    const all = trendMonths().map(monthTotals);
    const firstEntered = all.findIndex((t) => t.entered);
    const totals = firstEntered >= 0 ? all.slice(firstEntered) : all.slice(-1);
    const months = totals.map((t) => t.month);
    if (!months.includes(state.trendMonth)) state.trendMonth = months[months.length - 1];

    $('#trend-note').textContent = firstEntered >= 0
      ? `${months[0]} から ${months[months.length - 1]} まで。費用は、サービスごとの費用の上に共通の費用を積んでいます。月が締まる前の金額を含むことがあります。`
      : '金額は、まだ入っていません。';

    const columns = [[SERIES.serviceCost, SERIES.sharedCost], [SERIES.revenue]];
    $('#trend-legend').replaceChildren(...legend(columns.flat()).children);
    const rows = totals.map((t) => ({
      month: t.month,
      net: t.net,
      values: t.entered ? { serviceCost: t.serviceCost, sharedCost: t.sharedCost, revenue: t.revenue } : {},
    }));
    drawChart($('#trend-chart'), rows, columns, {
      label: '月ごとの費用と収益のグラフ',
      selected: state.trendMonth,
      onSelect: (month) => { state.trendMonth = month; renderTrends(); },
    });

    const none = () => el('td', { class: 'num none', text: '—' });
    $('#trend-table').replaceChildren(
      el('thead', {}, el('tr', {}, [
        el('th', { scope: 'col', text: '月' }),
        ...['サービスごとの費用', '共通の費用', '費用の合計', '収益', '差し引き'].map((t) => el('th', { scope: 'col', class: 'num', text: t })),
      ])),
      el('tbody', {}, [...totals].reverse().map((t) => el('tr', {}, [
        el('th', { scope: 'row', text: t.month }),
        ...(t.entered
          ? [num(yen(t.serviceCost)), num(yen(t.sharedCost)), num(yen(t.serviceCost + t.sharedCost)), num(yen(t.revenue)), num(signedYen(t.net), netClass(t.net))]
          : [none(), none(), none(), none(), none()]),
      ]))),
    );

    const select = $('#category-month');
    select.replaceChildren(...[...months].reverse().map((mo) => el('option', { value: mo, text: mo })));
    select.value = state.trendMonth;
    renderCategoryTable();
  }

  function renderCategoryTable() {
    const month = state.trendMonth;
    const rows = categoryRows(month);
    const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0);
    const cells = (r, empty) => (empty
      ? Array.from({ length: 5 }, () => el('td', { class: 'num none', text: '—' }))
      : [num(yen(r.serviceCost)), num(yen(r.sharedCost)), num(yen(r.cost)), num(yen(r.revenue)), num(signedYen(r.net), netClass(r.net))]);
    const any = rows.some((r) => r.count > 0);
    $('#category-title').textContent = `区分ごとの集計（${month}）`;
    $('#category-table').replaceChildren(
      el('thead', {}, el('tr', {}, [
        el('th', { scope: 'col', text: '区分' }),
        ...['サービスごとの費用', '共通の費用', '費用の合計', '収益', '差し引き'].map((t) => el('th', { scope: 'col', class: 'num', text: t })),
      ])),
      // 金額が 1 件も入っていない区分は、0 円と区別するために — を出す
      el('tbody', {}, rows.map((r) => el('tr', {}, [el('th', { scope: 'row', text: r.label }), ...cells(r, r.count === 0)]))),
      el('tfoot', {}, el('tr', {}, [
        el('th', { scope: 'row', text: '合計' }),
        ...cells({ serviceCost: sum('serviceCost'), sharedCost: sum('sharedCost'), cost: sum('cost'), revenue: sum('revenue'), net: sum('net') }, !any),
      ])),
    );
  }

  main();
})();
