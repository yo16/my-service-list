/* my-service-list: キーの期限の通知（何を知らせ、何を閉じるかを決める部分。通信はしない）
 *
 * 通知は、このリポジトリの GitHub の Issue で行う（scripts/notify-key-expiry.mjs）。
 * 「同じ内容を 1 回だけ送る」ための記録は、Issue そのものに持つ。Issue の本文に、通し番号、期限の日付、段階を
 * 書いた目印を入れておき、同じ目印の Issue が（閉じたものも含めて）あれば、もう作らない。
 * リポジトリは公開なので、Issue に書くのは通し番号と日数までにし、サービス名は書かない。
 */

/** 通知の Issue に付けるラベル。この名前で探すので、変えると過去の通知を見つけられなくなる */
export const LABEL = 'key-expiry';

/** 段階。期限までの日数がこの順で最初に当たったものを採る */
const STAGES = [
  { key: 'expired', matches: (days) => days < 0 },
  { key: 'd7', matches: (days) => days <= 7 },
  { key: 'd30', matches: (days) => days <= 30 },
];

/** 基準の時刻の、日本時間での日付（YYYY-MM-DD） */
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** today から expiry までの日数（どちらも YYYY-MM-DD）。過ぎていれば負 */
export function daysUntil(expiry, today) {
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

/** 期限までの日数から段階を決める。30 日より先なら null（知らせない） */
export function stageOf(days) {
  const hit = STAGES.find((s) => s.matches(days));
  return hit ? hit.key : null;
}

const MARKER_RE = /<!-- key-expiry:(\d+):(\d{4}-\d{2}-\d{2}):(expired|d7|d30) -->/;
export const markerOf = ({ id, expiry, stage }) => `<!-- key-expiry:${id}:${expiry}:${stage} -->`;

/** Issue の本文から目印を読む。無ければ null */
export function parseMarker(body) {
  const m = MARKER_RE.exec(String(body || ''));
  return m ? { id: Number(m[1]), expiry: m[2], stage: m[3] } : null;
}

const no = (id) => `#${String(id).padStart(3, '0')}`;

/** 通知の Issue の件名と本文。載せるのは通し番号と日数まで */
export function issueContent({ id, expiry, stage, days }) {
  const state = stage === 'expired'
    ? '期限が切れています'
    : `期限まであと ${days} 日です（${stage === 'd7' ? '7' : '30'} 日以内）`;
  const title = `キーの期限: ${no(id)} は${stage === 'expired' ? '期限切れ' : `あと ${days} 日`}`;
  const body = [
    `通し番号 ${no(id)} のサービスが使う API キーのうち、いちばん近い${state}。日数は、この Issue を作った時点のものです。`,
    '',
    '- どのサービスかは、一覧ページか登録画面で、通し番号から確かめてください。',
    '- キーを更新したら、キーの本数と期限を取り込み直してください。次の同期で、この Issue は自動で閉じます。',
    '- 同じ期限について、この段階の通知は 1 回だけです。期限が近づいて段階が進むと、新しい Issue で知らせます。',
    '',
    markerOf({ id, expiry, stage }),
  ].join('\n');
  return { title, body };
}

/**
 * 何を知らせ、何を閉じるかを決める。
 *
 * @param {{ service_id: number, nearest_expiry: string|null }[]} keys service_keys の行
 * @param {{ number: number, state: string, body: string }[]} issues ラベル key-expiry の Issue（閉じたものを含む）
 * @param {string} today 今日の日付（YYYY-MM-DD）
 * @returns {{ create: { id: number, expiry: string, stage: string, days: number }[], close: number[] }}
 *   create は新しく作る通知、close は閉じる Issue の番号（段階が進んだ、期限が変わった、期限のあるキーが無くなった）
 */
export function planNotifications(keys, issues, today) {
  const current = new Map();
  for (const k of keys) {
    if (!k.nearest_expiry) continue;
    const days = daysUntil(k.nearest_expiry, today);
    const stage = stageOf(days);
    if (stage) current.set(Number(k.service_id), { id: Number(k.service_id), expiry: k.nearest_expiry, stage, days });
  }

  const sent = new Set();
  const close = [];
  for (const issue of issues) {
    const m = parseMarker(issue.body);
    if (!m) continue;
    sent.add(markerOf(m));
    const now = current.get(m.id);
    if (issue.state === 'open' && (!now || markerOf(now) !== markerOf(m))) close.push(issue.number);
  }

  const create = [...current.values()].filter((c) => !sent.has(markerOf(c))).sort((a, b) => a.id - b.id);
  return { create, close };
}
