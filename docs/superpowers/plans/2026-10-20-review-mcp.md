# Review MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents in any MCP harness can start a code review of a GitHub PR or of a local branch, read the findings, and post approved comments to a PR (gated by a posting key).

**Architecture:** Five new MCP tools in `roku-dev-studio-mcp` call new routes on the existing loopback bridge (`main/mcp-bridge.ts`). The routes call functions extracted from the `ipcMain` handlers in `main/review/review-service.ts` and `main/review/review-posting.ts`, plus a new local-review runner (`main/review/local-review.ts`) built on a new `prepareLocalCheckout()` in `packages/roku-review/git.ts`. Pure logic (job ids, project resolution, draft view, remote parsing) lives in testable files without Electron imports.

**Tech Stack:** TypeScript, Electron main process, Node `child_process` git, MCP server (`packages/roku-dev-studio-mcp`), `tsx` verify scripts with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-19-review-mcp-design.md`

## Global Constraints

- App must be open; tools go through the bridge only. Bridge stays 127.0.0.1-only, bearer + Host/Origin checks unchanged.
- Pipeline never runs in the renderer.
- `review_post` takes finding ids only, never free text. No general comment from MCP in v1.
- Posting needs the posting key (`RDS_POST_KEY` env in the client's MCP config → header `X-RDS-Post-Key`). No key set in the app → posting off. Other tools never need it.
- Tokens, passwords, and the posting key never appear in tool output, bridge responses, or logs (the bridge audit log records `audit.params = body`; the key travels in a header, never in the body).
- Local reviews: committed work only, no device step, never posted, not in the PR list, keyed per branch.
- Severity/confidence floors come from Settings; never hard-coded.
- Version 1.6.0. Open a PR; do not merge, do not push a tag (a tag push triggers `release.yml` and in-app updates).
- Do not push to `upstream`. Do not force-push `origin/main`.

## Review Focus

1. **Local `path` that is not usable** (not a git repo, no `origin`, non-GitHub origin, repo in no project or in two projects): `review_start` returns a clear error naming what it found; no job is created. → Task 2 and Task 3 tests.
2. **Detached HEAD or no commits since base** in the local checkout: refuse with "check out a branch first" / "nothing to review: no commits on <branch> since <base>". → Task 2 tests.
3. **No `origin/HEAD`** (common after `git clone` of some hosts or `git remote add`): error tells the agent to pass `base`. → Task 2 test.
4. **Stale approval:** a re-review ran between `review_get` and `review_post` → `review_post` refuses on `headSha` mismatch, posts nothing. Unknown ids → refuse, posts nothing. → Task 5 test.
5. **Missing/wrong posting key, or none set in the app** → refuse before any GitHub call. → Task 5 test.

---

### Task 1: Pure helpers — job ids, project resolution, draft view

**Files:**
- Create: `apps/roku-dev-studio/shared/review-mcp.ts`
- Create: `apps/roku-dev-studio/scripts/verify-review-mcp.ts`
- Modify: `apps/roku-dev-studio/package.json` (add `"verify:review-mcp": "tsx scripts/verify-review-mcp.ts"` and include it wherever the other `verify:*` scripts are chained into `test`)

**Interfaces:**
- Produces:
  - `type ReviewJobId = { kind: 'pr'; projectId: string; repo: string; number: number } | { kind: 'local'; projectId: string; repo: string; branch: string }`
  - `encodeJobId(id: ReviewJobId): string` → `pr:<projectId>:<owner/name>#<number>` or `local:<projectId>:<owner/name>:<branch>`
  - `parseJobId(s: string): ReviewJobId | null` (branch is everything after the third `:`; validates repo with the same `REPO_PATTERN` as review-service, number a positive integer)
  - `resolveProject(repo: string, projects: { id: string; name: string; repos?: string[] }[], projectId?: string): { ok: true; projectId: string } | { ok: false; error: string }`
  - `parseGitHubRemote(url: string): string | null` → `owner/name` for `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`, `ssh://git@github.com/o/r(.git)`; `null` otherwise
  - `draftView(result: { headSha: string; findings: DraftSource[] }, posting: { edits: Record<string,string>; posted: Record<string,{ url?: string }> }): McpFinding[]` where `McpFinding = { id: string /* postId ?? id */; title; status; severity; confidence; file?; line?; endLine?; fix?: string; comment?: string /* edits[id] ?? comment */; posted: boolean; postedUrl?: string; postable: boolean /* status issue|needs-device and comment text */ }`. Take the field names for severity/confidence/fix from `ReviewFinding` in `packages/roku-review/review.ts`.

