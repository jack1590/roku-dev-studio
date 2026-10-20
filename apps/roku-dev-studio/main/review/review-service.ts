/**
 * Runs PR reviews in the main process (the pipeline lives in packages/roku-review; this file is
 * the app glue): a small queue, PR metadata from GitHub, checkout, repo standards, wiki context,
 * the run itself, saved results, and live status pushed to every window.
 *
 * Tokens stay here: the GitHub token is used for API calls and git, the Cursor key only inside
 * the agent runner. Device passwords are verified and stored here and never reach an agent.
 * Results live in `<userData>/review/results/<projectId>/<owner>__<repo>__<n>.json`.
 */

import type { App, IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/ipc/channels';
import { containsSecret, defaultCompanyTag } from '../../shared/project-config';
import { addCost, EMPTY_COST, ciPromptBlock, discussionPromptBlock, fetchDiscussion, dismissalPromptBlock, fetchCi, lookupTicket, ticketPromptBlock, readChangedFiles, TEST_FILE, budgetDiff, fileInventory, prepareCheckout, readStandards, readWiki, renderWikiPromptBlock, runDeviceVerification, runReview, selectWikiContext, type DeviceReport, type ReviewResult } from 'roku-dev-studio-review';
import { REVIEW_LIMITS } from '../../shared/project-config';
import { getProjectRecord, resolveHomePath } from '../ipc/project-handlers';
import * as tokenStore from '../project-token-store';
import { connectedDevices } from '../mcp-bridge';
import { isRelaySelfDevice } from '../sideload-relay/fake-device-info';
import { setupPostingHandlers } from './review-posting';
import { loadDismissals, setupDismissalHandlers } from './review-dismissals';
import { busyLabel, tryClaim } from '../../shared/device-claims';
import { shellPath } from '../packager/cli';

const fs = require('fs');
const path = require('path');
const { mainLog, mainWarn } = require('../log');
const secretStore = require('../secret-store') as typeof import('../secret-store');

const MAX_PARALLEL = 2;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ReviewDevice {
  key: string;
  ip: string;
  name: string;
}

/** What the PR list needs per PR. */
export interface ReviewSummary {
  projectId: string;
  repo: string;
  number: number;
  status: JobStatus;
  phase?: string;
  detail?: string;
  error?: string;
  headSha?: string;
  counts?: ReviewResult['counts'];
  deviceRecommended?: boolean;
  finishedAt?: number;
  device?: ReviewDevice;
  /** Lenses (or the judge) that failed: the review is incomplete. */
  lostLenses?: string[];
  /** Why a needed device check did not run ('no device' when none was reachable or set up). */
  deviceSkipped?: string;
  /** Comments the review drafted for GitHub, and how many of them are posted. */
  posting?: { posted: number; postable: number };
}

export interface StoredReview {
  version: 1;
  projectId: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  device?: ReviewDevice;
  result: ReviewResult;
}

interface Job extends ReviewSummary {
  controller: AbortController;
}

interface PoolDevice extends ReviewDevice {
  model?: string;
}

let dataDir = '';
const jobs = new Map<string, Job>();
/**
 * Test device pool, shared by every project (devices are physical). A device run takes any free
 * pool device that has a saved password, so N devices give N device runs in parallel.
 * ponytail: only review runs mark a device busy; a person using it by hand is not detected.
 */
let pool: PoolDevice[] = [];
const busy = new Map<string, string>(); // device key -> job key
const waitingForDevice: string[] = []; // job keys, first come first served
let poolWaiters: (() => void)[] = [];
const queue: string[] = [];
let running = 0;

const jobKey = (projectId: string, repo: string, number: number) => `${projectId}|${repo}#${number}`;

/** Where reviews keep clones, worktrees and results (under the app's userData). */
export function reviewDataDir(): string {
  return dataDir;
}
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

const poolPath = () => path.join(dataDir, 'devices.json');

function loadPool(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(poolPath(), 'utf-8')) as { devices?: unknown };
    pool = parsePool(parsed.devices);
  } catch {
    pool = [];
  }
}

