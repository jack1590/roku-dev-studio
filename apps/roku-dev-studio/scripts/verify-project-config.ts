/**
 * Pins the project config validators: project names, repo lists, JIRA site/email, Figma URLs.
 * Run with `npm run verify:project-config`.
 */
import assert from 'node:assert/strict';
import { hasProblem, matchesFilter, matchesSearch, prState, timeAgo, type PullRequestItem } from '../shared/pr-list.js';
import { parseFigmaTestUrl, parseJiraEmail, parseJiraSite, parseProjectInput, parseRepoList, parseReviewSettings, parseWikiSettings, projectIdFor, defaultCompanyTag, parseBuildConfig, parseEnvBulk, serializeEnvFile } from '../shared/project-config.js';

const ok = parseProjectInput({ name: '  Globex  ' });
assert.equal(ok.ok, true);
if (ok.ok) assert.equal(ok.name, 'Globex');
assert.equal(projectIdFor('Globex Corporation!'), 'globex-corporation');
assert.equal(projectIdFor('***'), 'project');

for (const bad of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, null, 'acme']) {
  assert.equal(parseProjectInput(bad).ok, false);
}

assert.equal(parseJiraSite('https://acme.atlassian.net/').ok, true);
assert.equal(parseJiraSite('http://acme.atlassian.net').ok, false);
assert.equal(parseJiraSite('acme').ok, false);
assert.equal(parseJiraEmail('dev@acme.com').ok, true);
assert.equal(parseJiraEmail('dev').ok, false);
const fig = parseFigmaTestUrl('https://www.figma.com/design/AbC123xyz/My-File?node-id=1-2');
assert.equal(fig.ok, true);
if (fig.ok) assert.equal(fig.fileKey, 'AbC123xyz');
assert.equal(parseFigmaTestUrl('https://example.com/design/AbC123xyz').ok, false);
assert.equal(parseFigmaTestUrl('https://www.figma.com/community').ok, false);

// Repos from any owner are allowed (multi-org), de-duplicated and sorted.
const repos = parseRepoList(['acme/web', 'other-org/api', 'acme/web']);
assert.equal(repos.ok, true);
if (repos.ok) assert.deepEqual(repos.repos, ['acme/web', 'other-org/api']);
assert.equal(parseRepoList(['acme/we b']).ok, false);
assert.equal(parseRepoList('acme/web').ok, false);

// --- PR list logic ---
const pr = (over: Partial<PullRequestItem> = {}): PullRequestItem => ({
  repo: 'acme/web', number: 7, title: 'Fix login', url: 'https://github.com/acme/web/pull/7', author: 'Dev', draft: false,
  head: 'feat/login', base: 'main', additions: 10, deletions: 2, updatedAt: '2026-01-01T00:00:00Z',
  conflicts: false, checks: 'success', decision: 'none', reviewRequested: false, headSha: 'abc123', labels: [], ...over,
});

assert.equal(prState(pr({ conflicts: true, decision: 'approved' })).label, 'Has conflicts');
assert.equal(prState(pr({ decision: 'changes_requested', checks: 'failure' })).label, 'Changes requested');
assert.equal(prState(pr({ checks: 'failure' })).label, 'Checks failing');
assert.equal(prState(pr({ draft: true })).label, 'Draft');
assert.equal(prState(pr({ decision: 'approved' })).label, 'Approved');
assert.equal(prState(pr({ reviewRequested: true })).label, 'Review requested');
assert.equal(prState(pr({ checks: 'pending' })).label, 'Checks running');
assert.equal(prState(pr()).label, 'Open');

assert.equal(hasProblem(pr()), false);
assert.equal(hasProblem(pr({ checks: 'failure' })), true);

// Filters: logins compare case-insensitively; "Needs you" is review requested, or my own PR with a problem.
assert.equal(matchesFilter(pr({ author: 'dev' }), 'mine', 'DEV'), true);
assert.equal(matchesFilter(pr({ author: 'other' }), 'mine', 'dev'), false);
assert.equal(matchesFilter(pr({ author: 'other', reviewRequested: true }), 'needs-you', 'dev'), true);
assert.equal(matchesFilter(pr({ author: 'dev', checks: 'failure' }), 'needs-you', 'dev'), true);
assert.equal(matchesFilter(pr({ author: 'other', checks: 'failure' }), 'needs-you', 'dev'), false);
assert.equal(matchesFilter(pr({ author: 'dev' }), 'needs-you', 'dev'), false);
assert.equal(matchesFilter(pr({ author: 'other', checks: 'failure' }), 'problems', 'dev'), true);
assert.equal(matchesFilter(pr(), 'all', 'dev'), true);

assert.equal(matchesSearch(pr(), '#7'), true);
assert.equal(matchesSearch(pr({ labels: [{ name: 'needs-qa', color: 'ff0000' }] }), 'needs-qa'), true, 'search matches a label');
assert.equal(matchesSearch(pr(), 'LOGIN'), true);
assert.equal(matchesSearch(pr(), 'feat/'), true);
assert.equal(matchesSearch(pr(), 'nope'), false);
assert.equal(matchesSearch(pr(), '  '), true);

const now = Date.parse('2026-01-10T12:00:00Z');
assert.equal(timeAgo('2026-01-10T11:59:40Z', now), 'just now');
assert.equal(timeAgo('2026-01-10T11:30:00Z', now), '30m ago');
assert.equal(timeAgo('2026-01-10T09:00:00Z', now), '3h ago');
assert.equal(timeAgo('2026-01-08T12:00:00Z', now), '2d ago');
assert.equal(timeAgo('garbage', now), '');