- [ ] **Step 1: Write failing tests in `scripts/verify-review-mcp.ts`**

```ts
assert.equal(encodeJobId({ kind: 'pr', projectId: 'acme', repo: 'o/r', number: 12 }), 'pr:acme:o/r#12');
assert.deepEqual(parseJobId('local:acme:o/r:feat/a:b'), { kind: 'local', projectId: 'acme', repo: 'o/r', branch: 'feat/a:b' });
assert.equal(parseJobId('pr:acme:o/r#0'), null);
assert.equal(parseJobId('pr:acme:bad#3'), null);
assert.equal(parseGitHubRemote('git@github.com:o/r.git'), 'o/r');
assert.equal(parseGitHubRemote('https://github.com/o/r'), 'o/r');
assert.equal(parseGitHubRemote('ssh://git@github.com/o/r.git'), 'o/r');
assert.equal(parseGitHubRemote('https://gitlab.com/o/r.git'), null);
const projects = [{ id: 'a', name: 'A', repos: ['o/r'] }, { id: 'b', name: 'B', repos: ['o/r', 'o/s'] }];
assert.deepEqual(resolveProject('o/s', projects), { ok: true, projectId: 'b' });
assert.match((resolveProject('o/r', projects) as { error: string }).error, /A.*B|more than one/);
assert.deepEqual(resolveProject('o/r', projects, 'a'), { ok: true, projectId: 'a' });
assert.match((resolveProject('o/x', projects) as { error: string }).error, /o\/x/);
assert.match((resolveProject('o/s', projects, 'a') as { error: string }).error, /not in/);
// draftView: edit wins over AI text; posted flag by post id; dismissed not postable
const v = draftView({ headSha: 'h', findings: [
  { id: 'f1', title: 'T', status: 'issue', severity: 'major', confidence: 0.9, file: 'a.brs', line: 3, comment: 'ai' },
  { id: 'f2', postId: 'f2-reply-1', title: 'U', status: 'issue', severity: 'minor', confidence: 0.6, comment: 'ai2' },
  { id: 'f3', title: 'V', status: 'dismissed', severity: 'minor', confidence: 0.2, comment: 'x' },
] }, { edits: { f1: 'edited' }, posted: { 'f2-reply-1': { url: 'u' } } });
assert.equal(v[0].comment, 'edited');
assert.equal(v[1].id, 'f2-reply-1'); assert.equal(v[1].posted, true); assert.equal(v[1].postedUrl, 'u');
assert.equal(v[2].postable, false);
console.log('verify-review-mcp: ok');
```

- [ ] **Step 2:** Run `cd apps/roku-dev-studio && npx tsx scripts/verify-review-mcp.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `shared/review-mcp.ts` with the signatures above. No Electron, no Node fs.
- [ ] **Step 4:** Re-run → prints `verify-review-mcp: ok`.
- [ ] **Step 5:** Commit `feat(review-mcp): job ids, project resolution and draft view helpers`.

---

### Task 2: `prepareLocalCheckout()` in roku-review

**Files:**
- Modify: `packages/roku-review/git.ts` (make `git()`'s `token` optional: no auth env when absent; add `prepareLocalCheckout`)
- Modify: `packages/roku-review/prompts.ts:94-99` (`prBlock`: when `ctx.prNumber === 0` print `Local branch ${headRef} (no pull request yet) by ${author}` instead of the `Pull request #…` line)
- Test: `packages/roku-review/verify-review.ts`

