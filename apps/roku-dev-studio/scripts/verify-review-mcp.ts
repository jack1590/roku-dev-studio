/** Pins the review MCP helpers: job ids, project lookup, remotes, the draft view. Run with `npm run verify:review-mcp`. */
import assert from 'node:assert/strict';
import { checkPostRequest, draftView, encodeJobId, LOCAL_REVIEW_VERSION, olderLocalResults, parseGitHubRemote, parseJobId, prOnlyOpen, readDraft, resolveProject, reusableLocalReview, reviewDescription, reviewSince } from '../shared/review-mcp.js';

assert.equal(encodeJobId({ kind: 'pr', projectId: 'acme', repo: 'o/r', number: 12 }), 'pr:acme:o/r#12');
assert.equal(encodeJobId({ kind: 'local', projectId: 'acme', repo: 'o/r', branch: 'feat/x' }), 'local:acme:o/r:feat/x');
assert.deepEqual(parseJobId('pr:acme:o/r#12'), { kind: 'pr', projectId: 'acme', repo: 'o/r', number: 12 });
assert.deepEqual(parseJobId('local:acme:o/r:feat/a:b'), { kind: 'local', projectId: 'acme', repo: 'o/r', branch: 'feat/a:b' });
assert.equal(parseJobId('pr:acme:o/r#0'), null);
assert.equal(parseJobId('pr:acme:bad#3'), null);
assert.equal(parseJobId('local:acme:o/r:'), null);
assert.equal(parseJobId('nonsense'), null);

assert.equal(parseGitHubRemote('git@github.com:o/r.git'), 'o/r');
assert.equal(parseGitHubRemote('https://github.com/o/r'), 'o/r');
assert.equal(parseGitHubRemote('https://github.com/o/r.git'), 'o/r');
assert.equal(parseGitHubRemote('ssh://git@github.com/o/r.git'), 'o/r');
assert.equal(parseGitHubRemote('https://gitlab.com/o/r.git'), null);
assert.equal(parseGitHubRemote('https://x-access-token:ghp_secret@github.com/o/r.git'), 'o/r'); // credentials in the URL are ignored
assert.equal(parseGitHubRemote('https://user@github.com/o/r'), 'o/r');

const projects = [{ id: 'a', name: 'A', repos: ['o/r'] }, { id: 'b', name: 'B', repos: ['o/r', 'o/s'] }];
assert.deepEqual(resolveProject('o/s', projects), { ok: true, projectId: 'b', repo: 'o/s' });
assert.deepEqual(resolveProject('O/S', projects), { ok: true, projectId: 'b', repo: 'o/s' }); // GitHub names are case-insensitive; the project's spelling wins
assert.match((resolveProject('o/r', projects) as { error: string }).error, /A.*B/);
assert.deepEqual(resolveProject('o/r', projects, 'a'), { ok: true, projectId: 'a', repo: 'o/r' });
assert.match((resolveProject('o/x', projects) as { error: string }).error, /o\/x/);
assert.match((resolveProject('o/s', projects, 'a') as { error: string }).error, /not in/);

const view = draftView(
  {
    headSha: 'h',
    findings: [
      { id: 'f1', title: 'T', detail: 'd', status: 'issue', severity: 'major', confidence: 0.9, file: 'a.brs', line: 3, comment: 'ai' },
      { id: 'f2', postId: 'f2-reply-1', title: 'U', detail: 'd', status: 'issue', severity: 'minor', confidence: 0.6, comment: 'ai2' },
      { id: 'f3', title: 'V', detail: 'd', status: 'dismissed', severity: 'minor', confidence: 0.2, comment: 'x' },
      { id: 'f4', title: 'W', detail: 'd', status: 'issue', severity: 'minor' },
    ],
  },
  { edits: { f1: 'edited' }, posted: { 'f2-reply-1': { url: 'u' } } },
);
assert.equal(view[0].comment, 'edited');
assert.equal(view[0].postable, true);
assert.equal(view[1].id, 'f2-reply-1');
assert.equal(view[1].posted, true);
assert.equal(view[1].postedUrl, 'u');
assert.equal(view[2].postable, false);
assert.equal(view[3].postable, false); // no comment text

// review_post guard: every refusal happens before any GitHub call.
const prJob = parseJobId('pr:acme:o/r#12');
const base = { keySet: true, keyMatches: true, jobId: prJob, storedHeadSha: 'h', storedFinishedAt: 100, findings: view, headSha: 'h', finishedAt: 100, ids: ['f1'] };
assert.deepEqual(checkPostRequest(base), { ok: true, ids: ['f1'] });
assert.equal((checkPostRequest({ ...base, keySet: false }) as { status: number }).status, 403);
assert.equal((checkPostRequest({ ...base, keyMatches: false }) as { status: number }).status, 403);
assert.match((checkPostRequest({ ...base, keyMatches: false }) as { error: string }).error, /RDS_POST_KEY/);
assert.equal((checkPostRequest({ ...base, jobId: parseJobId('local:acme:o/r:feat/x') }) as { status: number }).status, 400);
assert.equal((checkPostRequest({ ...base, jobId: null }) as { status: number }).status, 400);
assert.equal((checkPostRequest({ ...base, storedHeadSha: null, findings: null }) as { status: number }).status, 404);
const stale = checkPostRequest({ ...base, headSha: 'old' }) as { status: number; error: string };
assert.equal(stale.status, 409);
assert.match(stale.error, /changed/);
// A re-review with no new commits keeps the head but drafts new comments: still stale.
assert.equal((checkPostRequest({ ...base, finishedAt: 99 }) as { status: number }).status, 409);
assert.equal((checkPostRequest({ ...base, finishedAt: undefined }) as { status: number }).status, 409);
const unknown = checkPostRequest({ ...base, ids: ['f1', 'nope', 'f3'] }) as { status: number; error: string };
assert.equal(unknown.status, 400);
assert.match(unknown.error, /nope/);
assert.match(unknown.error, /f3/); // dismissed: not postable
assert.equal((checkPostRequest({ ...base, ids: [] }) as { status: number }).status, 400);
assert.deepEqual(checkPostRequest({ ...base, ids: ['f2-reply-1'] }), { ok: true, ids: ['f2-reply-1'] }); // already posted is fine: posting skips it