// --- AI review settings ---
const defaults = parseReviewSettings({});
assert.equal(defaults.ok, true);
if (defaults.ok) {
  assert.equal(defaults.settings.probeRounds, 5);
  assert.equal(defaults.settings.deviceMinutes, 30);
  assert.deepEqual(defaults.settings.models, {});
}
const review = parseReviewSettings({
  models: { reviewer1: 'composer-2.5', judge: 'claude-opus-5-5', builder: '' },
  reviewInstructions: [
    'COMMENT STYLE',
    '- Pointed, specific, file:line when possible.',
    '- When device logs prove a race or bug, include a short trimmed log excerpt.',
    '- Active keys: uncommented `ROKU_IP=...` and `ROKU_DEV_PASSWORD=...`.',
    '- unset GH_TOKEN; gh auth switch -u someone',
  ].join('\r\n'),
  probeRounds: '7',
  deviceMinutes: 45,
});
assert.equal(review.ok, true);
if (review.ok) {
  assert.deepEqual(review.settings.models, { reviewer1: 'composer-2.5', judge: 'claude-opus-5-5' });
  assert.equal(review.settings.probeRounds, 7);
  assert.equal(review.settings.deviceMinutes, 45);
  assert.ok(!review.settings.reviewInstructions.includes('\r'));
}
// Credentials in instructions are refused, and the error never echoes them.
for (const secret of ['token: ghp_' + 'a'.repeat(36), 'ROKU_DEV_PASSWORD=hunter2secret', 'api_key = sk-123456789', '-----BEGIN RSA PRIVATE KEY-----']) {
  const res = parseReviewSettings({ reviewInstructions: `rules\n${secret}` });
  assert.equal(res.ok, false, secret);
  if (!res.ok) assert.ok(!res.error.includes('hunter2') && !res.error.includes('ghp_'));
}
assert.equal(parseReviewSettings({ probeRounds: 0 }).ok, false);
assert.equal(parseReviewSettings({ probeRounds: 11 }).ok, false);
assert.equal(parseReviewSettings({ deviceMinutes: 2.5 }).ok, false);
assert.equal(parseReviewSettings({ models: { judge: 'bad id with spaces' } }).ok, false);
assert.equal(parseReviewSettings({ reviewInstructions: 'x'.repeat(8001) }).ok, false);

// --- Wiki settings ---
const wikiDefaults = parseWikiSettings({});
assert.deepEqual(wikiDefaults, { ok: true, wikiEnabled: true, wikiDir: '~/wiki', wikiTags: [], wikiCompanyTag: '' });
const wikiCustom = parseWikiSettings({ wikiEnabled: false, wikiDir: '/Users/me/notes', wikiTags: 'Project-Roku, project-globex project-globex' });
assert.deepEqual(wikiCustom, { ok: true, wikiEnabled: false, wikiDir: '/Users/me/notes', wikiTags: ['project-roku', 'project-globex'], wikiCompanyTag: '' });
assert.equal((parseWikiSettings({ wikiCompanyTag: 'Company-Acme' }) as { wikiCompanyTag: string }).wikiCompanyTag, 'company-acme');
assert.equal(parseWikiSettings({ wikiCompanyTag: 'acme' }).ok, false);
assert.equal(defaultCompanyTag('Acme'), 'company-acme');
assert.equal(defaultCompanyTag('Globex Corporation'), 'company-globex-corporation');
assert.equal(parseWikiSettings({ wikiDir: 'relative/path' }).ok, false);
assert.equal(parseWikiSettings({ wikiDir: '~/wiki\n/etc' }).ok, false);
assert.equal(parseWikiSettings({ wikiTags: 'bad tag!' }).ok, false);
const savedWithWiki = parseReviewSettings({ wikiTags: ['project-roku'] });
assert.equal(savedWithWiki.ok && savedWithWiki.settings.wikiDir, '~/wiki');

// --- Device builds ---
const build = parseBuildConfig({ command: 'npm run generate-code', outDir: './dist/', install: 'npm ci' });
assert.deepEqual(build, { ok: true, config: { command: 'npm run generate-code', outDir: 'dist', install: 'npm ci' } });
assert.equal(parseBuildConfig({ outDir: '../outside' }).ok, false);
assert.equal(parseBuildConfig({ outDir: '/abs' }).ok, false);
assert.equal(parseBuildConfig({ command: 'a\nb' }).ok, false);
assert.equal((parseBuildConfig({}) as { config: { outDir: string } }).config.outDir, '.');

const env = parseEnvBulk([
  '# Roku Globex',
  'ROKU_IP=192.168.1.9',
  'ROKU_DEV_PASSWORD=secret123',
  'APP_ENV=STG',
  'export GITHUB_TOKEN="abc def"',
  "CHARLES_PREFIX='x' ",
  'NAME=value # trailing comment',
  '# file: .env.STG',
  'API_URL=https://stg.example.com/api?x=1',
].join('\r\n'));
assert.equal(env.ok, true);
if (env.ok) {
  assert.deepEqual(env.env.files['.env'], { APP_ENV: 'STG', GITHUB_TOKEN: 'abc def', CHARLES_PREFIX: 'x', NAME: 'value' });
  assert.deepEqual(env.env.files['.env.STG'], { API_URL: 'https://stg.example.com/api?x=1' });
  assert.deepEqual(env.env.removed, ['ROKU_IP', 'ROKU_DEV_PASSWORD']);
  assert.equal(env.env.vars, 5);
  assert.equal(serializeEnvFile(env.env.files['.env']), 'APP_ENV=STG\nGITHUB_TOKEN="abc def"\nCHARLES_PREFIX=x\nNAME=value\n');
}
assert.equal(parseEnvBulk('# file: secrets.txt\nA=1').ok, false);
assert.equal(parseEnvBulk('not a pair').ok, false);
assert.equal(parseEnvBulk('1BAD=x').ok, false);

console.log('verify-project-config: ok');