**Interfaces:**
- Consumes: `parseGitHubRemote` is NOT imported here (packages must not depend on the app); duplicate nothing — the caller (Task 3) parses the remote. This task returns the raw remote URL.
- Produces:
  ```ts
  export interface LocalCheckout extends Checkout { branch: string; originUrl: string; author: string }
  export async function prepareLocalCheckout(input: {
    path: string; base?: string; dataDir: string; signal?: AbortSignal; sinceSha?: string;
  }): Promise<LocalCheckout>
  ```
  - Reads only from the user's repo: `rev-parse --show-toplevel`, `symbolic-ref --short HEAD`, `remote get-url origin`, `config user.name` (fallback `'local'`), `rev-parse HEAD`, base resolution, `merge-base`, `diff`. Never fetches, never writes refs or worktrees in the user's repo.
  - Base: `input.base` → first of `refs/remotes/origin/<base>`, `refs/heads/<base>` that resolves; absent → `git symbolic-ref refs/remotes/origin/HEAD`. Validate with `REF_PATTERN` and the same `-`/`..` checks as `prepareCheckout`.
  - Worktree: `<dataDir>/local/<slug(owner/name-or-dirname)>__<branch-slug>`; recreate fresh each run via `git clone --shared --no-checkout <toplevel> <worktree>` then `git -C <worktree> checkout --detach <headSha>`. Write `.rds-review/pr.diff` like `prepareCheckout`.
  - `sinceDiff`: same ancestor rule and file restriction as `prepareCheckout`.
  - Also export `removeLocalCheckout(worktree: string): Promise<void>` (rm -rf; ignore errors).

- [ ] **Step 1: Write failing tests** in `verify-review.ts` using a temp dir: create bare `origin.git`; clone to `work`; commit `a.brs` on `main`, push, `git remote set-head origin main`; branch `feat/x`, commit `b.brs`; then write an uncommitted change to `b.brs`.
  ```ts
  const co = await prepareLocalCheckout({ path: work, dataDir });
  assert.equal(co.branch, 'feat/x');
  assert.match(co.diff, /b\.brs/); assert.doesNotMatch(co.diff, /a\.brs/);
  assert.doesNotMatch(co.diff, /UNCOMMITTED/);                 // uncommitted edit excluded
  assert.equal(readFileSync(join(co.worktree, 'b.brs'), 'utf8').includes('UNCOMMITTED'), false);
  // second commit, incremental
  const co2 = await prepareLocalCheckout({ path: work, dataDir, sinceSha: co.headSha });
  assert.ok(co2.sinceDiff !== undefined && /c\.brs|second/.test(co2.sinceDiff));
  // explicit base that exists only locally
  await prepareLocalCheckout({ path: work, base: 'main', dataDir });
  // errors
  await assert.rejects(prepareLocalCheckout({ path: tmpNonRepo, dataDir }), /not a git/i);
  await assert.rejects(prepareLocalCheckout({ path: detached, dataDir }), /check out a branch/i);
  await assert.rejects(prepareLocalCheckout({ path: noOriginHead, dataDir }), /pass .*base/i);
  await assert.rejects(prepareLocalCheckout({ path: onMainNoCommits, dataDir }), /nothing to review/i);
  ```
- [ ] **Step 2:** `npm run verify -w roku-dev-studio-review` → FAIL (`prepareLocalCheckout` not exported).
- [ ] **Step 3:** Implement per Interfaces. Error copy: `"<path> is not a git checkout."`, `"HEAD is detached. Check out a branch first."`, `"Could not tell the base branch (origin/HEAD is not set). Pass base, e.g. \"develop\"."`, `"Base branch \"<base>\" not found locally or on origin."`, `"Nothing to review: no commits on <branch> since <base>."`, `"This checkout has no origin remote."`.
- [ ] **Step 4:** Re-run verify → passes; `npm run typecheck:review` passes.
- [ ] **Step 5:** Commit `feat(review): local branch checkout for pre-PR reviews`.

---

### Task 3: Local review runner + review-service extraction

**Files:**
- Create: `apps/roku-dev-studio/main/review/local-review.ts`
- Modify: `apps/roku-dev-studio/main/review/review-service.ts` (extract and export; IPC handlers keep their behaviour)
- Modify: `apps/roku-dev-studio/main/ipc/project-handlers.ts` (export `listProjectRecords(): ProjectRecord[]` → `readRegistry()`)

