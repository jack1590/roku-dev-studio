/** Pins the review MCP helpers: job ids, project lookup, remotes, the draft view. Run with `npm run verify:review-mcp`. */
import assert from 'node:assert/strict';
import { checkPostRequest, draftView, encodeJobId, parseGitHubRemote, parseJobId, resolveProject } from '../shared/review-mcp.js';

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

console.log('verify-review-mcp: ok');
