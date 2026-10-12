/**
 * Checks out a PR for review: one shared blobless clone per repo, one worktree per PR.
 *
 * The GitHub token reaches git only through environment config for the duration of each command
 * (GIT_CONFIG_COUNT/KEY/VALUE), so it is never written to `.git/config`, never part of a URL, and
 * never on the command line. Git runs without a shell, and every ref and path is validated first.
 */

import { execFile } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

export interface Checkout {
  worktree: string;
  headSha: string;
  baseRef: string;
  /** `git diff merge-base..head`, i.e. exactly what the PR changes. */
  diff: string;
  /** Only the commits since the previous review, when that head is still in the PR's history. */
  sinceDiff?: string;
}

/** Folder in the worktree for review files agents may read (the full PR diff). Never built or committed. */
export const REVIEW_DIR = '.rds-review';

/** Serialises git work per repo: clones and worktrees share one object store. */
const repoLocks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repo) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  repoLocks.set(repo, next);
  return next;
}

function git(args: string[], opts: { cwd?: string; token: string; signal?: AbortSignal }): Promise<string> {
  const auth = Buffer.from(`x-access-token:${opts.token}`).toString('base64');
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
  };
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd, env, signal: opts.signal, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Never echo the env; stderr from git does not contain the header.
        const message = String(stderr || err.message).trim().split('\n').slice(-3).join(' ');
        reject(new Error(`git ${args[0]} failed: ${message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function slug(repo: string): string {
  return repo.replace('/', '__');
}

export async function prepareCheckout(input: {
  repo: string;
  prNumber: number;
  baseRef: string;
  token: string;
  dataDir: string;
  signal?: AbortSignal;
  /** Head of the previous review: when it is still in the PR's history, also return the diff of only the new commits. */
  sinceSha?: string;
}): Promise<Checkout> {
  const { repo, prNumber, baseRef, token, dataDir, signal, sinceSha } = input;
  if (!REPO_PATTERN.test(repo)) throw new Error('Invalid repo name.');
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error('Invalid PR number.');
  if (!REF_PATTERN.test(baseRef) || baseRef.startsWith('-') || baseRef.includes('..')) throw new Error('Invalid base branch name.');

  const repoDir = path.join(dataDir, 'repos', slug(repo));
  const worktree = path.join(dataDir, 'worktrees', `${slug(repo)}__pr${prNumber}`);
  const prRef = `refs/rds/pr-${prNumber}`;
  const baseLocal = `refs/rds/base/${baseRef}`;

  return withRepoLock(repo, async () => {
    await fs.mkdir(path.dirname(repoDir), { recursive: true });
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    if (!existsSync(path.join(repoDir, '.git'))) {
      await fs.rm(repoDir, { recursive: true, force: true });
      await git(['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${repo}.git`, repoDir], { token, signal });
    }
    await git(['fetch', '--force', '--no-tags', 'origin', `+refs/pull/${prNumber}/head:${prRef}`, `+refs/heads/${baseRef}:${baseLocal}`], { cwd: repoDir, token, signal });

    // A fresh worktree every time: an earlier review may have left probe prints in it.
    if (existsSync(worktree)) {
      await git(['worktree', 'remove', '--force', worktree], { cwd: repoDir, token, signal }).catch(() => undefined);
      await fs.rm(worktree, { recursive: true, force: true });
    }
    await git(['worktree', 'prune'], { cwd: repoDir, token, signal });
    await git(['worktree', 'add', '--detach', worktree, prRef], { cwd: repoDir, token, signal });

    const headSha = (await git(['rev-parse', prRef], { cwd: repoDir, token, signal })).trim();
    const mergeBase = (await git(['merge-base', baseLocal, prRef], { cwd: repoDir, token, signal })).trim();
    const diff = await git(['diff', '--no-color', '--find-renames', mergeBase, prRef], { cwd: repoDir, token, signal });
    // The whole PR diff stays on disk for agents to read, whatever the prompt shows.
    await fs.mkdir(path.join(worktree, REVIEW_DIR), { recursive: true });
    await fs.writeFile(path.join(worktree, REVIEW_DIR, 'pr.diff'), diff, 'utf-8');

    let sinceDiff: string | undefined;
    if (sinceSha && /^[0-9a-f]{40}$/.test(sinceSha) && sinceSha !== headSha) {
      // Only when the old head is still an ancestor (no force-push or rebase since).
      const ancestor = await git(['merge-base', '--is-ancestor', sinceSha, prRef], { cwd: repoDir, token, signal }).then(() => true, () => false);
      if (ancestor) {
        // Limited to the PR's own files, so a merge of the base branch does not count as new work.
        const prFiles = (await git(['diff', '--name-only', mergeBase, prRef], { cwd: repoDir, token, signal })).split('\n').filter(Boolean);
        sinceDiff = prFiles.length ? await git(['diff', '--no-color', '--find-renames', sinceSha, prRef, '--', ...prFiles], { cwd: repoDir, token, signal }) : '';
      }
    }
    return { worktree, headSha, baseRef, diff, sinceDiff };
  });
}