**Interfaces:**
- Consumes: Task 1 `resolveProject`, `parseGitHubRemote`, `encodeJobId`; Task 2 `prepareLocalCheckout`, `removeLocalCheckout`.
- Produces (from `review-service.ts`):
  - `startReview(projectId: string, repo: string, number: number): { success: true; summary: ReviewSummary } | { success: false; error: string }` — body of today's `ReviewsStart` handler; the handler calls it.
  - `getReviewSummary(projectId: string, repo: string, number: number): ReviewSummary | null` — in-memory job if not `done`, else `summaryOfStored(readStored(...))`.
  - `export { readStored, resultPath }` and `export function reviewDataDir(): string`.
  - `wikiContext(project: Project, repo: string, changedFiles: string[]): Promise<{ wikiBlock: string; wikiPages: string[] }>` — extracted from `execute()`; `execute()` uses it.
- Produces (from `local-review.ts`):
  - `startLocalReview(input: { path: string; base?: string; projectId?: string }): Promise<{ success: true; jobId: string; summary: LocalSummary } | { success: false; error: string }>`
  - `getLocalReview(jobId: string): { summary: LocalSummary; result?: ReviewResult } | null`
  - `LocalSummary = { jobId; repo; branch; base; status: JobStatus; phase?; detail?; error?; headSha?; counts?; finishedAt?; lostLenses? }`
  - Storage: `<reviewDataDir()>/local/<projectId>/<owner__name>__<branch-slug>.json` holding `{ version: 1, projectId, repo, branch, base, result }`.

Behaviour of a local job (`executeLocal`), mirroring `execute()` without PR-only parts:
- Resolve: `prepareLocalCheckout` is called inside the job, but project resolution happens synchronously in `startLocalReview` first: read origin with `git remote get-url origin` (execFile, no shell) → `parseGitHubRemote` → `resolveProject(repo, listProjectRecords(), projectId)`; failure returns `{ success: false }` with no job.
- Same project checks as `execute()` (Cursor key required; GitHub token not required for local).
- Previous stored local review for the same branch → `sinceSha` (unless `project.incrementalReview === false` or it lost lenses); `previous` / `recheck` passed to `runReview` exactly as `execute()` does; "no new changes" carry-over branch too.
- Context: `prNumber: 0`, `title: ''`, `body: ''`, `author: co.author`, `baseRef: co.baseRef`, `headRef: co.branch`; JIRA via `lookupTicket({ ..., pr: { title: '', body: '', branch } })`; no `fetchCi`, no `fetchDiscussion`; `dismissals` from `loadDismissals(repo)` (team dismissals apply to the repo, not a PR); `prTests: []`; standards + changed files + wiki as in `execute()`.
- No device step. `removeLocalCheckout(worktree)` in `finally`.
- One job per jobId at a time: starting while queued/running returns the running summary. Local jobs do not use the PR queue (`MAX_PARALLEL`) or device pool. `// ponytail: local jobs run unqueued; add a cap if agents start many at once.`
- Progress: no window broadcast (not in PR list).

- [ ] **Step 1:** Extract `startReview`, `getReviewSummary`, `wikiContext`, `reviewDataDir`; switch the `ReviewsStart` handler and `execute()` to use them.
- [ ] **Step 2:** `npm run typecheck` → passes (pure refactor).
- [ ] **Step 3:** Implement `local-review.ts` per Interfaces.
- [ ] **Step 4:** `npm run typecheck` → passes. Manual check deferred to Task 6 (needs the app + Cursor key).
- [ ] **Step 5:** Commit `feat(review): local branch reviews in main, review-service entry points for the bridge`.

---

### Task 4: Posting extraction + posting key store and Settings UI

**Files:**
- Modify: `apps/roku-dev-studio/main/review/review-posting.ts`
- Create: `apps/roku-dev-studio/main/mcp-post-key.ts`
- Modify: `apps/roku-dev-studio/main/settings-window-ipc.ts`, `apps/roku-dev-studio/shared/ipc/channels.ts`, `apps/roku-dev-studio/preload-settings.ts` (and `preload-settings.js` if it is a checked-in build output — follow how `openMcpConfig` is wired in both), `apps/roku-dev-studio/renderer/components/settings/settings.ts`, `apps/roku-dev-studio/renderer/settings.html`, `apps/roku-dev-studio/shared/strings/settings.ts`

