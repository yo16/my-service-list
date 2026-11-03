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
    sort: { key: 'id', dir: 'asc' },
    expanded: new Set(),
  };

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
    renderMeta();
    renderStageFilter();
    renderTagFilter();
    renderLegend();
    bindControls();
    renderRows();
  }

  function renderLegend() {
    $('#legend-site').replaceChildren(svgIcon('site'), 'サイト');
    $('#legend-repo').replaceChildren(svgIcon('repo'), 'リポジトリ');
    $('#lock').hidden = !storage('get');
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

  function renderTagFilter() {
    const group = $('#tag-filter');
    group.replaceChildren();
    const freq = new Map();
    for (const s of state.data.services) for (const t of s.tags || []) freq.set(t, (freq.get(t) || 0) + 1);
    $('#tag-details').hidden = !freq.size;
    updateTagSummary();
    if (!freq.size) return;
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [tag, n] of sorted) {
      const btn = el('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(state.tags.has(tag)),
        onclick: () => {
          if (state.tags.has(tag)) state.tags.delete(tag); else state.tags.add(tag);
          btn.setAttribute('aria-pressed', String(state.tags.has(tag)));
          updateTagSummary();
          renderRows();
        },
      }, [tag, el('span', { class: 'count', text: String(n) })]);
      group.append(btn);
    }
  }

  // 畳んでいても、選んでいるタグが分かるようにする
  function updateTagSummary() {
    $('#tag-summary').textContent = state.tags.size ? `選択中: ${[...state.tags].join(', ')}` : '';
  }

  const isFiltered = () => state.query !== ''
    || state.tags.size > 0
    || state.stages.size !== DEFAULT_STAGES.length
    || DEFAULT_STAGES.some((k) => !state.stages.has(k));

  function clearFilters() {
    state.query = '';
    state.stages = new Set(DEFAULT_STAGES);
    state.tags = new Set();
    $('#search').value = '';
    renderStageFilter();
    renderTagFilter();
    renderRows();
    $('#search').focus();
  }

  let controlsBound = false;
  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;
    // タグが多くなるので、狭い画面では最初は畳む
    $('#tag-details').open = window.matchMedia('(min-width: 720px)').matches;
    $('#clear-filters').addEventListener('click', clearFilters);
    $('#search').addEventListener('input', (e) => {
      state.query = e.target.value.trim().toLowerCase();
      renderRows();
    });
    for (const btn of document.querySelectorAll('button.sort')) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sort;
        if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        else state.sort = { key, dir: key === 'id' ? 'asc' : 'desc' };
        renderRows();
      });
    }
    $('#lock').addEventListener('click', () => {
      storage('del');
      location.reload();
    });
  }

  function matches(s) {
    if (!state.stages.has(s.stage)) return false;
    for (const t of state.tags) if (!(s.tags || []).includes(t)) return false;
    if (state.query) {
      const hay = [s.name, s.description, s.note, ...(s.tags || []), s.repo && s.repo.fullName]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(state.query)) return false;
    }
    return true;
  }

  function sortKey(s) {
    switch (state.sort.key) {
      case 'releasedOn': return s.releasedOn || null;
      case 'pushedAt': return (s.repo && s.repo.pushedAt) || null;
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
    tr.append(stageCell);

    tr.append(el('td', { class: 'tags-cell' }, tagList(s.tags || [], 3)));

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
    const td = el('td', { colspan: '8' });
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

    grid.append(dl([
      ['URL', safeUrl(s.url) ? el('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.url }) : (s.url || '未設定')],
      ['公開日', fmtDate(s.releasedOn)],
      ['技術', (s.tags && s.tags.length) ? tagList(s.tags) : null],
    ]));

    td.append(grid);
    return el('tr', { class: 'detail' }, td);
  }

  main();
})();
