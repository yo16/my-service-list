#!/usr/bin/env node
/* my-service-list: GitHub の Issue を beads に登録する
 *
 * Claude Code の SessionStart フック（.claude/settings.json）から呼ぶ。
 * GitHub の open な Issue を gh で調べ、beads にまだ無いものを bd create で登録する。
 * 登録済みかどうかは、beads の external_ref（gh-<番号>）で見分ける。閉じた bead も
 * 登録済みとして数えるので、同じ Issue を二度登録することはない。
 * GitHub の側は読むだけで、書き換えない。
 * Node 22 以上の標準機能と、gh、bd のコマンドだけで動く。
 *
 * 使い方:
 *   node scripts/sync-github-issues.mjs             未登録の Issue を登録する
 *   node scripts/sync-github-issues.mjs --dry-run   登録せず、登録する予定の Issue だけを出す
 *
 * オフラインのときや gh が未ログインのときなど、途中で失敗しても終了コードは 0 にする。
 * セッションの開始を止めないためで、失敗の理由は 1 行で出す。
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');
const TIMEOUT_MS = 20_000;

const log = (...a) => console.log('[github-issues]', ...a);

function run(cmd, args, input) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    timeout: TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** GitHub のラベルから beads の種別を決める。当てはまるものがなければ task */
function issueType(labels) {
  const names = labels.map((l) => l.name.toLowerCase());
  if (names.includes('bug')) return 'bug';
  if (names.includes('enhancement')) return 'feature';
  return 'task';
}

function main() {
  const ghIssues = JSON.parse(
    run('gh', ['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,body,url,labels']),
  );
  if (ghIssues.length === 0) return;

  const beads = JSON.parse(run('bd', ['list', '--all', '--limit', '0', '--brief', '--json']));
  const registered = new Set(beads.map((b) => b.external_ref).filter(Boolean));

  const missing = ghIssues
    .filter((i) => !registered.has(`gh-${i.number}`))
    .sort((a, b) => a.number - b.number);
  if (missing.length === 0) return;

  for (const issue of missing) {
    if (DRY_RUN) {
      log(`登録する予定: #${issue.number} ${issue.title}`);
      continue;
    }
    const description = `GitHub Issue #${issue.number}: ${issue.url}\n\n${issue.body ?? ''}`.trimEnd();
    const id = run(
      'bd',
      ['create', issue.title, '-t', issueType(issue.labels), '--external-ref', `gh-${issue.number}`, '--body-file', '-', '--silent'],
      description,
    ).trim();
    log(`登録した: #${issue.number} → ${id} ${issue.title}`);
  }
  if (!DRY_RUN) log(`GitHub の Issue を ${missing.length} 件、beads に登録した。`);
}

try {
  main();
} catch (e) {
  const reason = String(e.stderr || e.message || e).trim().split('\n')[0];
  log(`GitHub の Issue を確認できなかった: ${reason}`);
}
