// インフラ（配信先、DB、外部サービスなど）の判定。同期ジョブ（build.mjs）と登録画面（admin.mjs）で共有する。
// 外から見える印だけで推定するので、GCE や Cloud SQL のように印が出ないものは判定できない。
// そのときは Supabase の infra 列に手で入れる（判定の結果に足される。-Name と書くと判定の結果から除く）。

/** サイトのホスト名の末尾と配信先 */
const HOST_SUFFIXES = [
  ['github.io', 'GitHub Pages'],
  ['vercel.app', 'Vercel'],
  ['netlify.app', 'Netlify'],
  ['pages.dev', 'Cloudflare Pages'],
  ['workers.dev', 'Cloudflare Workers'],
  ['web.app', 'Firebase Hosting'],
  ['firebaseapp.com', 'Firebase Hosting'],
  ['run.app', 'Cloud Run'],
  ['appspot.com', 'App Engine'],
  ['fly.dev', 'Fly.io'],
  ['onrender.com', 'Render'],
  ['railway.app', 'Railway'],
  ['herokuapp.com', 'Heroku'],
  ['amplifyapp.com', 'AWS Amplify'],
  ['azurestaticapps.net', 'Azure Static Web Apps'],
  ['azurewebsites.net', 'Azure App Service'],
];

/** 応答ヘッダーから配信先が 1 つに決まるもの。[ヘッダー名, 値の正規表現（なければ存在だけを見る）, 配信先] */
const HEADER_RULES = [
  ['x-vercel-id', null, 'Vercel'],
  ['server', /^vercel/i, 'Vercel'],
  ['server', /^github\.com/i, 'GitHub Pages'],
  ['x-nf-request-id', null, 'Netlify'],
  ['server', /^netlify/i, 'Netlify'],
  ['fly-request-id', null, 'Fly.io'],
  ['rndr-id', null, 'Render'],
  ['x-render-origin-server', null, 'Render'],
  ['x-railway-request-id', null, 'Railway'],
  ['server', /^heroku/i, 'Heroku'],
  ['via', /vegur/i, 'Heroku'],
  ['server', /^amazons3/i, 'Amazon S3'],
];

/** 手前に別のものが隠れていることがあるヘッダー。ほかの手がかりがないときだけ使う */
const WEAK_HEADER_RULES = [
  ['server', /^cloudflare/i, 'Cloudflare'],
  ['server', /^google frontend/i, 'Google Cloud'],
  ['x-amz-cf-id', null, 'Amazon CloudFront'],
];

/** リポジトリのファイルと配信先。firebase.json と wrangler の設定は中身で別に見る */
const HOSTING_FILES = [
  ['vercel.json', 'Vercel'],
  ['netlify.toml', 'Netlify'],
  ['fly.toml', 'Fly.io'],
  ['render.yaml', 'Render'],
  ['railway.json', 'Railway'],
  ['railway.toml', 'Railway'],
  ['app.yaml', 'App Engine'],
];

/** GitHub の Topics と配信先。自分で付けた分類なので、リポジトリのファイルより優先する */
const HOSTING_TOPICS = {
  'github-pages': 'GitHub Pages',
  vercel: 'Vercel',
  netlify: 'Netlify',
  'cloudflare-pages': 'Cloudflare Pages',
  'cloudflare-workers': 'Cloudflare Workers',
  'firebase-hosting': 'Firebase Hosting',
  'cloud-run': 'Cloud Run',
  gce: 'GCE',
  'app-engine': 'App Engine',
  'fly-io': 'Fly.io',
  render: 'Render',
  railway: 'Railway',
  heroku: 'Heroku',
  'aws-amplify': 'AWS Amplify',
};

/** GitHub の Topics と DB */
const DATABASE_TOPICS = {
  supabase: 'Supabase',
  firestore: 'Firestore',
  'cloud-sql': 'Cloud SQL',
  bigquery: 'BigQuery',
  neon: 'Neon',
  planetscale: 'PlanetScale',
  turso: 'Turso',
  upstash: 'Upstash',
  dynamodb: 'DynamoDB',
  mongodb: 'MongoDB',
};