function savePool(): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(poolPath(), JSON.stringify({ devices: pool }, null, 2), 'utf-8');
  wakePool();
}

function parsePool(raw: unknown): PoolDevice[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, PoolDevice>();
  for (const d of raw.slice(0, 20) as Partial<PoolDevice>[]) {
    const key = typeof d?.key === 'string' ? d.key.trim().slice(0, 100) : '';
    const ip = typeof d?.ip === 'string' ? d.ip.trim() : '';
    if (!key || !IPV4.test(ip)) continue;
    out.set(key, { key, ip, name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 100) : ip, model: typeof d.model === 'string' ? d.model.slice(0, 60) : '' });
  }
  return [...out.values()];
}

/** Last reachability check per pool device (ECP ping). */
const reachability = new Map<string, { online: boolean; at: number; lastSeen?: number }>();

/** Is the Roku answering on ECP? A quick check, cached for a few seconds. */
async function isOnline(d: PoolDevice, maxAgeMs = 10_000): Promise<boolean> {
  const known = reachability.get(d.key);
  if (known && Date.now() - known.at < maxAgeMs) return known.online;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  let online = false;
  try {
    const res = await fetch(`http://${d.ip}:8060/query/device-info`, { signal: controller.signal });
    online = res.ok;
  } catch {
    online = false;
  } finally {
    clearTimeout(timer);
  }
  reachability.set(d.key, { online, at: Date.now(), lastSeen: online ? Date.now() : known?.lastSeen });
  return online;
}

/** Let every waiting device run look at the pool again (a device freed, the pool or a password changed). */
function wakePool(): void {
  const waiters = poolWaiters;
  poolWaiters = [];
  for (const wake of waiters) wake();
}

/**
 * Take a free pool device that has a saved password, waiting in line while all are busy.
 * Null when no pool device can ever serve (none, or none with a password).
 */
