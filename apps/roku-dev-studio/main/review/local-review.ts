/**
 * Reviews of a local branch before it is a PR, started by an agent through the MCP bridge.
 *
 * - Committed work only: the review reads a copy at HEAD (see `prepareLocalCheckout`), never the
 *   user's folder, so uncommitted edits stay out.
 * - Same pipeline as a PR review, minus what needs a PR: no CI, no PR discussion, no device step.
 *   JIRA comes from the branch name only.
 * - Kept per branch, apart from PR reviews (not in the PR list, never posted). A second review of
 *   the same branch re-checks the open findings and reviews only the new commits, like a PR re-review.
 */

import { budgetDiff, dismissalPromptBlock, fileInventory, lookupTicket, prepareLocalCheckout, readChangedFiles, readStandards, removeLocalCheckout, runReview, ticketPromptBlock, type ReviewResult } from 'roku-dev-studio-review';
import { encodeJobId, parseGitHubRemote, resolveProject } from '../../shared/review-mcp';
import { getProjectRecord, listProjectRecords } from '../ipc/project-handlers';
import * as tokenStore from '../project-token-store';
import { loadDismissals } from './review-dismissals';
import { reviewDataDir, wikiContext, type JobStatus } from './review-service';

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
  version: 1;
  projectId: string;
  repo: string;
  branch: string;
  base: string;
  result: ReviewResult;
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
export function getLocalReview(projectId: string, repo: string, branch: string): { summary: LocalSummary; result?: ReviewResult; base?: string } | null {
  const jobId = encodeJobId({ kind: 'local', projectId, repo, branch });
  const job = jobs.get(jobId);
  if (job && job.status !== 'done') return { summary: { ...job } };
  const stored = readStoredLocal(projectId, repo, branch);
  if (!stored) return null;
  const r = stored.result;
  return { summary: { jobId, projectId, repo, branch, base: stored.base, status: 'done', headSha: r.headSha, counts: r.counts, finishedAt: r.finishedAt, lostLenses: r.lostLenses }, result: r, base: stored.base };
}

async function executeLocal(job: LocalSummary, checkoutPath: string, base?: string): Promise<void> {
  const update = (patch: Partial<LocalSummary>) => Object.assign(job, patch);
  const project = getProjectRecord(job.projectId);
  if (!project) throw new Error('Project not found.');
  const cursorKey = tokenStore.getToken(project.id, 'cursor');
  if (!cursorKey) throw new Error('Save a Cursor API key for this project first.');

  update({ detail: 'checking out the committed work' });
  const previous = readStoredLocal(job.projectId, job.repo, job.branch);
  const sinceSha = project.incrementalReview !== false && previous && !previous.result.lostLenses?.length ? previous.result.headSha : undefined;
  const checkout = await prepareLocalCheckout({ path: checkoutPath, base, dataDir: reviewDataDir(), sinceSha });
  try {
    update({ base: checkout.baseRef, headSha: checkout.headSha });
    const full = budgetDiff(checkout.diff);
    const branchFiles = full.files.map((f) => f.path);
    const incremental = sinceSha !== undefined && checkout.sinceDiff !== undefined && previous ? { sinceSha, diff: budgetDiff(checkout.sinceDiff) } : undefined;
    const budgeted = incremental?.diff ?? full;
    const changedFiles = budgeted.files.map((f) => f.path);
    const openBefore = previous ? previous.result.findings.filter((f) => f.status !== 'dismissed' && !f.ci) : [];

    if (incremental && !changedFiles.length && previous) {
      // New commits touch none of the branch's own files: the earlier findings carry over.
      const now = Date.now();
      save(job, checkout.baseRef, {
        ...previous.result,
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
    update({ detail: 'reading the JIRA ticket' });
    const ticket = await lookupTicket({ site: project.jiraSite, email: project.jiraEmail, token: tokenStore.getToken(project.id, 'jira'), pr: { title: '', body: '', branch: job.branch } }).catch((err: unknown) => ({
      ticket: null,
      note: `Could not read JIRA (${err instanceof Error ? err.message : String(err)}).`,
    }));
    const dismissals = loadDismissals(job.repo);
    const { wikiBlock, wikiPages } = await wikiContext(project, job.repo, changedFiles);

    const result = await runReview({
      apiKey: cursorKey,
      models: { reviewer1: project.models?.reviewer1, reviewer2: project.models?.reviewer2, reviewer3: project.models?.reviewer3, judge: project.models?.judge },
      ctx: {
        repo: job.repo,
        prNumber: 0,
        title: '',
        body: '',
        author: checkout.author,
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
        ticketBlock: ticketPromptBlock(ticket),
        dismissedBlock: dismissalPromptBlock(dismissals),
        prTests: [],
      },
      worktree: checkout.worktree,
      headSha: checkout.headSha,
      changedFiles,
      wikiPages,
      onPhase: (phase, detail) => update({ phase, detail }),
      ticket,
      dismissals,
      ...(incremental
        ? { previous: { sinceSha: incremental.sinceSha, recheck: openBefore, carry: [], prFiles: branchFiles } }
        : openBefore.length
          ? { recheck: openBefore }
          : {}),
    });
    save(job, checkout.baseRef, result);
  } finally {
    await removeLocalCheckout(checkout.worktree);
  }
}

function save(job: LocalSummary, base: string, result: ReviewResult): void {
  const stored: StoredLocal = { version: 1, projectId: job.projectId, repo: job.repo, branch: job.branch, base, result };
  const file = storedPath(job.projectId, job.repo, job.branch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), 'utf-8');
  Object.assign(job, { status: 'done', phase: undefined, detail: undefined, base, headSha: result.headSha, counts: result.counts, finishedAt: result.finishedAt, lostLenses: result.lostLenses });
}
