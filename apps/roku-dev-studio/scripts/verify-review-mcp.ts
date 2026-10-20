/** Pins the review MCP helpers: job ids, project lookup, remotes, the draft view. Run with `npm run verify:review-mcp`. */
import assert from 'node:assert/strict';
import { draftView, encodeJobId, parseGitHubRemote, parseJobId, resolveProject } from '../shared/review-mcp.js';

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

const projects = [{ id: 'a', name: 'A', repos: ['o/r'] }, { id: 'b', name: 'B', repos: ['o/r', 'o/s'] }];
assert.deepEqual(resolveProject('o/s', projects), { ok: true, projectId: 'b' });
assert.match((resolveProject('o/r', projects) as { error: string }).error, /A.*B/);
assert.deepEqual(resolveProject('o/r', projects, 'a'), { ok: true, projectId: 'a' });
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

console.log('verify-review-mcp: ok');
