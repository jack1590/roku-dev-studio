/**
 * Reviews of a local branch before it is a PR, started by an agent through the MCP bridge.
 *
 * - Committed work only: the review reads a copy at HEAD (see `prepareLocalCheckout`), never the
 *   user's folder, so uncommitted edits stay out.
 * - Same pipeline as a PR review, minus the device step. When the branch has an open PR, the review
 *   reads what a PR review reads: its base, description, discussion and CI. Without one, JIRA comes
 *   from the branch name only.
 * - Kept per branch, apart from PR reviews (not in the PR list, never posted). A second review of
 *   the same branch and base re-checks the open findings and reviews only the new commits, like a PR
 *   re-review. Another base starts clean.
 */

import { agentBackendFor } from './claude-code';
import { budgetDiff, ciPromptBlock, countFindings, discussionPromptBlock, dismissalPromptBlock, fetchCi, fetchDiscussion, fileInventory, lookupTicket, prepareLocalCheckout, readChangedFiles, readStandards, removeLocalCheckout, runReview, ticketPromptBlock, type ReviewResult } from 'roku-dev-studio-review';
import { encodeJobId, LOCAL_REVIEW_VERSION, parseGitHubRemote, resolveProject, reusableLocalReview } from '../../shared/review-mcp';
import { getProjectRecord, listProjectRecords } from '../ipc/project-handlers';
import * as tokenStore from '../project-token-store';
import { loadDismissals } from './review-dismissals';
import { githubJson, reviewDataDir, wikiContext, type JobStatus } from './review-service';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process') as typeof import('child_process');
const { mainLog, mainWarn } = require('../log');

export interface LocalSummary {
  jobId: string;
  projectId: string;
  repo: string;
  branch: string;
  base?: string;
  status: JobStatus;
  phase?: string;
  detail?: string;
  error?: string;
  headSha?: string;
  counts?: ReviewResult['counts'];
  finishedAt?: number;
  lostLenses?: string[];
}

interface StoredLocal {
  version: number;
  projectId: string;
  repo: string;
  branch: string;
  base: string;
  /** What the reader should know about the base, e.g. that it could not be refreshed. */
  baseNotes?: string[];
  /** The diff used a local base that could not be refreshed: not a starting point for the next review. */
  baseStale?: boolean;
  /** The open PR whose description, discussion and CI the review read. */
  pullRequest?: number;
  result: ReviewResult;
}

interface OpenPr {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  base: { ref: string };
  head: { sha: string };
}

const jobs = new Map<string, LocalSummary>();

const slug = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
const storedPath = (projectId: string, repo: string, branch: string) => path.join(reviewDataDir(), 'local', slug(projectId), `${repo.replace('/', '__')}__${slug(branch)}.json`);

function readStoredLocal(projectId: string, repo: string, branch: string): StoredLocal | null {
  try {
    return JSON.parse(fs.readFileSync(storedPath(projectId, repo, branch), 'utf-8')) as StoredLocal;
  } catch {
    return null;
  }
}

function gitOut(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))));
}

/** Start a review of the branch checked out at `input.path` (or return the one already running). */
export async function startLocalReview(input: { path: string; base?: string; projectId?: string }): Promise<{ success: true; jobId: string; summary: LocalSummary } | { success: false; error: string }> {
  if (!input.path || !path.isAbsolute(input.path) || !fs.existsSync(input.path)) return { success: false, error: 'path must be an absolute path to a git checkout.' };
  const url = await gitOut(['remote', 'get-url', 'origin'], input.path).catch(() => '');
  if (!url) return { success: false, error: `${input.path} is not a git checkout with an origin remote.` };
  // Never echo the URL: it can carry credentials (https://user:token@github.com/...).
  const remote = parseGitHubRemote(url);
  if (!remote) return { success: false, error: 'The origin remote is not a GitHub repository.' };
  const resolved = resolveProject(remote, listProjectRecords(), input.projectId);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const repo = resolved.repo;
  const branch = await gitOut(['symbolic-ref', '--short', 'HEAD'], input.path).catch(() => '');
  if (!branch) return { success: false, error: 'HEAD is detached. Check out a branch first.' };

  const jobId = encodeJobId({ kind: 'local', projectId: resolved.projectId, repo, branch });
  const existing = jobs.get(jobId);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) return { success: true, jobId, summary: existing };
  const job: LocalSummary = { jobId, projectId: resolved.projectId, repo, branch, status: 'running', phase: 'preparing', detail: 'starting' };
  jobs.set(jobId, job);
  mainLog(`[reviews] start local ${repo}@${branch}`);
  // ponytail: local jobs run unqueued; add a cap if agents start many at once.
  void executeLocal(job, input.path, input.base).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    mainWarn(`[reviews] local ${repo}@${branch} failed: ${message}`);
    Object.assign(job, { status: 'failed', phase: undefined, detail: undefined, error: message });
  });
  return { success: true, jobId, summary: { ...job } };
}