/** 依存パッケージ名と DB（npm と PyPI）。接続先のサービスまで決まるもの */
const DATABASE_PACKAGES = {
  '@supabase/supabase-js': 'Supabase',
  '@supabase/ssr': 'Supabase',
  supabase: 'Supabase',
  firebase: 'Firestore',
  'firebase-admin': 'Firestore',
  '@google-cloud/firestore': 'Firestore',
  'google-cloud-firestore': 'Firestore',
  '@google-cloud/bigquery': 'BigQuery',
  'google-cloud-bigquery': 'BigQuery',
  '@google-cloud/cloud-sql-connector': 'Cloud SQL',
  'cloud-sql-python-connector': 'Cloud SQL',
  '@neondatabase/serverless': 'Neon',
  '@planetscale/database': 'PlanetScale',
  '@libsql/client': 'Turso',
  '@vercel/postgres': 'Vercel Postgres',
  '@upstash/redis': 'Upstash',
  '@aws-sdk/client-dynamodb': 'DynamoDB',
  mongodb: 'MongoDB',
  mongoose: 'MongoDB',
  pymongo: 'MongoDB',
};

/** 依存パッケージ名と DB の種類。接続先のサービスは分からないので、上のどれにも当たらないときだけ使う */
const DATABASE_ENGINE_PACKAGES = {
  pg: 'PostgreSQL',
  postgres: 'PostgreSQL',
  psycopg: 'PostgreSQL',
  'psycopg2-binary': 'PostgreSQL',
  psycopg2: 'PostgreSQL',
  asyncpg: 'PostgreSQL',
  mysql2: 'MySQL',
  pymysql: 'MySQL',
  'better-sqlite3': 'SQLite',
  sqlite3: 'SQLite',
};

/** 配信先と DB のどちらでもないサービス。依存パッケージ名（npm と PyPI）から決める */
const OTHER_PACKAGES = {
  '@google-cloud/functions-framework': 'Cloud Functions',
  'functions-framework': 'Cloud Functions',
  'firebase-functions': 'Cloud Functions',
  '@googlemaps/js-api-loader': 'Google Maps API',
  '@googlemaps/google-maps-services-js': 'Google Maps API',
  '@react-google-maps/api': 'Google Maps API',
  '@vis.gl/react-google-maps': 'Google Maps API',
  googlemaps: 'Google Maps API',
};

/** 配信先と DB のどちらでもないサービスの Topics */
const OTHER_TOPICS = {
  'cloud-functions': 'Cloud Functions',
  'google-maps': 'Google Maps API',
};

const unique = (list) => [...new Set(list)];

/** 判定が返しうるインフラの名前の一覧。表記ゆれの点検（check-variants.mjs）で正しい表記として使う */
export function knownInfraLabels() {
  return unique([
    ...HOST_SUFFIXES.map(([, label]) => label),
    ...[...HEADER_RULES, ...WEAK_HEADER_RULES].map(([, , label]) => label),
    ...HOSTING_FILES.map(([, label]) => label),
    ...Object.values(HOSTING_TOPICS),
    ...Object.values(DATABASE_TOPICS),
    ...Object.values(DATABASE_PACKAGES),
    ...Object.values(DATABASE_ENGINE_PACKAGES),
    ...Object.values(OTHER_PACKAGES),
    ...Object.values(OTHER_TOPICS),
    'Firebase Hosting', 'Cloudflare Pages', 'Cloudflare Workers', 'Cloudflare', 'Cloudflare D1', 'Cloudflare KV',
  ]);
}

/**
 * サイトに 1 回アクセスして、最後の URL のホスト名と応答ヘッダーを返す。
 * 認証で弾かれても、ヘッダーは配信先を示すので、状態コードは見ない。取れないときは null。
 */
export async function probeSite(url, { timeoutMs = 10000, userAgent = 'my-service-list' } = {}) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.body) await res.body.cancel();
    return { host: new URL(res.url || url).hostname.toLowerCase(), headers: Object.fromEntries(res.headers) };
  } catch {
    return null;
  }
}