export interface StandardsFile {
  path: string;
  text: string;
}

const STANDARD_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'bsconfig.json', 'bslint.json', 'manifest'];
const PER_STANDARD_CHARS = 6000;
const TOTAL_STANDARD_CHARS = 24000;

/** The repo's own rules and Roku project config, read from the checkout. */
export async function readStandards(worktree: string): Promise<StandardsFile[]> {
  const candidates = [...STANDARD_FILES];
  try {
    const rules = (await fs.readdir(path.join(worktree, '.cursor', 'rules'))).filter((f) => /\.(mdc|md)$/.test(f)).sort().slice(0, 10);
    candidates.push(...rules.map((f) => `.cursor/rules/${f}`));
  } catch {
    // No Cursor rules in this repo.
  }
  const files: StandardsFile[] = [];
  let total = 0;
  for (const rel of candidates) {
    try {
      let text = await fs.readFile(path.join(worktree, rel), 'utf-8');
      if (text.length > PER_STANDARD_CHARS) text = `${text.slice(0, PER_STANDARD_CHARS)}\n… (truncated; open the file for the rest)`;
      if (total + text.length > TOTAL_STANDARD_CHARS) break;
      total += text.length;
      files.push({ path: rel, text });
    } catch {
      // Not present in this repo.
    }
  }
  return files;
}

/** Up to this much changed-file content goes into the prompt; bigger PRs keep the (list + diff on disk). */
export const INLINE_FILES_BUDGET = 70_000;
const INLINE_FILE_MAX = 25_000;

/** App code first (what reviewers read anyway), then other code, then tests, then config and data. */
function inlinePriority(p: string): number {
  const lower = p.toLowerCase();
  if (/(^|\/)(tests?|specs?|__tests__)\//.test(lower) || /\.(spec|test)\./.test(lower)) return 2;
  if (/\.(brs|bs|xml)$/.test(lower)) return 0;
  if (/\.(ts|js|mjs|cjs|sh|py)$/.test(lower)) return 1;
  return 3;
}

/**
 * Current content of changed files within the budget (app code first, smaller first within a
 * group), so agents need not spend turns opening them. Skips deleted, binary and oversized files.
 */
export async function readChangedFiles(worktree: string, paths: string[], budget = INLINE_FILES_BUDGET): Promise<{ path: string; text: string }[]> {
  const sized: { path: string; size: number }[] = [];
  for (const p of paths) {
    const abs = path.resolve(worktree, p);
    if (!abs.startsWith(worktree + path.sep)) continue;
    const stat = await fs.stat(abs).catch(() => null);
    if (stat?.isFile() && stat.size <= INLINE_FILE_MAX) sized.push({ path: p, size: stat.size });
  }
  const out: { path: string; text: string }[] = [];
  let used = 0;
  for (const f of sized.sort((a, b) => inlinePriority(a.path) - inlinePriority(b.path) || a.size - b.size)) {
    if (used + f.size > budget) continue;
    const text = await fs.readFile(path.resolve(worktree, f.path), 'utf-8').catch(() => null);
    if (text === null || text.includes('\u0000')) continue;
    out.push({ path: f.path, text });
    used += f.size;
  }
  return out;
}