async function acquireDevice(job: Job): Promise<{ device: PoolDevice; password: string } | null | 'cancelled' | { offline: string[] }> {
  const key = jobKey(job.projectId, job.repo, job.number);
  const signal = job.controller.signal;
  waitingForDevice.push(key);
  try {
    for (;;) {
      if (signal.aborted) return 'cancelled';
      const passwords = secretStore.getAllPasswords();
      const withPassword = pool.filter((d) => passwords[d.key]);
      if (!withPassword.length) return null;
      // Only devices that answer now. Busy ones are in use by a review, so they count as reachable.
      const online = await Promise.all(withPassword.map(async (d) => (busy.has(d.key) ? true : isOnline(d, 5_000))));
      const usable = withPassword.filter((_, i) => online[i]);
      // Nothing reachable: waiting would not help, so the device check is skipped.
      if (!usable.length) return { offline: withPassword.map((d) => d.name) };
      const free = usable.filter((d) => !busy.has(d.key));
      const ahead = waitingForDevice.indexOf(key);
      if (free.length > ahead) {
        const device = free[ahead];
        busy.set(device.key, key);
        return { device, password: passwords[device.key] };
      }
      update(job, { phase: 'waiting-device', detail: ahead > 0 ? `waiting for a free test device (${ahead} ahead)` : `all ${usable.length} test device(s) busy, next in line` });
      await new Promise<void>((resolve) => {
        poolWaiters.push(resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  } finally {
    waitingForDevice.splice(waitingForDevice.indexOf(key), 1);
  }
}

function releaseDevice(deviceKey: string): void {
  busy.delete(deviceKey);
  wakePool();
}

/** Who holds a device, for pickers: "owner/repo#n" for a review, "Packaging <name>" for a package run. */
function holderLabel(holder: string | undefined): string | undefined {
  if (!holder) return undefined;
  const job = jobs.get(holder);
  return job ? `${job.repo}#${job.number}` : busyLabel(holder);
}

/** Packager: take a specific pool device. Fails instead of queueing; the person picked this device. */
export function claimPoolDevice(key: string, holder: string): { ok: true; ip: string; name: string; password: string } | { ok: false; error: string } {
  const device = pool.find((d) => d.key === key);
  if (!device) return { ok: false, error: 'That device is no longer in the device pool.' };
  const password = secretStore.getAllPasswords()[key];
  if (!password) return { ok: false, error: `No dev password saved for ${device.name}. Set it in PR Reviews → Test devices.` };
  const holderNow = busy.get(key);
  if (!tryClaim(busy, key, holder)) return { ok: false, error: `${device.name} is busy (${holderLabel(holderNow) ?? 'in use'}).` };
  return { ok: true, ip: device.ip, name: device.name, password };
}

export function releasePoolDevice(key: string): void {
  releaseDevice(key);
}

/** Same view as the PR Reviews device picker; passwords never leave main. */
export async function listPoolDevices(): Promise<{ key: string; ip: string; name: string; model?: string; online: boolean; hasPassword: boolean; busyWith?: string }[]> {
  const passwords = secretStore.getAllPasswords();
  const online = await Promise.all(pool.map((d) => (busy.has(d.key) ? Promise.resolve(true) : isOnline(d))));
  return pool.map((d, i) => ({ key: d.key, ip: d.ip, name: d.name, model: d.model, online: online[i], hasPassword: !!passwords[d.key], busyWith: holderLabel(busy.get(d.key)) }));
}

export function resultPath(projectId: string, repo: string, number: number): string {
  return path.join(dataDir, 'results', projectId.replace(/[^a-z0-9-]/gi, '_'), `${repo.replace('/', '__')}__${number}.json`);
}

function shotsDir(projectId: string, repo: string, number: number): string {
  return resultPath(projectId, repo, number).replace(/\.json$/, '__shots');
}

export function readStored(projectId: string, repo: string, number: number): StoredReview | null {
  try {
    return JSON.parse(fs.readFileSync(resultPath(projectId, repo, number), 'utf-8')) as StoredReview;
  } catch {
    return null;
  }
}

/** Postable comments (verified issues and device checks with text) and how many reached GitHub. */
function postingCounts(stored: { projectId: string; repo: string; number: number; result: ReviewResult }): { posted: number; postable: number } {
  let posted: Record<string, unknown> = {};
  try {
    posted = (JSON.parse(fs.readFileSync(resultPath(stored.projectId, stored.repo, stored.number).replace(/\.json$/, '__posting.json'), 'utf-8')) as { posted?: Record<string, unknown> }).posted ?? {};
  } catch {
    // Nothing posted yet.
  }
  const ids = stored.result.findings.filter((f) => (f.status === 'issue' || f.status === 'needs-device') && f.comment).map((f) => f.postId ?? f.id);
  return { posted: ids.filter((id) => id in posted).length, postable: ids.length };
}

function summaryOfStored(stored: StoredReview): ReviewSummary {
  return {
    projectId: stored.projectId,
    repo: stored.repo,
    number: stored.number,
    status: 'done',
    headSha: stored.result.headSha,
    counts: stored.result.counts,
    deviceRecommended: stored.result.deviceRecommended,
    finishedAt: stored.result.finishedAt,
    device: stored.device,
    lostLenses: stored.result.lostLenses,
    deviceSkipped: skippedReason(stored.result),
    posting: postingCounts(stored),
  };
}

function skippedReason(result: ReviewResult): string | undefined {
  const d = result.device;
  if (!d || d.status !== 'blocked') return undefined;
  return /reachable|offline|no test devices|dev password/i.test(d.reason ?? '') ? 'no device' : 'not set up';
}

function publicSummary(job: Job): ReviewSummary {
  const { controller: _controller, ...summary } = job;
  return summary;
}

function broadcast(summary: ReviewSummary): void {
  const { BrowserWindow } = require('electron') as typeof import('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.ReviewsUpdate, summary);
  }
}

function update(job: Job, patch: Partial<ReviewSummary>): void {
  Object.assign(job, patch);
  broadcast(publicSummary(job));
}

async function githubJson<T>(token: string, url: string): Promise<T> {
  // The token is only used in this header. It is not logged and not returned.
  const res = await fetch(`https://api.github.com${url}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(res.status === 404 ? 'PR not found, or the token cannot see it.' : `GitHub returned HTTP ${res.status}.`);
  return (await res.json()) as T;
}

/** Terms from the changed paths for wiki matching: file names and folder names. */
function keywordsFromFiles(files: string[]): string[] {
  const words = new Set<string>();
  for (const file of files) {
    for (const part of file.split('/')) {
      const base = part.replace(/\.[^.]+$/, '');
      if (base) words.add(base);
    }
  }
  return [...words];
}

async function execute(job: Job): Promise<void> {
  const signal = job.controller.signal;
  const project = getProjectRecord(job.projectId);
  if (!project) throw new Error('Project not found.');
  const githubToken = tokenStore.getToken(project.id, 'github');
  const cursorKey = tokenStore.getToken(project.id, 'cursor');
  if (!githubToken) throw new Error('Save a GitHub token for this project first.');
  if (!cursorKey) throw new Error('Save a Cursor API key for this project first.');

  update(job, { phase: 'preparing', detail: 'reading the PR from GitHub' });
  const pr = await githubJson<{ title: string; body: string | null; html_url: string; user: { login: string } | null; base: { ref: string }; head: { ref: string; sha: string } }>(githubToken, `/repos/${job.repo}/pulls/${job.number}`);

  update(job, { phase: 'preparing', detail: 'checking out the code' });
  // Re-review only what changed: needs a complete previous review and its head still in the PR's history.
  const previous = readStored(job.projectId, job.repo, job.number);
  const sinceSha = project.incrementalReview !== false && previous && !previous.result.lostLenses?.length ? previous.result.headSha : undefined;
  const checkout = await prepareCheckout({ repo: job.repo, prNumber: job.number, baseRef: pr.base.ref, token: githubToken, dataDir, signal, sinceSha });
  const full = budgetDiff(checkout.diff);
  const prFiles = full.files.map((f) => f.path);
  const incremental = sinceSha !== undefined && checkout.sinceDiff !== undefined && previous ? { sinceSha, diff: budgetDiff(checkout.sinceDiff) } : undefined;
  const budgeted = incremental?.diff ?? full;
  const changedFiles = budgeted.files.map((f) => f.path);
  const openBefore = previous ? previous.result.findings.filter((f) => f.status !== 'dismissed' && !f.ci) : [];

  if (incremental && !changedFiles.length && previous) {
    // New commits but none touch the PR's own files (e.g. a merge of the base branch): nothing new to review.
    const now = Date.now();
    const result: ReviewResult = {
      ...previous.result,
      headSha: checkout.headSha,
      startedAt: now,
      finishedAt: now,
      summary: `No PR file changed since the review at ${sinceSha!.slice(0, 7)}; its findings carry over. ${previous.result.summary}`,
      agents: [],
      usage: undefined,
      device: undefined,
      incremental: { sinceSha: sinceSha!, carried: openBefore.length, rechecked: 0 },
    };
    saveResult(job, pr, result);
    return;
  }

  const standards = await readStandards(checkout.worktree);
  const files = await readChangedFiles(checkout.worktree, changedFiles);
  update(job, { phase: 'preparing', detail: 'reading CI checks, the JIRA ticket and the PR discussion' });
  const [ci, ticket, discussion] = await Promise.all([
    fetchCi({ token: githubToken, repo: job.repo, headSha: checkout.headSha, signal }),
    lookupTicket({ site: project.jiraSite, email: project.jiraEmail, token: tokenStore.getToken(project.id, 'jira'), pr: { title: pr.title, body: pr.body ?? '', branch: pr.head.ref }, signal }).catch((err: unknown) => ({ ticket: null, note: `Could not read JIRA (${err instanceof Error ? err.message : String(err)}).` })),
    fetchDiscussion({ token: githubToken, repo: job.repo, number: job.number, signal }),
  ]);
  // The only tests a device check may run: test files this PR adds or changes (never new ones).
  const prTests = prFiles.filter((f) => TEST_FILE.test(f));
  const dismissals = loadDismissals(job.repo);

  const { wikiBlock, wikiPages } = await wikiContext(project, job.repo, changedFiles);

  const ctxFor = (diff: typeof full, since?: string) => ({
    repo: job.repo,
    prNumber: job.number,
    title: pr.title,
    body: pr.body ?? '',
    author: pr.user?.login ?? 'unknown',
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    inventory: fileInventory(diff),
    diffNotes: diff.notes,
    diff: diff.text,
    standards,
    wikiBlock,
    instructions: project.reviewInstructions ?? '',
    ...(since ? { sinceSha: since } : {}),
    ...(files.length ? { files } : {}),
    ciBlock: ciPromptBlock(ci),
    ticketBlock: ticketPromptBlock(ticket),
    dismissedBlock: dismissalPromptBlock(dismissals),
    discussionBlock: discussionPromptBlock(discussion),
    prTests,
  });

  const result = await runReview({
    apiKey: cursorKey,
    models: { reviewer1: project.models?.reviewer1, reviewer2: project.models?.reviewer2, reviewer3: project.models?.reviewer3, judge: project.models?.judge },
    ctx: ctxFor(budgeted, incremental?.sinceSha),
    worktree: checkout.worktree,
    headSha: checkout.headSha,
    changedFiles,
    wikiPages,
    signal,
    onPhase: (phase, detail) => update(job, { phase, detail }),
    ci,
    ticket,
    dismissals,
    discussion,
    ...(incremental
      ? {
          previous: {
            sinceSha: incremental.sinceSha,
            // Every open finding is re-checked: a finding's anchor file can stay untouched while what it
            // is about (another file, a doc, a reply on GitHub) changed, so nothing is carried unseen.
            recheck: openBefore,
            carry: [],
            prFiles,
          },
        }
      : // Full re-review: the judge re-checks what the last review left open, so a real finding the reviewers miss this time is not lost.
        openBefore.length
        ? { recheck: openBefore }
        : {}),
  });

  // Device time only when a finding needs proof and a test of this PR exercises it.
  const needsDevice = result.findings.some((f) => f.status === 'needs-device' && f.tests?.length);
  if (needsDevice) {
    // The device planner sees the whole PR, since carried findings may sit outside the new commits.
    result.device = await deviceStep(job, project, checkout.worktree, result, ctxFor(full), cursorKey);
    result.usage = addCost(result.usage ?? EMPTY_COST, result.device.usage);
  }

  saveResult(job, pr, result);
}

function saveResult(job: Job, pr: { title: string; html_url: string }, result: ReviewResult): void {
  const stored: StoredReview = { version: 1, projectId: job.projectId, repo: job.repo, number: job.number, title: pr.title, url: pr.html_url, device: job.device, result };
  const file = resultPath(job.projectId, job.repo, job.number);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), 'utf-8');
  update(job, { status: 'done', phase: undefined, detail: undefined, headSha: result.headSha, counts: result.counts, deviceRecommended: result.deviceRecommended, finishedAt: result.finishedAt, lostLenses: result.lostLenses, deviceSkipped: skippedReason(result), posting: postingCounts({ projectId: job.projectId, repo: job.repo, number: job.number, result }) });
}

export type Project = NonNullable<ReturnType<typeof getProjectRecord>>;

/** Team knowledge from the LLM Wiki for this repo and these files (empty when the wiki is off or missing). */
export async function wikiContext(project: Project, repo: string, changedFiles: string[]): Promise<{ wikiBlock: string; wikiPages: string[] }> {
  if (project.wikiEnabled === false) return { wikiBlock: '', wikiPages: [] };
  const dir = resolveHomePath(project.wikiDir || '~/wiki');
  if (!fs.existsSync(dir)) return { wikiBlock: '', wikiPages: [] };
  const selection = selectWikiContext(await readWiki(dir), {
    repo,
    companyTag: project.wikiCompanyTag || defaultCompanyTag(project.name),
    tags: project.wikiTags ?? [],
    keywords: keywordsFromFiles(changedFiles),
    exclude: containsSecret,
  });
  return { wikiBlock: renderWikiPromptBlock(selection), wikiPages: selection.excerpts.map((e) => e.slug) };
}

/** Run (or explain why not) the device verification on a free pool device. Mutates result findings/counts. */
async function deviceStep(job: Job, project: Project, worktree: string, result: ReviewResult, ctx: Parameters<typeof runDeviceVerification>[0]['ctx'], cursorKey: string): Promise<DeviceReport> {
  const blocked = (reason: string): DeviceReport => ({ status: 'blocked', reason, rounds: [] });
  const build = project.builds?.[job.repo];
  if (!build?.approvedAt || !build.testCommand) return blocked(`The test build for ${job.repo} is not set up yet. Open Settings → Projects → Device testing, approve its test build, then re-review.`);
  let envFiles: Record<string, Record<string, string>> = {};
  try {
    const raw = tokenStore.getSecret(project.id, `buildenv:${job.repo}`);
    if (raw) envFiles = JSON.parse(raw) as Record<string, Record<string, string>>;
  } catch {
    return blocked('The saved build env could not be read. Paste it again in Settings → Projects → Device builds.');
  }

  const taken = await acquireDevice(job);
  if (taken === 'cancelled') return { status: 'cancelled', rounds: [] };
  if (!taken) {
    return blocked(pool.length ? 'Device check skipped: none of the test devices has a saved dev password. Set one in PR Reviews → Test devices, then re-review.' : 'Device check skipped: no test devices yet. Add one in PR Reviews → Test devices, then re-review.');
  }
  if ('offline' in taken) {
    return blocked(`Device check skipped: no test device reachable (${taken.offline.join(', ')} ${taken.offline.length === 1 ? 'is' : 'are'} offline). Turn it on and re-review.`);
  }
  const { device, password } = taken;
  try {
    update(job, { device: { key: device.key, ip: device.ip, name: device.name }, phase: 'device', detail: `running PR tests on ${device.name}` });
    const minutes = project.deviceMinutes ?? REVIEW_LIMITS.deviceMinutes.default;
    const { report, findings } = await runDeviceVerification({
      apiKey: cursorKey,
      judgeModel: project.models?.judge ?? '',
      ctx,
      worktree,
      repo: job.repo,
      prNumber: job.number,
      test: { command: build.testCommand, outDir: build.testOutDir ?? '', install: build.install, root: build.rootDir ?? '' },
      envFiles,
      device: { name: device.name, ip: device.ip, password },
      dataDir,
      shellPath: await shellPath(),
      findings: result.findings,
      deadline: Date.now() + minutes * 60_000,
      signal: job.controller.signal,
      onProgress: (detail) => update(job, { phase: 'device', detail }),
    });
    result.findings = findings;
    result.counts = { issue: 0, 'needs-device': 0, noted: 0, dismissed: 0 };
    for (const f of findings) result.counts[f.status]++;
    return report;
  } finally {
    releaseDevice(device.key);
  }
}

function pump(): void {
  while (running < MAX_PARALLEL && queue.length) {
    const key = queue.shift()!;
    const job = jobs.get(key);
    if (!job || job.status !== 'queued') continue;
    running++;
    update(job, { status: 'running', phase: 'preparing', detail: 'starting' });
    mainLog(`[reviews] start ${job.repo}#${job.number}`);
    execute(job)
      .catch((err: unknown) => {
        const cancelled = job.controller.signal.aborted;
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) mainWarn(`[reviews] failed ${job.repo}#${job.number}: ${message}`);
        update(job, { status: cancelled ? 'cancelled' : 'failed', phase: undefined, detail: undefined, error: cancelled ? undefined : message });
      })
      .finally(() => {
        running--;
        pump();
      });
  }
}

/** Queue a PR review (or return the one already queued or running). Used by the PR list and the MCP bridge. */
export function startReview(projectId: string, repo: string, number: number): { success: true; summary: ReviewSummary } | { success: false; error: string } {
  if (!getProjectRecord(projectId) || !REPO_PATTERN.test(repo) || !Number.isInteger(number) || number <= 0) return { success: false, error: 'Invalid review request.' };
  const key = jobKey(projectId, repo, number);
  const existing = jobs.get(key);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) return { success: true, summary: publicSummary(existing) };
  const job: Job = { projectId, repo, number, status: 'queued', controller: new AbortController() };
  jobs.set(key, job);
  queue.push(key);
  broadcast(publicSummary(job));
  pump();
  return { success: true, summary: publicSummary(job) };
}

/** A PR review's state: the live job while it is not done, else the saved result's summary. */
export function getReviewSummary(projectId: string, repo: string, number: number): ReviewSummary | null {
  const job = jobs.get(jobKey(projectId, repo, number));
  if (job && job.status !== 'done') return publicSummary(job);
  const stored = readStored(projectId, repo, number);
  return stored ? summaryOfStored(stored) : null;
}

/** Every saved or in-flight PR review of a project. */
export function listReviews(projectId: string): ReviewSummary[] {
  const out = new Map<string, ReviewSummary>();
  const dir = path.join(dataDir, 'results', projectId.replace(/[^a-z0-9-]/gi, '_'));
  try {
    for (const name of fs.readdirSync(dir) as string[]) {
      if (!name.endsWith('.json')) continue;
      try {
        const stored = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as StoredReview;
        out.set(`${stored.repo}#${stored.number}`, summaryOfStored(stored));
      } catch {
        // Skip a damaged result file.
      }
    }
  } catch {
    // No reviews yet for this project.
  }
  for (const job of jobs.values()) {
    if (job.projectId !== projectId) continue;
    // A finished in-memory job has already been written to disk; a failed or running one wins.
    if (job.status !== 'done') out.set(`${job.repo}#${job.number}`, publicSummary(job));
  }
  return [...out.values()];
}

function setupReviewHandlers(app: App): void {
  const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron');
  dataDir = path.join(app.getPath('userData'), 'review');
  loadPool();
  setupPostingHandlers({ resultPath, readStored });
  setupDismissalHandlers({ dataDir, resultPath, readStored, onSaved: (stored) => broadcast(summaryOfStored(stored as StoredReview)) });
  const { verifyDeveloperDigestAuth } = require('roku-dev-studio-api') as { verifyDeveloperDigestAuth: (o: { ip: string; password: string }) => Promise<{ success: boolean; error?: string }> };

  ipcMain.handle(IPC.ReviewsStart, async (_event: IpcMainInvokeEvent, payload?: { projectId?: unknown; repo?: unknown; number?: unknown }) =>
    startReview(typeof payload?.projectId === 'string' ? payload.projectId : '', typeof payload?.repo === 'string' ? payload.repo : '', typeof payload?.number === 'number' ? payload.number : NaN),
  );

  ipcMain.handle(IPC.ReviewsCancel, async (_event: IpcMainInvokeEvent, payload?: { projectId?: unknown; repo?: unknown; number?: unknown }) => {
    const job = jobs.get(jobKey(String(payload?.projectId), String(payload?.repo), Number(payload?.number)));
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return { success: false, error: 'No review in progress.' };
    job.controller.abort();
    if (job.status === 'queued') update(job, { status: 'cancelled' });
    return { success: true };
  });

  ipcMain.handle(IPC.ReviewsList, async (_event: IpcMainInvokeEvent, payload?: { projectId?: unknown }) => ({
    success: true,
    reviews: listReviews(typeof payload?.projectId === 'string' ? payload.projectId : ''),
  }));

  ipcMain.handle(IPC.ReviewsGet, async (_event: IpcMainInvokeEvent, payload?: { projectId?: unknown; repo?: unknown; number?: unknown }) => {
    const stored = readStored(String(payload?.projectId), String(payload?.repo), Number(payload?.number));
    return stored ? { success: true, review: stored } : { success: false, error: 'No saved review for this PR yet.' };
  });

  ipcMain.handle(IPC.ReviewsScreenshot, async (_event: IpcMainInvokeEvent, payload?: { projectId?: unknown; repo?: unknown; number?: unknown; name?: unknown }) => {
    const name = typeof payload?.name === 'string' ? payload.name : '';
    if (!/^[A-Za-z0-9_.-]+\.png$/.test(name)) return { success: false, error: 'Invalid screenshot name.' };
    try {
      const file = path.join(shotsDir(String(payload?.projectId), String(payload?.repo), Number(payload?.number)), name);
      return { success: true, dataUrl: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` };
    } catch {
      return { success: false, error: 'Screenshot not found.' };
    }
  });

  /** The pool with live state: password saved or not, and which review holds a device. */
  ipcMain.handle(IPC.ReviewsDevices, async () => {
    const passwords = secretStore.getAllPasswords();
    const online = await Promise.all(pool.map((d) => (busy.has(d.key) ? Promise.resolve(true) : isOnline(d))));
    const devices = pool.map((d, i) => ({ ...d, hasPassword: !!passwords[d.key], busyWith: holderLabel(busy.get(d.key)), online: online[i], lastSeen: reachability.get(d.key)?.lastSeen }));
    return { success: true, devices, waiting: waitingForDevice.length };
  });

  // Same discovery as the sidebar scan (SSDP plus subnet sweep), plus devices open in tabs.
  ipcMain.handle(IPC.ReviewsDiscover, async () => {
    const { ssdpDiscover, subnetScan } = require('roku-dev-studio-api') as { ssdpDiscover: (o: object) => Promise<unknown[]>; subnetScan: (o: object) => Promise<unknown[]> };
    const found = new Map<string, PoolDevice>();
    const add = (raw: unknown) => {
      const d = raw as { ip?: unknown; serialNumber?: unknown; deviceName?: unknown; modelName?: unknown };
      if (typeof d?.ip !== 'string' || !IPV4.test(d.ip) || isRelaySelfDevice(d)) return;
      const key = String(d.serialNumber || d.ip).trim();
      const model = typeof d.modelName === 'string' ? d.modelName : '';
      found.set(key, { key, ip: d.ip, name: (typeof d.deviceName === 'string' && d.deviceName !== 'Unknown Roku' && d.deviceName) || model || d.ip, model });
    };
    for (const d of connectedDevices()) add({ ip: d.ip, serialNumber: d.serial, deviceName: d.friendlyDeviceName, modelName: d.modelName });
    const scans = await Promise.allSettled([ssdpDiscover({ log: () => undefined }), subnetScan({ log: () => undefined })]);
    for (const scan of scans) if (scan.status === 'fulfilled' && Array.isArray(scan.value)) scan.value.forEach(add);
    // A pool device that moved to a new IP (DHCP) follows it.
    let moved = false;
    for (const d of pool) {
      const seen = found.get(d.key);
      if (seen && seen.ip !== d.ip) {
        d.ip = seen.ip;
        moved = true;
      }
    }
    if (moved) savePool();
    const passwords = secretStore.getAllPasswords();
    const devices = [...found.values()].map((d) => ({ ...d, hasPassword: !!passwords[d.key] }));
    return { success: true, devices };
  });

  ipcMain.handle(IPC.ReviewsSetPool, async (_event: IpcMainInvokeEvent, payload?: { devices?: unknown }) => {
    pool = parsePool(payload?.devices);
    savePool();
    return { success: true };
  });

  ipcMain.handle(IPC.ReviewsSetDevicePassword, async (_event: IpcMainInvokeEvent, payload?: { key?: unknown; ip?: unknown; password?: unknown }) => {
    const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
    const ip = typeof payload?.ip === 'string' ? payload.ip.trim() : '';
    const password = typeof payload?.password === 'string' ? payload.password : '';
    if (!key || !ip || !password) return { success: false, error: 'Device and password are required.' };
    try {
      const check = await verifyDeveloperDigestAuth({ ip, password });
      if (!check.success) return { success: false, error: check.error || 'The device rejected that password.' };
      secretStore.setPassword(key, password);
      wakePool();
      // Same notification the Sideload Relay sends, so Dev App and sideloading pick it up too.
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.SecretsPasswordUpdated, { serial: key, password });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export { setupReviewHandlers };