**Interfaces:**
- Produces (`review-posting.ts`):
  - `startPosting(p: { projectId: string; repo: string; number: number; ids: string[]; general?: string | null; spaced?: boolean; maxMinutes?: number }): Promise<{ success: false; error: string } | { success: true; run: PostUpdate; done: Promise<PostUpdate> }>` — today's `ReviewsPost` body; `done` resolves when the async loop ends. The IPC handler calls it and returns `{ success, run }` / `{ success, error }` as today. Module-level `deps` set in `setupPostingHandlers`.
  - `readPostingState(projectId: string, repo: string, number: number): { edits: Record<string,string>; posted: Record<string,{ at: number; url?: string }> }`
- Produces (`mcp-post-key.ts`):
  - `hasPostKey(): boolean`, `getPostKey(): string | null`, `generatePostKey(): string` (32 random bytes, base64url, replaces any old key), `clearPostKey(): void`. Stored with `tokenStore.setSecret('__app__', 'mcp-post-key', …)`.
- IPC channel `SettingsWindowMcpPostKey: 'settings-window:mcp-post-key'`, payload `{ action: 'status' | 'generate' | 'clear' }` → `{ success: true; set: boolean; key?: string }` (`key` only on `generate`). Preload: `mcpPostKey(action)`.
- UI under the MCP clients list in Settings → MCP Server: label "Posting key", status text ("Not set — agents cannot post review comments." / "Set — clients with RDS_POST_KEY can post review comments."), buttons Generate (Rotate when set) and Clear. On generate, show the key once in a read-only field with Copy, plus hint: `Add it to a client's MCP config as "env": { "RDS_POST_KEY": "…" }. Only clients you give it to can post.` Strings in `shared/strings/settings.ts`, same style as the `mcp*` keys.

- [ ] **Step 1:** Extract `startPosting` and `readPostingState`; `ReviewsPost` handler delegates.
- [ ] **Step 2:** Add `mcp-post-key.ts`, IPC, preload, UI, strings.
- [ ] **Step 3:** `npm run typecheck` passes; `npm run verify:i18n -w roku-dev-studio` passes (if it checks the new strings).
- [ ] **Step 4:** Commit `feat(mcp): posting key in Settings; posting callable outside IPC`.

---

### Task 5: Bridge routes + MCP tools + docs

**Files:**
- Modify: `apps/roku-dev-studio/main/mcp-bridge.ts` (routes; header comment: no longer read-only, `review_post` posts to GitHub behind the posting key)
- Modify: `packages/roku-dev-studio-mcp/src/bridge-client.ts` (`BridgeRequest.headers?: Record<string,string>` merged into request headers)
- Create: `packages/roku-dev-studio-mcp/src/review-tools.ts` (`export const REVIEW_TOOLS: Tool[]`)
- Modify: `packages/roku-dev-studio-mcp/src/tools.ts` (`registerTools(REVIEW_TOOLS)`; `TOOL_CATEGORY_GROUPS['PR Reviews'] = ['review_start','review_status','review_get','review_post','review_list']`; export `Tool`, `jsonResult`, `errorResult`, `bridgeToolFailure` if review-tools needs them, or keep tools in tools.ts if exporting is messier)
- Modify: server `instructions` / quick-start resource (`packages/roku-dev-studio-mcp/src/resources.ts` or `prose/`), `packages/roku-dev-studio-mcp/README.md` tool catalog, `renderer/components/settings/mcp-tools-modal.ts` `MCP_TOOL_GROUPS`, `shared/strings/settings.ts` `mcpToolCategories` — exactly what `npm run verify:mcp-tools -w roku-dev-studio` checks. Regenerate `docs/mcp-tools.json` with the existing generator (`scripts/gen-docs-entry.ts`).
- Test: `apps/roku-dev-studio/scripts/verify-review-mcp.ts` (route-level checks via an exported pure guard)

**Bridge routes** (all POST, JSON body, existing auth):

