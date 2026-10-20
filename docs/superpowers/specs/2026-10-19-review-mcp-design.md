# Review tools in the MCP server — design

Date: 2026-10-19

## Intent

Let an AI agent in any harness (Claude Code, Cursor, openclaw) trigger the existing review pipeline and read its results, without the user touching the Dev Studio UI.

Two use cases drive it:

1. **Pre-PR self-review.** While working on a local branch, the agent asks for a review of the committed work on that branch. It gets structured findings back and acts on them per the user's own agent instructions (fix, ignore, ask). Nothing is posted anywhere.
2. **Remote review with approval.** The user is away from the desk. Over WhatsApp/Telegram they ask openclaw (running on the same Mac) to review a PR. openclaw starts the review, then sends the user the report and the draft comments. The user replies with which ones to post; openclaw posts only those.

## Goals

- Agent can start a review of a GitHub PR (`repo` + `number`) or of a local checkout (`path`).
- Agent can poll progress and read the finished result, including each finding's draft comment and a stable id.
- Agent can post a chosen subset of a PR review's comments, by id.
- Reviews started from MCP are the same jobs the PR Reviews tab runs: same queue, same device pool, same stored results, visible in the app.

## Non-goals (for now)

- Headless operation with the app closed. The user keeps the app open; the tools go through the existing loopback bridge. (AGENTS.md's long-term "run headless" goal is untouched, not advanced.)
- Rewording comments from the agent before posting. Wanted later; the app already stores edits (`ReviewsSaveComment` in `main/review/review-posting.ts`), so a later `review_edit_comment` tool can reuse it.
- Reviewing uncommitted changes.
- Device verification for local reviews.
- Remote/network access to the bridge. It stays 127.0.0.1 only.

## Anti-goals (failure even if it works)

- The agent can post text it wrote itself. `review_post` takes finding ids only, never free text.
- A local review posts anything, or shows up in the PR list as if it were a PR.
- Tokens, passwords, device passwords, or the posting key reach the agent through tool output. They stay in the main process, as today.
- MCP-started reviews fight the UI for devices or double-post comments.

## Current state (what exists)

- `packages/roku-review`: pipeline core, no Electron imports. `runReview()` takes a worktree, prompt context, models, and the Cursor key. `prepareCheckout()` is PR-only (needs `prNumber`, fetches PR refs).
- `apps/roku-dev-studio/main/review/review-service.ts`: job queue, device pool, result storage (keyed `projectId + repo + number`), progress broadcast to windows. Entry points are `ipcMain` handlers (`ReviewsStart`, `ReviewsGet`, `ReviewsList`, …).
- `apps/roku-dev-studio/main/review/review-posting.ts`: posting via `ReviewsPost`. Already: hidden marker so nothing posts twice, replies into existing threads, falls back to a plain PR comment when the line isn't in the diff, refuses to comment on the token owner's own PR, optional spaced posting queue (in-process).
- Tokens: `project-token-store.ts` (Electron `safeStorage`), read only in main.
- `packages/roku-dev-studio-mcp`: MCP server spawned by the harness; calls the running app through `main/mcp-bridge.ts` (loopback HTTP, per-launch bearer token, DNS-rebinding checks). Bridge is documented as "read-only by design"; the only write is `send_script_to_builder`.

## Design

### Tools (in `roku-dev-studio-mcp`)

| Tool | Input | Returns |
|------|-------|---------|
| `review_start` | either `{ repo, number }` or `{ path, base? }`, plus optional `projectId` | `{ jobId }` immediately (reviews take minutes) |
| `review_status` | `{ jobId }` | phase/progress; when done, a short summary (counts by status/severity) |
| `review_get` | `{ jobId }` | full findings: id, title, status, severity, confidence, file, line, suggested fix, draft comment text, already-posted flag; plus lost lenses, skipped files, ticket used |
| `review_post` | `{ jobId, headSha, finishedAt, ids: string[] }` | per-id result (posted url / error / already posted) |
| `review_list` (optional) | `{ projectId? }` | recent reviews, so an agent can find one it didn't start |

`jobId` is opaque to the agent. For PR reviews it maps to the existing `projectId + repo + number` key, so a review started from the UI is also reachable.

Long-running: `review_start` returns at once; the agent polls `review_status`. No streaming.

### Bridge routes (in `main/mcp-bridge.ts`)

New hand-written routes, one per tool, behind the existing bearer + Host/Origin checks. They call into review-service / review-posting functions directly.

To make that possible, the bodies of the `ReviewsStart`, `ReviewsGet`, `ReviewsList`, and `ReviewsPost` handlers move into exported functions that the IPC handlers and the bridge routes both call. Behaviour of the IPC handlers does not change.

`review_post` is the bridge's first write that leaves the machine. Update the bridge header comment to say so. Guard: it accepts only ids that exist in a finished stored review for that PR, at the `headSha` the caller passes.

**Posting key** (user's decision). Posting needs a second secret on top of the bridge token:

- Settings → MCP Server has a posting key: generate (shown once, copyable), rotate, clear. Stored with `safeStorage` like other tokens; never logged, never returned over the bridge.
- A client that may post gets it as `RDS_POST_KEY` in its MCP config `env` (the user adds it by hand, e.g. to openclaw's config). The settings writer does not add it to other clients automatically.
- The MCP server sends it as a header on `review_post` only. The bridge compares it in constant time; missing/wrong/no key set → refuse with a clear error ("posting is not enabled for this client").
- No key set in the app → posting from MCP is off. Other review tools never need the key.

Why: it scopes posting to the clients the user chose. Main threat is prompt injection: PR text and diffs the agent reads could tell it to post; Claude Code / Cursor without the key cannot. It does not stop malware running as the user (it can read client config too).

### Project resolution

- PR review: find the project whose repos include `repo`. None → clear error. More than one → error listing them, unless `projectId` was passed. (Designer's call.)
- Local review: read the checkout's `origin` remote, normalise to `owner/name`, then the same lookup. No origin / no match → clear error naming the remote it found.

The project supplies GitHub/Cursor/JIRA tokens and model choices, as today.

### Local review path

- `path` must be a git checkout. The agent passes it explicitly (the MCP process's cwd is not reliable).
- **Committed work only.** Create a temporary detached worktree of that repo at its current `HEAD` sha, under the app's review data dir (same area `prepareCheckout` uses). The user's live folder is never read by reviewers, so uncommitted edits stay invisible and the user can keep working.
- **Base branch.** `base` if given; otherwise the repo's default branch from `origin/HEAD`. Diff is `merge-base(base, HEAD)..HEAD`. Projects that integrate into `develop` etc. pass `base` (or the agent's instructions do).
- Context: JIRA key from the branch name only (no PR title/description). No CI lookup, no PR discussion, no dismissals by PR. Standards files come from the worktree as usual.
- No device verification step.
- **Re-review on the same branch** (designer's recommendation, user agreed): behaves like a PR re-review. The previous local review's still-open findings are re-checked (marked fixed / still open) and, when the previous head is still in the branch history, only the new commits are reviewed. Rebase or history rewrite → full review with re-check, same fallback as `execute()` in `review-service.ts`. Reuse its `previous` / `recheck` inputs to `runReview`; do not build a second mechanism.
- Result is stored separately from PR reviews, keyed per branch (e.g. `local:<repo>:<branch>`), not shown in the PR list. The planner decides whether the app shows it anywhere; it must not look like a PR.
- `review_post` refuses local reviews.
- Temp worktree is removed when the job ends.

`prepareCheckout()` stays PR-only; add a sibling for the local case in `packages/roku-review/git.ts` rather than overloading it. Prompts that print `repo#number` need a local variant (e.g. `repo@branch`).

### Posting

Approval must cover the exact text the user saw (designer's call):

- `review_get` returns each finding's *effective* comment text: the UI's saved edit (`state.edits[id]`) if one exists, else the AI's comment. That is the text that will post.
- `review_get` returns the review's `headSha` and `finishedAt`; `review_post` requires both and refuses when the stored review's differ (a re-review happened since the user approved, even one with no new commits).
- No general comment from MCP in v1: its text is built in the renderer (`generalText()` in `pr-reviews-panel.ts`) and `ReviewsPost` takes it as free text. Add later by moving that function to `shared/`. (Designer's call.)

Otherwise `review_post` reuses the `ReviewsPost` logic as-is: markers, thread replies, line fallback, own-PR refusal, ids only. Posts immediately (not spaced) unless the planner finds a reason otherwise. Approval happens outside the app (the user tells openclaw which ids); the tool trusts the ids it is given but only from the stored review.

### MCP docs

Add the tools to the server's `instructions`, the quick-start resource, and `docs/mcp-tools.html`. Instructions must say: poll, don't block; post only ids the user approved.

## Constraints

- App must be open (bridge only lives while it runs). Tools return a clear "Dev Studio is not running" error otherwise (the bridge client already detects this).
- Pipeline never runs in the renderer; all new work is main-process.
- Severity/confidence floors come from Settings, not hard-coded.
- No secrets in MCP responses or logs.
- Keep upstream-owned files' changes minimal; `mcp-bridge.ts` and the MCP package are ours to extend.

## Left to the builder

- Exact tool names/schemas and output shape (follow the existing tool conventions and output-schema validator in `roku-dev-studio-mcp`).
- How jobIds are encoded.
- Whether `review_list` ships in the first cut.
- Where the local-review temp worktree lives and how it is cleaned on crash.
- Whether the app UI shows local reviews at all in v1.
- Tests: follow `packages/roku-review/verify-review.ts` style for pure logic (remote parsing, base resolution, id filtering).

## Later

- `review_edit_comment` (reword before posting) on top of the existing edits store.
- Headless runner that survives a closed window (needs a non-Electron secret store).