const stored = { version: LOCAL_REVIEW_VERSION, base: 'develop' };
assert.equal(reusableLocalReview(stored, 'develop'), stored);
assert.equal(reusableLocalReview(stored, 'main'), null); // another base judged another diff
assert.equal(reusableLocalReview({ version: 1, base: 'develop' }, 'develop'), null); // may have read a stale base
assert.equal(reusableLocalReview(null, 'develop'), null);
assert.equal(reusableLocalReview({ ...stored, baseStale: true }, 'develop'), null); // judged a diff that may be wrong

// Where a new review starts: the last complete review's head, unless the project or this call asks for a full review.
const last = { result: { headSha: 'abc' } };
assert.equal(reviewSince(last, {}), 'abc');
assert.equal(reviewSince(last, { incrementalReview: true }), 'abc');
assert.equal(reviewSince(last, { incrementalReview: false }), undefined); // project setting off
assert.equal(reviewSince(last, { full: true }), undefined); // review_start full: this run only
assert.equal(reviewSince({ result: { headSha: 'abc', lostLenses: ['security'] } }, {}), undefined); // incomplete review
assert.equal(reviewSince(null, {}), undefined);

// A local review of a branch with an open PR also re-checks what the PR's review left open.
const own = [
  { id: 'a', status: 'issue' },
  { id: 'b', status: 'dismissed' },
];
const prFindings = [
  { id: 'a', status: 'issue' }, // the branch's review has it open already
  { id: 'b', status: 'needs-device' }, // the branch's judge dismissed it; the PR's still has it open
  { id: 'c', status: 'noted' },
  { id: 'd', status: 'dismissed' },
  { id: 'e', status: 'issue', ci: { check: 'lint' } }, // CI is read fresh for this commit
];
const prReview = { findings: prFindings, finishedAt: 2000 };
assert.deepEqual(prOnlyOpen({ findings: own, finishedAt: 1000 }, prReview).map((f) => f.id), ['b', 'c']);
assert.deepEqual(prOnlyOpen(undefined, prReview).map((f) => f.id), ['a', 'b', 'c']);
assert.deepEqual(prOnlyOpen({ findings: own, finishedAt: 1000 }, undefined), []);
// The branch's judge dismissed b after the PR review: that newer ruling stands, so b is not brought back.
assert.deepEqual(prOnlyOpen({ findings: own, finishedAt: 3000 }, prReview).map((f) => f.id), ['c']);

// A local review before the PR exists reads a draft title and description, inline or from a markdown file.
const files: Record<string, string> = { '/abs/draft.md': '# Fix\n\nPLAY-42: captions' };
const reader = (p: string) => {
  if (!(p in files)) throw new Error(`ENOENT: no such file or directory, open '${p}'`);
  return files[p];
};
assert.deepEqual(readDraft({}, reader), { ok: true });
assert.deepEqual(readDraft({ title: 'T', description: 'D' }, reader), { ok: true, title: 'T', description: 'D' });
assert.deepEqual(readDraft({ title: 'T', descriptionFile: '/abs/draft.md' }, reader), { ok: true, title: 'T', description: '# Fix\n\nPLAY-42: captions' });
assert.match((readDraft({ descriptionFile: 'draft.md' }, reader) as { error: string }).error, /descriptionFile must be an absolute path/);
const unreadable = readDraft({ descriptionFile: '/abs/missing.md' }, reader) as { ok: boolean; error: string };
assert.equal(unreadable.ok, false);
assert.match(unreadable.error, /\/abs\/missing\.md/);
assert.match((readDraft({ description: 'D', descriptionFile: '/abs/draft.md' }, reader) as { error: string }).error, /not both/);

// The open PR's own title and description win; the draft fills in when there is no PR or it has no description.
const openPr = { title: 'PR title', body: 'PR body' };
assert.deepEqual(reviewDescription(openPr, { title: 'Draft', description: 'Draft body' }), { title: 'PR title', body: 'PR body', descriptionSource: 'pr' });
assert.deepEqual(reviewDescription(undefined, { title: 'Draft', description: 'Draft body' }), { title: 'Draft', body: 'Draft body', descriptionSource: 'draft' });
assert.deepEqual(reviewDescription({ title: 'PR title', body: null }, { description: 'Draft body' }), { title: 'PR title', body: 'Draft body', descriptionSource: 'draft' });
assert.deepEqual(reviewDescription(undefined, {}), { title: '', body: '', descriptionSource: 'none' });
assert.deepEqual(reviewDescription(undefined, { title: 'Draft' }), { title: 'Draft', body: '', descriptionSource: 'none' }); // a title alone is not a description

// Earlier local results: the newest few are kept, by finish time, not by file-name order.
assert.deepEqual(olderLocalResults(['999.json', '1000.json', '1001.json', 'notes.txt'], 2), ['999.json']);
assert.deepEqual(olderLocalResults(['1.json', '2.json'], 5), []);

console.log('verify-review-mcp: ok');