/** リポジトリのうち、判定に使わない場所。サンプルや依存物の設定に引きずられないようにする */
const IGNORED_DIRS = new Set(['node_modules', 'vendor', 'example', 'examples', 'sample', 'samples', 'test', 'tests', 'fixtures', 'templates', 'docs', 'doc']);
/** 見る深さ。apps/web/package.json や src/lib/supabase のような、アプリが 1〜2 段下にある構成まで */
const MAX_SLASHES = 2;
/** 種類ごとに読むファイルの上限。浅いものから読む */
const MAX_FILES_PER_NAME = 4;

/**
 * リポジトリのファイル一覧と、判定に使うファイルの中身を読む。
 * getJson(pathname) は GitHub API の応答の本体を返し、404 なら null を返す関数。
 */
export async function readRepoSignals(getJson, fullName) {
  const tree = await getJson(`/repos/${fullName}/git/trees/HEAD?recursive=1`);
  const entries = (tree && Array.isArray(tree.tree) ? tree.tree : []).filter((e) => {
    const parts = String(e.path).split('/');
    return parts.length - 1 <= MAX_SLASHES && !parts.some((p) => IGNORED_DIRS.has(p));
  });
  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirs = entries.filter((e) => e.type === 'tree').map((e) => baseName(e.path));
  const blobs = entries.filter((e) => e.type === 'blob').map((e) => e.path);

  const readAll = async (matches) => {
    const paths = blobs
      .filter((p) => matches(baseName(p)))
      .sort((a, b) => a.split('/').length - b.split('/').length)
      .slice(0, MAX_FILES_PER_NAME);
    const texts = [];
    for (const p of paths) {
      const f = await getJson(`/repos/${fullName}/contents/${p.split('/').map(encodeURIComponent).join('/')}`);
      if (f && f.encoding === 'base64' && typeof f.content === 'string') texts.push(Buffer.from(f.content, 'base64').toString('utf8'));
    }
    return texts;
  };

  return {
    files: unique(blobs.map(baseName)),
    dirs: unique(dirs),
    packages: unique([
      ...(await readAll((n) => n === 'package.json')).flatMap(parseNpmPackages),
      ...(await readAll((n) => n === 'requirements.txt' || n === 'pyproject.toml')).flatMap(parsePythonPackages),
    ]),
    firebaseKeys: unique((await readAll((n) => n === 'firebase.json')).flatMap(parseJsonKeys)),
    wrangler: (await readAll((n) => /^wrangler\.(toml|jsonc?)$/.test(n))).join('\n'),
  };
}

function parseJsonKeys(text) {
  try {
    return Object.keys(JSON.parse(text) || {});
  } catch {
    return [];
  }
}

/** package.json の dependencies を集める。devDependencies は本番の構成を示さないので見ない */
function parseNpmPackages(text) {
  try {
    return Object.keys(JSON.parse(text).dependencies || {});
  } catch {
    return []; // 壊れた package.json は手がかりなしとして扱う
  }
}

/** requirements.txt と pyproject.toml の、1 行ごとの先頭の名前を集める */
function parsePythonPackages(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*["']?([A-Za-z0-9][A-Za-z0-9_.-]*)/);
    if (m) names.push(m[1].toLowerCase());
  }
  return names;
}

/** wrangler の設定から、Cloudflare のどの製品を使っているかを読む。JSONC と TOML の両方があるので項目名だけを探す */
function parseWrangler(text) {
  if (!text) return { hosting: null, database: [] };
  const uses = (key) => new RegExp(`["']?\\b${key}\\b["']?\\s*[:=]|\\[\\[?${key}\\b`).test(text);
  const hosting = uses('pages_build_output_dir') ? 'Cloudflare Pages' : uses('main') || uses('assets') ? 'Cloudflare Workers' : 'Cloudflare';
  const database = [];
  if (uses('d1_databases')) database.push('Cloudflare D1');
  if (uses('kv_namespaces')) database.push('Cloudflare KV');
  return { hosting, database };
}

function hostingFromHost(host) {
  if (!host) return null;
  const hit = HOST_SUFFIXES.find(([suffix]) => host === suffix || host.endsWith(`.${suffix}`));
  return hit ? hit[1] : null;
}

