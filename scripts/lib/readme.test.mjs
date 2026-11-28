import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromReadme, findSiteUrl, planUpdate, stripCode, summarize } from './readme.mjs';

const README = `# Sample Notes

[![CI](https://img.shields.io/badge/ci-passing-green)](https://github.com/example/sample-notes/actions)

メモを書いて共有するだけの**小さなアプリ**です。[Next.js](https://nextjs.org/) と Supabase で作っています。

## 公開先

- URL: https://notes.example.jp/ （本番）
- ソース: https://github.com/example/sample-notes

## 構成

Vercel に配置し、地図は Google Maps を使う。集計は Cloud Run functions で動かす。

\`\`\`bash
docker compose up   # ここは例なので、docker をタグにしない
\`\`\`
`;

test('最初の地の文を説明にする（見出しとバッジは飛ばし、書式を外す）', () => {
  assert.equal(summarize(README), 'メモを書いて共有するだけの小さなアプリです。Next.js と Supabase で作っています。');
});

test('長い説明は文の切れ目で切る', () => {
  const long = `# T\n\n${'あ'.repeat(50)}。${'い'.repeat(100)}。`;
  assert.equal(summarize(long), `${'あ'.repeat(50)}。`);
});

test('切れ目が無い長い説明は、末尾を … にする', () => {
  const s = summarize(`# T\n\n${'あ'.repeat(300)}`);
  assert.equal(s.length, 120);
  assert.ok(s.endsWith('…'));
});

test('地の文が無ければ、説明は null', () => {
  assert.equal(summarize('# T\n\n- a\n- b\n\n| x | y |\n|---|---|\n'), null);
  assert.equal(summarize(''), null);
});

test('コードの中は読まない', () => {
  assert.ok(!stripCode(README).includes('docker compose'));
  assert.ok(!extractFromReadme(README).tags.includes('docker'));
});

test('技術タグとインフラを辞書で拾い、表記をそろえる', () => {
  const x = extractFromReadme(README);
  assert.deepEqual(x.tags, ['nextjs']);
  assert.deepEqual(x.infra, ['Vercel', 'Google Cloud Functions', 'Google Maps API', 'Supabase']);
});

test('冒頭と、技術や構成の節だけを読む（ほかの節に出てくる名前や文は拾わない）', () => {
  const md = [
    '# T',
    '',
    '## 経緯',
    '',
    '最初は Heroku と Rails で作ったが、やめた。',
    '',
    '## 技術スタック',
    '',
    '- Astro',
    '',
    '### データ',
    '',
    'Turso に置く。',
    '',
    '## 監視',
    '',
    'Stripe の障害を見る。',
  ].join('\n');
  const x = extractFromReadme(md);
  assert.deepEqual(x.tags, ['astro']);
  assert.deepEqual(x.infra, ['Turso']);
  assert.equal(x.summary, null); // 冒頭に地の文が無い。「経緯」の文は説明にしない
});

test('URL の後ろの全角のかっこを巻き込まない', () => {
  assert.equal(findSiteUrl('# T\n\n公開先: https://notes.example.jp/（予定）\n'), 'https://notes.example.jp/');
});

test('Cloud Run と Cloud Run functions を取り違えない', () => {
  assert.deepEqual(extractFromReadme('# T\n\nCloud Run で動く。').infra, ['Cloud Run']);
  assert.deepEqual(extractFromReadme('# T\n\nCloud Run functions で動く。').infra, ['Google Cloud Functions']);
});

test('含まれる名前は落とす', () => {
  assert.deepEqual(extractFromReadme('# T\n\nSvelteKit と React Native の例。').tags, ['react-native', 'sveltekit']);
});

test('URL は、公開先を示す行の、GitHub やバッジ以外のものだけを採る', () => {
  assert.equal(findSiteUrl(README), 'https://notes.example.jp/');
  assert.equal(findSiteUrl('# T\n\nサイト: https://github.com/example/x\n'), null);
  assert.equal(findSiteUrl('# T\n\n参考にした記事 https://blog.example.jp/a\n'), null);
});

const row = { id: 1, description: null, url: null, tags: ['Zod'], infra: ['GCE', '-Supabase'] };
const extracted = { summary: '説明の文。', tags: ['nextjs', 'zod', 'prisma'], infra: ['Vercel', 'Supabase', 'gce', 'Stripe'], url: 'https://notes.example.jp/' };

test('足すだけで、すでにある値は消さない', () => {
  const { patch, changes } = planUpdate(row, extracted, { knownTags: ['NextJS'], detectedInfra: ['Vercel'] });
  assert.deepEqual(patch.tags, ['Zod', 'prisma']);        // nextjs は Topics に、zod は登録済みにある
  assert.deepEqual(patch.infra, ['GCE', '-Supabase', 'Stripe']); // Vercel は自動判定に、GCE は登録済みに、Supabase は除外にある
  assert.equal(patch.description, '説明の文。');
  assert.equal(patch.url, 'https://notes.example.jp/');
  assert.equal(changes.length, 4);
});

test('説明と URL は、GitHub の側にあれば入れない', () => {
  const { patch } = planUpdate(row, extracted, { repoDescription: 'GitHub の説明', repoHomepage: 'https://x.example.jp/' });
  assert.equal('description' in patch, false);
  assert.equal('url' in patch, false);
});

test('すでにある説明は、指定したときだけ書き換える', () => {
  const filled = { ...row, description: '古い説明' };
  assert.equal('description' in planUpdate(filled, extracted).patch, false);
  assert.equal(planUpdate(filled, extracted, { rewriteDescription: true }).patch.description, '説明の文。');
});

test('候補が登録済みと同じなら、変更なし', () => {
  const same = { id: 2, description: 'x', url: 'https://a.example.jp/', tags: ['nextjs'], infra: ['Vercel'] };
  const { patch, changes } = planUpdate(same, { summary: 'y', tags: ['nextjs'], infra: ['Vercel'], url: 'https://b.example.jp/' });
  assert.deepEqual(patch, {});
  assert.deepEqual(changes, []);
});