| Route | Body | Response |
|-------|------|----------|
| `/review/start` | `{ repo, number, projectId? }` or `{ path, base?, projectId? }` | `{ jobId, summary }` |
| `/review/status` | `{ jobId }` | `{ jobId, status, phase?, detail?, error?, counts?, headSha? }` |
| `/review/get` | `{ jobId }` | `{ jobId, kind, repo, number?, branch?, base?, headSha, summary: string, counts, lostLenses?, skippedFiles?, ticket?: string, findings: McpFinding[] }` (only when status `done`; else 409 with status) |
| `/review/post` | `{ jobId, headSha, ids }` + header `X-RDS-Post-Key` | `{ results: Record<id, { posted: true; url?: string } \| { error: string }> }` |
| `/review/list` | `{ projectId? }` | recent PR summaries (from `ReviewsList` logic) with `jobId` added |

`/review/post` order of checks, each failing before any GitHub call:
1. No key set in app, or header missing/wrong (compare with `safeStringEqual`) → 403 `"Posting is not enabled for this client. Set a posting key in Dev Studio → Settings → MCP Server and pass it as RDS_POST_KEY."`
2. jobId not `pr` kind → 400 `"Local reviews are never posted."`
3. No stored review → 404. `headSha` ≠ stored `result.headSha` → 409 `"The review changed since you read it (re-reviewed at <sha7>). Call review_get again and get approval for the new comments."`
4. Any id not a postable id in `draftView(...)` → 400 listing them.
5. `startPosting({ ..., ids, general: null, spaced: false })`; await `done`; map `posted`/`errors` to `results`.

Put checks 1–4 in a pure `checkPostRequest(...)` in `shared/review-mcp.ts` (inputs: keySet, keyMatches, jobId, stored headSha/findings view, body) so they are unit-tested; the route only feeds it.

Never copy the header into `audit.params`.

**MCP tools** (`review-tools.ts`): one per route, `inputSchema` mirroring the body, `outputSchema` per table, annotations: start `readOnlyHint:false, destructiveHint:false, openWorldHint:true`; status/get/list `readOnlyHint:true`; post `readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:true`. `review_post` sends `headers: { 'X-RDS-Post-Key': process.env.RDS_POST_KEY ?? '' }`. Descriptions must say: reviews take minutes — call `review_status` every ~30 s, don't block; `review_post` posts only ids the user explicitly approved, with the `headSha` from `review_get`; local reviews cannot be posted.

- [ ] **Step 1: Write failing tests** for `checkPostRequest` in `verify-review-mcp.ts`: no key set → 403; wrong key → 403; local jobId → 400; headSha mismatch → 409; unknown id → 400 naming it; already-posted id is allowed (startPosting skips it); valid → ok.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `checkPostRequest`, routes, bridge-client headers, tools, docs. **Step 4:** Run `npx tsx scripts/verify-review-mcp.ts`, `npm run verify:mcp-tools -w roku-dev-studio`, `npm run typecheck` → all pass.
- [ ] **Step 5:** Commit `feat(mcp): review_start/status/get/post/list tools`.

---

### Task 6: End-to-end check, release 1.6.0, PR

**Files:**
- Modify: `apps/roku-dev-studio/package.json` version `1.6.0`, `package-lock.json` (via `npm install --package-lock-only`), `CHANGELOG.md` (`## [1.6.0]` with Added: review MCP tools, local branch reviews, posting key), `docs/features.html`, `docs/index.html`, `docs/mcp.html` (version strings, as in commit 478aa3e)

- [ ] **Step 1:** `npm test` and `npm run typecheck` from repo root → pass (report failures verbatim).
- [ ] **Step 2:** `npm start`; with the app open, from the MCP package run the server against it (or a client) and call `review_start { path: <this worktree> , base: 'main' }` → job id; `review_status` until done; `review_get` returns findings with ids and `headSha`. Call `review_post` without `RDS_POST_KEY` → 403 message. (A real post is left to the user's test.)
- [ ] **Step 3:** Bump version/docs/changelog; `npm run verify:doc-versions -w roku-dev-studio` passes.
- [ ] **Step 4:** Commit `chore(release): 1.6.0`; push `feat/review-mcp` to `origin`; `gh pr create --base main` with a body that says: not to merge or tag until the user tests. No tag.