/** The local review's live state, and its result once saved. */
export function getLocalReview(projectId: string, repo: string, branch: string): { summary: LocalSummary; result?: ReviewResult; base?: string; baseNotes?: string[]; pullRequest?: number } | null {
  const jobId = encodeJobId({ kind: 'local', projectId, repo, branch });
  const job = jobs.get(jobId);
  if (job && job.status !== 'done') return { summary: { ...job } };
  const stored = readStoredLocal(projectId, repo, branch);
  if (!stored) return null;
  const r = stored.result;
  return { summary: { jobId, projectId, repo, branch, base: stored.base, status: 'done', headSha: r.headSha, counts: r.counts, finishedAt: r.finishedAt, lostLenses: r.lostLenses }, result: r, base: stored.base, baseNotes: stored.baseNotes, pullRequest: stored.pullRequest };
}

/** The branch's open PRs on this repo: a failed lookup only costs the PR's context. */
async function openPrsFor(token: string, repo: string, branch: string): Promise<OpenPr[]> {
  const owner = repo.split('/')[0];
  return githubJson<OpenPr[]>(token, `/repos/${repo}/pulls?state=open&per_page=5&head=${encodeURIComponent(`${owner}:${branch}`)}`).catch((err: unknown) => {
    mainWarn(`[reviews] could not look up the PR of ${repo}@${branch}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
}

async function executeLocal(job: LocalSummary, checkoutPath: string, base?: string): Promise<void> {
  const update = (patch: Partial<LocalSummary>) => Object.assign(job, patch);
  const project = getProjectRecord(job.projectId);
  if (!project) throw new Error('Project not found.');
  const { apiKey: cursorKey, backend } = await agentBackendFor(project);
  const token = tokenStore.getToken(project.id, 'github') ?? undefined;

  update({ detail: 'looking for an open pull request' });
  const prs = token ? await openPrsFor(token, job.repo, job.branch) : [];
  const pr = prs[0];

  update({ detail: 'checking out the committed work' });
  const stored = readStoredLocal(job.projectId, job.repo, job.branch);
  const sinceSha = project.incrementalReview !== false && stored && !stored.result.lostLenses?.length ? stored.result.headSha : undefined;
  const checkout = await prepareLocalCheckout({
    path: checkoutPath,
    base,
    prBase: pr?.base.ref,
    dataDir: reviewDataDir(),
    sinceSha,
    remote: { url: `https://github.com/${job.repo}.git`, token, owns: (remoteUrl) => parseGitHubRemote(remoteUrl)?.toLowerCase() === job.repo.toLowerCase() },
  });
  try {
    update({ base: checkout.baseRef, headSha: checkout.headSha });
    const previous = reusableLocalReview(stored, checkout.baseRef);
    const baseNotes = [
      ...checkout.baseNotes,
      ...(pr && pr.base.ref !== checkout.baseRef ? [`Open PR #${pr.number} targets ${pr.base.ref}, but this review diffed against ${checkout.baseRef}.`] : []),
    ];
    const about = { baseNotes, baseStale: checkout.baseStale };
    const full = budgetDiff(checkout.diff);
    const branchFiles = full.files.map((f) => f.path);
    const incremental = sinceSha !== undefined && checkout.sinceDiff !== undefined && previous ? { sinceSha, diff: budgetDiff(checkout.sinceDiff) } : undefined;
    const budgeted = incremental?.diff ?? full;
    const changedFiles = budgeted.files.map((f) => f.path);
    const openBefore = previous ? previous.result.findings.filter((f) => f.status !== 'dismissed' && !f.ci) : [];

    if (incremental && !changedFiles.length && previous) {
      // New commits touch none of the branch's own files: the earlier findings carry over.
      const now = Date.now();
      // The findings carry over, but not what was read about the old head: its CI is not this commit's.
      const findings = previous.result.findings.filter((f) => !f.ci);
      save(job, checkout.baseRef, { ...about, pullRequest: previous.pullRequest }, {
        ...previous.result,
        ci: undefined,
        findings,
        counts: countFindings(findings),
        headSha: checkout.headSha,
        startedAt: now,
        finishedAt: now,
        summary: `No branch file changed since the review at ${sinceSha!.slice(0, 7)}; its findings carry over. ${previous.result.summary}`,
        agents: [],
        usage: undefined,
        device: undefined,
        incremental: { sinceSha: sinceSha!, carried: openBefore.length, rechecked: 0 },
      });
      return;
    }

    const standards = await readStandards(checkout.worktree);
    const files = await readChangedFiles(checkout.worktree, changedFiles);
    update({ detail: pr ? 'reading CI checks, the JIRA ticket and the PR discussion' : 'reading the JIRA ticket' });
    const [ticket, ci, discussion] = await Promise.all([
      lookupTicket({ site: project.jiraSite, email: project.jiraEmail, token: tokenStore.getToken(project.id, 'jira'), pr: { title: pr?.title ?? '', body: pr?.body ?? '', branch: job.branch } }).catch((err: unknown) => ({
        ticket: null,
        note: `Could not read JIRA (${err instanceof Error ? err.message : String(err)}).`,
      })),
      // CI ran on what was pushed: the checks of another commit say nothing about this one.
      pr && token && pr.head.sha === checkout.headSha ? fetchCi({ token, repo: job.repo, headSha: checkout.headSha }) : undefined,
      pr && token ? fetchDiscussion({ token, repo: job.repo, number: pr.number }) : undefined,
    ]);
    const dismissals = loadDismissals(job.repo);
    const { wikiBlock, wikiPages } = await wikiContext(project, job.repo, changedFiles);

    const result = await runReview({
      apiKey: cursorKey,
      backend,
      models: { reviewer1: project.models?.reviewer1, reviewer2: project.models?.reviewer2, reviewer3: project.models?.reviewer3, judge: project.models?.judge },
      ctx: {
        repo: job.repo,
        prNumber: pr?.number ?? 0,
        title: pr?.title ?? '',
        body: pr?.body ?? '',
        author: pr?.user?.login ?? checkout.author,
        baseRef: checkout.baseRef,
        headRef: job.branch,
        inventory: fileInventory(budgeted),
        diffNotes: budgeted.notes,
        diff: budgeted.text,
        standards,
        wikiBlock,
        instructions: project.reviewInstructions ?? '',
        ...(incremental ? { sinceSha: incremental.sinceSha } : {}),
        ...(files.length ? { files } : {}),
        ...(ci ? { ciBlock: ciPromptBlock(ci) } : {}),
        ticketBlock: ticketPromptBlock(ticket),
        dismissedBlock: dismissalPromptBlock(dismissals),
        ...(discussion ? { discussionBlock: discussionPromptBlock(discussion) } : {}),
        prTests: [],
      },
      worktree: checkout.worktree,
      headSha: checkout.headSha,
      changedFiles,
      wikiPages,
      onPhase: (phase, detail) => update({ phase, detail }),
      ...(ci ? { ci } : {}),
      ticket,
      dismissals,
      ...(discussion ? { discussion } : {}),
      ...(incremental
        ? { previous: { sinceSha: incremental.sinceSha, recheck: openBefore, carry: [], prFiles: branchFiles } }
        : openBefore.length
          ? { recheck: openBefore }
          : {}),
    });
    const severalPrs = prs.length > 1 ? [`This branch has ${prs.length} open PRs; the review read #${pr.number} only.`] : [];
    save(job, checkout.baseRef, { ...about, baseNotes: [...baseNotes, ...severalPrs], ...(pr ? { pullRequest: pr.number } : {}) }, result);
  } finally {
    await removeLocalCheckout(checkout.worktree);
  }
}

function save(job: LocalSummary, base: string, about: Pick<StoredLocal, 'baseNotes' | 'baseStale' | 'pullRequest'>, result: ReviewResult): void {
  const stored: StoredLocal = { version: LOCAL_REVIEW_VERSION, projectId: job.projectId, repo: job.repo, branch: job.branch, base, ...about, result };
  const file = storedPath(job.projectId, job.repo, job.branch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), 'utf-8');
  Object.assign(job, { status: 'done', phase: undefined, detail: undefined, base, headSha: result.headSha, counts: result.counts, finishedAt: result.finishedAt, lostLenses: result.lostLenses });
}