function hostingFromHeaders(headers, rules) {
  for (const [name, pattern, label] of rules) {
    const v = headers ? headers[name] : undefined;
    if (v !== undefined && (!pattern || pattern.test(v))) return label;
  }
  return null;
}

/**
 * 配信先を決める。実際に動いているサイトの印を、リポジトリの設定より優先する。
 * ホスト名 → 応答ヘッダー → Topics → リポジトリのファイル → 手前に別のものがありうるヘッダーの順で、最初に当たった段を採る。
 */
function detectHosting({ site, topics, files, firebaseKeys, wrangler }) {
  const byHost = hostingFromHost(site && site.host);
  if (byHost) return [byHost];
  const byHeader = hostingFromHeaders(site && site.headers, HEADER_RULES);
  if (byHeader) return [byHeader];
  const byTopic = topics.map((t) => HOSTING_TOPICS[t.toLowerCase()]).filter(Boolean);
  if (byTopic.length) return unique(byTopic);
  const byFile = HOSTING_FILES.filter(([name]) => files.includes(name)).map(([, label]) => label);
  if (firebaseKeys.includes('hosting')) byFile.push('Firebase Hosting');
  if (wrangler.hosting) byFile.push(wrangler.hosting);
  if (byFile.length) return unique(byFile);
  const weak = hostingFromHeaders(site && site.headers, WEAK_HEADER_RULES);
  return weak ? [weak] : [];
}

/** DB を決める。複数使うことがあるので当たったものをすべて返す。種類しか分からないものは、ほかに当たらないときだけ返す */
function detectDatabase({ topics, files, dirs, packages, firebaseKeys, wrangler }) {
  const found = topics.map((t) => DATABASE_TOPICS[t.toLowerCase()]).filter(Boolean);
  if (dirs.includes('supabase')) found.push('Supabase');
  if (files.includes('firestore.rules') || firebaseKeys.includes('firestore')) found.push('Firestore');
  found.push(...wrangler.database);
  // firebase の SDK は認証だけに使うこともあるので、firebase.json があって firestore の設定がないときは DB に数えない
  const firebaseWithoutFirestore = files.includes('firebase.json') && !firebaseKeys.includes('firestore');
  for (const p of packages) {
    const label = DATABASE_PACKAGES[p];
    if (!label) continue;
    if (label === 'Firestore' && firebaseWithoutFirestore) continue;
    found.push(label);
  }
  if (found.length) return unique(found);
  return unique(packages.map((p) => DATABASE_ENGINE_PACKAGES[p]).filter(Boolean));
}

function detectOther({ topics, packages }) {
  return unique([
    ...topics.map((t) => OTHER_TOPICS[t.toLowerCase()]),
    ...packages.map((p) => OTHER_PACKAGES[p]),
  ].filter(Boolean));
}

/**
 * 判定の結果に手入力を重ねる。手入力はそのまま足し、-Name は判定の結果から除く。
 * 大文字小文字を無視して比べ、重複は除く。先に出たものの表記を残す。
 */
export function applyManualInfra(detected, manual) {
  const entries = (Array.isArray(manual) ? manual : []).map((v) => String(v ?? '').trim()).filter(Boolean);
  const excluded = new Set(entries.filter((v) => v.startsWith('-')).map((v) => v.slice(1).trim().toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const v of [...detected, ...entries.filter((e) => !e.startsWith('-'))]) {
    const key = v.toLowerCase();
    if (seen.has(key) || excluded.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * site は probeSite の戻り値（null 可）、repo は readRepoSignals の戻り値（null 可）。
 * 戻り値は名前の配列で、配信先、DB、その他の順に並ぶ。判定できなければ空の配列。
 */
export function detectInfra({ site = null, repo = null, topics = [] } = {}) {
  const input = {
    site,
    topics,
    files: repo ? repo.files : [],
    dirs: repo ? repo.dirs : [],
    packages: repo ? repo.packages : [],
    firebaseKeys: repo ? repo.firebaseKeys : [],
    wrangler: parseWrangler(repo ? repo.wrangler : ''),
  };
  return unique([...detectHosting(input), ...detectDatabase(input), ...detectOther(input)]);
}
