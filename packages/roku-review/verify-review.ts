/**
 * Pins the pure parts of a review: diff budgeting, JSON extraction from model replies, and the
 * bucket rules (issue / needs-device / noted / dismissed). Run with `npm run verify -w roku-dev-studio-review`.
 */
import assert from 'node:assert/strict';
import { budgetDiff, fileInventory, splitDiff } from './diff';
import { extractJson } from './agent';
import { classify, isPermanentFailure, mergeFindings } from './review';
import { estimateCents } from './pricing';
import { adfToText, ticketKeyCandidates } from './jira';
import { detectBuild, parseJsonc, projectFolders } from './build-detect';
import { excerptConsole, makeRedactor, testResult, TEST_FILE } from './device';
import { applyDismissals, dismissalPromptBlock, matchDismissal, type Dismissal } from './suppressions';
import type { ReviewFinding } from './review';
import { discussionPromptBlock, toThreads } from './discussion';
import { ciFindings, ciInfraFailures, ciPromptBlock, isCodeAnnotation } from './ci';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fileDiff = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n${body}`;
const diff = [
  fileDiff('components/Player.brs', ' sub init()\n+  m.top.observeField("state", "onState")'),
  fileDiff('package-lock.json', '+  "lockfileVersion": 3'),
  fileDiff('dist/source/main.brs', '+compiled'),
  'diff --git a/images/logo.png b/images/logo.png\nBinary files a/images/logo.png and b/images/logo.png differ',
  fileDiff('source/huge.brs', `+${'x'.repeat(40_000)}`),
].join('\n');

const files = splitDiff(diff);
assert.equal(files.length, 5);
assert.equal(files[0].additions, 1);
assert.equal(files[3].binary, true);

const budgeted = budgetDiff(diff);
const status = Object.fromEntries(budgeted.files.map((f) => [f.path, f.included]));
assert.deepEqual(status, {
  'components/Player.brs': 'full',
  'package-lock.json': 'omitted',
  'dist/source/main.brs': 'omitted',
  'images/logo.png': 'omitted',
  'source/huge.brs': 'truncated',
});
assert.ok(budgeted.text.includes('observeField'));
assert.ok(!budgeted.text.includes('lockfileVersion'));
assert.ok(budgeted.notes.some((n) => n.includes('lock file')));
assert.ok(fileInventory(budgeted).includes('[not in diff: build output]'));
assert.ok(budgetDiff(diff, 100).files.some((f) => f.reason === 'over the size budget'));

assert.deepEqual(extractJson('Here you go:\n```json\n{"findings":[{"title":"a {b}"}]}\n```'), { findings: [{ title: 'a {b}' }] });
assert.deepEqual(extractJson('{"broken": } then {"ok": true}'), { ok: true });
assert.equal(extractJson('no json here'), null);

assert.equal(classify({ verdict: 'dismissed', needsDevice: true, severity: 'critical' }), 'dismissed');
assert.equal(classify({ verdict: 'real', needsDevice: true, severity: 'critical', confidence: 0.9 }), 'needs-device');
assert.equal(classify({ verdict: 'real', needsDevice: false, severity: 'major', confidence: 0.8 }), 'issue');
assert.equal(classify({ verdict: 'real', needsDevice: false, severity: 'info', confidence: 0.95 }), 'noted');
assert.equal(classify({ verdict: 'real', needsDevice: false, severity: 'critical', confidence: 0.3 }), 'noted');
assert.equal(classify({ verdict: 'real', needsDevice: false, severity: 'minor' }), 'issue');

// Retry only what a retry can fix.
assert.ok(isPermanentFailure("You've hit your usage limit You've saved $66 on API model usage"));
assert.ok(!isPermanentFailure('Agent Looping Detected The model got stuck in a repeating response pattern'));
assert.ok(!isPermanentFailure('The reply was not valid JSON.'));

// The same issue from two lenses reaches the judge once, with both lenses and the higher severity.
const merged = mergeFindings({
  correctness: [{ file: 'a.bs', line: 10, title: 'Rejected proxy IP fails with no log', severity: 'minor', detail: 'x' }],
  roku: [
    { file: 'a.bs', line: 12, title: 'Rejected proxy IP fails silently, no log', severity: 'major', detail: 'y' },
    { file: 'a.bs', line: 40, title: 'Observer never removed', severity: 'minor' },
  ],
});
assert.equal(merged.length, 2);
assert.deepEqual(merged[0].raisedBy, ['correctness', 'roku']);
assert.equal(merged[0].severity, 'major');

// Ticket keys: description, then title, then branch (case-insensitive there); no duplicates.
assert.deepEqual(ticketKeyCandidates([
  { from: 'PR description', text: 'Implements ROK-8326. See also ROK-8326 and UTF-8 notes.' },
  { from: 'PR title', text: 'ROK-9028: carousel' },
  { from: 'branch name', text: 'agutierrezf/fix/rok-8326-qa-deeplink' },
]).map((c) => `${c.key}@${c.from}`), ['ROK-8326@PR description', 'UTF-8@PR description', 'ROK-9028@PR title']);
// ADF (JIRA rich text) to plain text: paragraphs, list items, links.
assert.equal(adfToText({ type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Given a QA deep link' }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'set the proxy', marks: [{ type: 'link', attrs: { href: 'https://figma.com/x' } }] }] }] }] },
] }).trim(), 'Given a QA deep link\n\n- set the proxy (https://figma.com/x)');

// Price estimate: claude-sonnet at $3 in / $15 out per 1M; unknown models give null.
assert.equal(Math.round(estimateCents('claude-sonnet-5-5', { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 })!), 450);
assert.equal(estimateCents('composer-9', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);

async function buildChecks(): Promise<void> {
  assert.deepEqual(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,], }'), { a: 'http://x', b: [1] });
  const fixture: Record<string, string> = {
    '.vscode/launch.json': '{ "configurations": [ { "type": "brightscript", "rootDir": "${workspaceFolder}/dist", // comment\n "preLaunchTask": "npm:generate-code", }, ], }',
    '.vscode/tasks.json': '{ "tasks": [ { "type": "npm", "script": "generate-code", "label": "npm:generate-code" } ] }',
    'package.json': '{ "scripts": { "build": "x" } }',
    'package-lock.json': '{}',
  };
  const read = async (p: string) => fixture[p] ?? null;
  assert.deepEqual(await detectBuild(read), { command: 'npm run generate-code', outDir: 'dist', install: 'npm ci', detectedFrom: '.vscode/launch.json (preLaunchTask "npm:generate-code")' });
  assert.deepEqual(await detectBuild(async (p) => ({ 'package.json': '{"scripts":{"build":"bsc"}}', 'bsconfig.json': '{"stagingDir":"out/stage"}' } as Record<string, string>)[p] ?? null), { command: 'npm run build', outDir: 'out/stage', install: 'npm install', detectedFrom: 'package.json script "build"' });
  assert.deepEqual(await detectBuild(async (p) => (p === 'manifest' ? 'title=x' : null)), { command: '', outDir: '.', install: '', detectedFrom: 'manifest at the repo root (no build step)' });
  assert.equal(await detectBuild(async () => null), null);
  // Test build: script + bsconfig.test.json staging, or a staging folder named in the script file.
  const withTests: Record<string, string> = { 'package.json': '{"scripts":{"build":"bsc","test:build":"ts-node scripts/tests/build-tests.ts"}}', 'bsconfig.test.json': '{"stagingDir":"out/tests-staging"}' };
  assert.deepEqual(await detectBuild(async (p) => withTests[p] ?? null).then((d) => d && { t: d.testCommand, o: d.testOutDir }), { t: 'npm run test:build', o: 'out/tests-staging' });
  const viaScript: Record<string, string> = { 'package.json': '{"scripts":{"build":"bsc","test:build":"ts-node scripts/tests/build-tests.ts"}}', 'scripts/tests/build-tests.ts': 'const STAGING_DIR = "out/tests-staging";' };
  assert.equal((await detectBuild(async (p) => viaScript[p] ?? null))?.testOutDir, 'out/tests-staging');
  assert.equal((await detectBuild(async (p) => ({ 'package.json': '{"scripts":{"build":"bsc","test":"exit 0"}}' } as Record<string, string>)[p] ?? null))?.testCommand, undefined);
  // Several test builds (like a ref app): main test bsconfig first, launch configs too, deploy scripts never.
  const refapp: Record<string, string> = {
    'package.json': JSON.stringify({ scripts: {
      build: 'gulp build',
      'build:refactor-tests': 'npx bsc --project bsconfig.refactor.json',
      'build-all-tests': 'npx bsc --project bsconfig.test.json',
      'test:deploy': 'npx bsc --project bsconfig.test.json --create-package true && roku-deploy',
    } }),
    'bsconfig.test.json': '{"stagingDir":"out/staging-test"}',
    '.vscode/launch.json': '{"configurations":[{"name":"Build","type":"brightscript","rootDir":"${workspaceFolder}/build","preLaunchTask":"build"},{"name":"Run Ref App Tests","type":"brightscript","rootDir":"${workspaceFolder}/out/staging-ref-app-tests","preLaunchTask":"build:ref-app-tests"}]}',
    '.vscode/tasks.json': '{"tasks":[{"label":"build","type":"npm","script":"build"},{"label":"build:ref-app-tests","type":"shell","command":"npm run build:ref-app-tests"}]}',
  };
  const opts = (await detectBuild(async (p) => refapp[p] ?? null))?.testOptions ?? [];
  assert.deepEqual(opts.map((o) => [o.command, o.outDir]), [
    ['npm run build-all-tests', 'out/staging-test'],
    ['npm run build:refactor-tests', ''],
    ['npm run build:ref-app-tests', 'out/staging-ref-app-tests'],
  ]);
  // Project folders: roots that hold a Roku project, shallow first, never build output or deps.
  assert.deepEqual(projectFolders(['manifest', 'sample-app/manifest', 'sample-app/package.json', 'node_modules/x/package.json', 'out/manifest', 'a/b/c/d/manifest']), ['', 'sample-app']);
}

async function deviceChecks(): Promise<void> {
  // Test files by name, any layout; helpers are not test files.
  assert.ok(TEST_FILE.test('tests/specs/ProxyManager.deeplink.spec.bs') && TEST_FILE.test('source/foo.test.brs'));
  assert.ok(!TEST_FILE.test('tests/helpers/mocks.bs') && !TEST_FILE.test('src/specialty.bs') && !TEST_FILE.test('bsconfig.test.json'));
  // Result lines of common frameworks; nothing invented when none was printed.
  assert.equal(testResult('...\n[Rooibos Result]: PASS\n'), 'PASS');
  assert.equal(testResult('[Rooibos Result]: FAIL'), 'FAIL');
  assert.equal(testResult('  RESULT: Fail'), 'FAIL');
  assert.equal(testResult('booting… no result'), undefined);

  // CI: annotated red checks are facts; unannotated red ones are infrastructure, not evidence.
  const ci = {
    headSha: 'a'.repeat(40),
    checks: [
      { name: 'bslint', state: 'failure' as const, annotations: [{ path: 'src/a.bs', line: 3, level: 'failure' as const, message: 'Unused variable' }] },
      { name: 'device-tests', state: 'failure' as const, annotations: [] },
      { name: 'build', state: 'success' as const, annotations: [] },
    ],
  };
  assert.equal(ciFindings(ci).length, 1);
  assert.ok(!isCodeAnnotation('.github', 'Process completed with exit code 1.') && isCodeAnnotation('src/a.bs', 'Unused variable'));
  assert.deepEqual(ciInfraFailures(ci).map((c) => c.name), ['device-tests']);
  assert.ok(ciPromptBlock(ci).includes('likely infrastructure') && ciPromptBlock(ci).includes('build: success'));

  const consoleText = ['boot', '\u001b[32m[RDS-PROBE] price=9.99\u001b[0m', 'noise', 'BRIGHTSCRIPT: ERROR: roSGNode.AddReplace: "price": Type mismatch', ...Array.from({ length: 100 }, (_, i) => `line ${i}`)].join('\n');
  const excerpt = excerptConsole(consoleText);
  assert.ok(excerpt.startsWith('[RDS-PROBE] price=9.99'), 'probe lines first, ANSI stripped');
  assert.ok(excerpt.includes('BRIGHTSCRIPT: ERROR'));
  assert.ok(excerpt.includes('line 99') && !excerpt.includes('line 5\n'));

  const redact = makeRedactor(['hunter2secret', 'short', 'ghp_abcdefghij']);
  assert.equal(redact('pw=hunter2secret token ghp_abcdefghij short'), 'pw=••• token ••• short');
  // Unknown secrets: header values named like keys/tokens, and JWTs.
  assert.equal(redact("-H 'x-acme-api-key: Fake0Key0Value' -H 'x-acme-platform: roku'"), "-H 'x-acme-api-key: •••' -H 'x-acme-platform: roku'");
  assert.equal(redact('jwt eyJhbGciOiJSUzI1.eyJpc3MiOiJ1cm4.sig_part-1 ok'), 'jwt ••• ok');
  assert.equal(redact('Authorization: Bearer abcdef123456'), 'Authorization: Bearer •••');

  // A flood of long lines must not push probe lines out of the excerpt.
  const flood = ['[RDS-PROBE] gate=1', ...Array.from({ length: 200 }, () => `curl ${'x'.repeat(2000)}`)].join('\n');
  const floodExcerpt = excerptConsole(flood);
  assert.ok(floodExcerpt.startsWith('[RDS-PROBE] gate=1') && floodExcerpt.length <= 10_000);
}

// Remembered dismissals: same file after one; anywhere in the repo after two; never CI facts.
{
  const d = (file: string, title: string, at = 1): Dismissal => ({ id: `${file}${at}`, file, title, at });
  const once = [d('a.brs', 'Magic number used for row height')];
  assert.ok(matchDismissal({ file: 'a.brs', title: 'Magic number for row height' }, once), 'reworded title on the same file');
  assert.equal(matchDismissal({ file: 'b.brs', title: 'Magic number used for row height' }, once), undefined, 'one dismissal stays on its file');
  const twice = [...once, d('c.brs', 'Magic number used for the row height', 2)];
  assert.ok(matchDismissal({ file: 'b.brs', title: 'Magic number used for row height' }, twice), 'two dismissals go repo-wide');
  assert.equal(matchDismissal({ file: 'a.brs', title: 'Unobserved field leaks the timer' }, twice), undefined, 'a different objection');
  const f = (id: string, extra: Partial<ReviewFinding> = {}): ReviewFinding => ({ id, title: 'Magic number used for row height', detail: '', severity: 'minor', file: 'b.brs', status: 'issue', reasoning: '', sources: [], inDiff: true, ...extra });
  const findings = [f('x'), f('ci', { ci: { check: 'lint' } })];
  assert.equal(applyDismissals(findings, twice), 1);
  assert.equal(findings[0].status, 'dismissed');
  assert.equal(findings[0].userDismissed?.previousStatus, 'issue');
  assert.equal(findings[1].status, 'issue', 'CI findings are facts');
  assert.equal(dismissalPromptBlock([]), '');
  assert.ok(dismissalPromptBlock(twice).indexOf('the row height') < dismissalPromptBlock(twice).indexOf('used for row height'), 'most recent first');
}

// PR discussion: threads fold replies, drop bots and our marker, open threads first.
{
  const c = (id: number, login: string, body: string, at: string, bot = false) => ({ databaseId: id, url: `u${id}`, body, createdAt: at, author: { login, __typename: bot ? 'Bot' : 'User' } });
  const threads = toThreads({
    reviewThreads: { nodes: [
      { isResolved: true, isOutdated: false, path: 'a.brs', line: 3, originalLine: 3, comments: { nodes: [c(1, 'me', 'old', '2026-10-01')] } },
      { isResolved: false, isOutdated: false, path: 'b.brs', line: null, originalLine: 9, comments: { nodes: [c(2, 'me', 'Fix this\n\n<!-- rds-review:abc -->', '2026-10-02'), c(3, 'author', 'Keeping it: reason', '2026-10-03')] } },
    ] },
    comments: { nodes: [c(4, 'github-actions', 'Coverage', '2026-10-04', true), c(5, 'me', 'Overall note', '2026-10-05')] },
  });
  assert.deepEqual(threads.map((t) => t.id), ['c5', 't2', 't1'], 'open first, newest first; bots dropped');
  const t2 = threads.find((t) => t.id === 't2')!;
  assert.equal(t2.rootId, 2);
  assert.equal(t2.line, 9, 'falls back to originalLine');
  assert.equal(t2.comments[0].body, 'Fix this', 'our hidden marker is stripped');
  assert.equal(t2.comments[1].author, 'author');
  assert.ok(discussionPromptBlock({ threads }).includes('"id": "t2"'));
  assert.equal(t2.markerId, 'abc', 'our finding id is read from the marker');
  assert.ok(discussionPromptBlock({ threads }).includes('"ourFinding": "abc"'));
  assert.ok(discussionPromptBlock({ threads: [], error: 'HTTP 403' }).includes('could not be read'));
}

void buildChecks().then(deviceChecks).then(() => console.log('verify-review: ok'));
