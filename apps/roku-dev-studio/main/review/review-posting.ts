/**
 * Posting a review's comments to GitHub with the project's token.
 *
 * - Edits are kept next to the review (`…__posting.json`); the review's original comments stay as
 *   they were, so later reviews and comparisons still see what the AI wrote.
 * - Each finding's comment goes on its file and line (a PR review comment). When GitHub cannot pin
 *   it there (no file, or the line is not part of the diff), it becomes a plain PR comment.
 * - The general comment, when chosen, is posted first as a plain PR comment.
 * - One by one: the first comment goes right away, each next one after a random 0..max minutes.
 *   Otherwise all go at once. The queue lives in this process: if the app closes, the rest is dropped.
 * - A finding a PR thread already raises is posted as a reply in that thread, never as a new comment.
 * - Every comment carries a hidden marker, so a comment is never posted twice, even after a re-review.
 *
 * Only plain comments: nothing approves or requests changes. The token is only used in request headers.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/ipc/channels';
import * as tokenStore from '../project-token-store';

const fs = require('fs');
const { mainLog, mainWarn } = require('../log');

interface PostingState {
  edits: Record<string, string>;
  posted: Record<string, { at: number; url?: string }>;
}

interface StoredFinding {
  id: string;
  title: string;
  file?: string;
  line?: number;
  endLine?: number;
  status: string;
  comment?: string;
  /** Set when a PR thread already raises it: the comment is a reply posted in that thread. */
  discussion?: { replyTo?: number; url?: string; lastAuthor?: string };
  postId?: string;
}

interface StoredReviewLike {
  projectId: string;
  repo: string;
  number: number;
  result: { headSha: string; findings: StoredFinding[] };
}

export interface PostUpdate {
  projectId: string;
  repo: string;
  number: number;
  state: 'running' | 'done' | 'failed';
  /** Ids still waiting, in order. */
  queue: string[];
  /** Id being posted right now. */
  current?: string;
  /** When the next comment goes out (ms epoch), while waiting. */
  nextAt?: number;
  posted: PostingState['posted'];
  errors: Record<string, string>;
}

export const GENERAL_ID = 'general';
const marker = (id: string) => `<!-- rds-review:${id} -->`;
const runs = new Map<string, PostUpdate>();

function broadcast(update: PostUpdate): void {
  const { BrowserWindow } = require('electron') as typeof import('electron');
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(IPC.ReviewsPostUpdate, update);
}

async function github(token: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** Ids already on GitHub (from the hidden markers), so nothing is posted twice. */
async function alreadyPosted(token: string, repo: string, number: number): Promise<Set<string>> {
  const ids = new Set<string>();
  // ponytail: first 100 of each kind; page further if PRs ever carry more review comments than that.
  for (const url of [`/repos/${repo}/pulls/${number}/comments?per_page=100`, `/repos/${repo}/issues/${number}/comments?per_page=100`]) {
    const res = await github(token, 'GET', url).catch(() => null);
    for (const c of (Array.isArray(res?.json) ? res!.json : []) as { body?: string }[]) {
      for (const m of (c.body ?? '').matchAll(/<!-- rds-review:([\w-]+) -->/g)) ids.add(m[1]);
    }
  }
  return ids;
}

export function setupPostingHandlers(deps: {
  resultPath: (projectId: string, repo: string, number: number) => string;
  readStored: (projectId: string, repo: string, number: number) => StoredReviewLike | null;
}): void {
  const { ipcMain } = require('electron') as typeof import('electron');
  const statePath = (projectId: string, repo: string, number: number) => deps.resultPath(projectId, repo, number).replace(/\.json$/, '__posting.json');
  const readState = (projectId: string, repo: string, number: number): PostingState => {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath(projectId, repo, number), 'utf-8')) as Partial<PostingState>;
      return { edits: parsed.edits ?? {}, posted: parsed.posted ?? {} };
    } catch {
      return { edits: {}, posted: {} };
    }
  };
  const writeState = (projectId: string, repo: string, number: number, state: PostingState) => fs.writeFileSync(statePath(projectId, repo, number), JSON.stringify(state, null, 2), 'utf-8');
  const keyOf = (projectId: string, repo: string, number: number) => `${projectId}|${repo}#${number}`;

  // The review drawer reads edits, posted marks and a running queue alongside the review.
  ipcMain.handle(IPC.ReviewsPostingState, async (_e: IpcMainInvokeEvent, p?: { projectId?: unknown; repo?: unknown; number?: unknown }) => {
    const projectId = String(p?.projectId), repo = String(p?.repo), number = Number(p?.number);
    return { success: true, state: readState(projectId, repo, number), run: runs.get(keyOf(projectId, repo, number)) ?? null };
  });

  ipcMain.handle(IPC.ReviewsSaveComment, async (_e: IpcMainInvokeEvent, p?: { projectId?: unknown; repo?: unknown; number?: unknown; id?: unknown; text?: unknown }) => {
    const projectId = String(p?.projectId), repo = String(p?.repo), number = Number(p?.number), id = String(p?.id ?? '');
    if (!deps.readStored(projectId, repo, number) || !/^[\w-]{1,64}$/.test(id)) return { success: false, error: 'Review not found.' };
    const state = readState(projectId, repo, number);
    if (state.posted[id]) return { success: false, error: 'Already posted.' };
    if (typeof p?.text === 'string' && p.text.trim()) state.edits[id] = p.text.slice(0, 20_000);
    else delete state.edits[id]; // null or empty: back to the original
    writeState(projectId, repo, number, state);
    return { success: true, state };
  });

  ipcMain.handle(IPC.ReviewsPost, async (_e: IpcMainInvokeEvent, p?: { projectId?: unknown; repo?: unknown; number?: unknown; ids?: unknown; general?: unknown; spaced?: unknown; maxMinutes?: unknown }) => {
    const projectId = String(p?.projectId), repo = String(p?.repo), number = Number(p?.number);
    const stored = deps.readStored(projectId, repo, number);
    if (!stored) return { success: false, error: 'Review not found.' };
    const key = keyOf(projectId, repo, number);
    if (runs.get(key)?.state === 'running') return { success: false, error: 'Already posting this review.' };
    const token = tokenStore.getToken(projectId, 'github');
    if (!token) return { success: false, error: 'Save a GitHub token for this project first.' };
    // Never comment on your own PR: the token owner is the author.
    const [me, pr] = await Promise.all([github(token, 'GET', '/user').catch(() => null), github(token, 'GET', `/repos/${repo}/pulls/${number}`).catch(() => null)]);
    const login = ((me?.json as { login?: string }) ?? {}).login?.toLowerCase();
    const author = ((pr?.json as { user?: { login?: string } }) ?? {}).user?.login?.toLowerCase();
    if (!login || !author) return { success: false, error: 'Could not check who opened this PR on GitHub. Try again.' };
    if (login === author) return { success: false, error: 'This is your own PR (the GitHub token belongs to its author), so comments are not posted. Use Copy fix prompt to work on the findings instead.' };
    const general = typeof p?.general === 'string' && p.general.trim() ? p.general.slice(0, 20_000) : null;
    // Post ids, not finding ids: a reply in a thread posts as "<id>-reply-<n>".
    const requested = (Array.isArray(p?.ids) ? p!.ids : []).filter((id): id is string => typeof id === 'string');
    const findingIds = requested.filter((id) => stored.result.findings.some((f) => (f.postId ?? f.id) === id));
    if (findingIds.length < requested.length) return { success: false, error: 'Some chosen comments are no longer on this review. Reopen it and try again.' };
    const maxMinutes = Math.max(0, Math.min(60, Number(p?.maxMinutes) || 0));
    const spaced = p?.spaced === true && maxMinutes > 0;

    const state = readState(projectId, repo, number);
    const onGitHub = await alreadyPosted(token, repo, number);
    // Mark what is already on GitHub (e.g. posted from another machine) so it is not sent again.
    for (const id of onGitHub) if (!state.posted[id]) state.posted[id] = { at: Date.now() };
    writeState(projectId, repo, number, state);
    const queue = [...(general ? [GENERAL_ID] : []), ...findingIds].filter((id) => !state.posted[id]);
    if (!queue.length) return { success: false, error: 'Nothing new to post: the chosen comments are already on GitHub.' };

    const run: PostUpdate = { projectId, repo, number, state: 'running', queue: [...queue], posted: state.posted, errors: {} };
    runs.set(key, run);
    broadcast(run);
    mainLog(`[reviews] posting ${queue.length} comment(s) to ${repo}#${number}${spaced ? `, one by one up to ${maxMinutes} min apart` : ''}`);

    void (async () => {
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        if (i > 0 && spaced) {
          const wait = Math.round(Math.random() * maxMinutes * 60_000);
          run.nextAt = Date.now() + wait;
          broadcast(run);
          await new Promise((r) => setTimeout(r, wait));
          run.nextAt = undefined;
        }
        run.current = id;
        run.queue = queue.slice(i + 1);
        broadcast(run);
        try {
          const fresh = readState(projectId, repo, number);
          let url: string | undefined;
          if (id === GENERAL_ID) {
            const res = await github(token, 'POST', `/repos/${repo}/issues/${number}/comments`, { body: `${general}\n\n${marker(id)}` });
            if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
            url = (res.json as { html_url?: string })?.html_url;
          } else {
            const f = stored.result.findings.find((x) => (x.postId ?? x.id) === id)!;
            const text = (fresh.edits[id] ?? f.comment ?? '').trim();
            if (!text) throw new Error('This finding has no comment text.');
            const body = `${text}\n\n${marker(id)}`;
            let posted = false;
            if (f.discussion?.replyTo) {
              // Already discussed: answer in that thread.
              const reply = await github(token, 'POST', `/repos/${repo}/pulls/${number}/comments/${f.discussion.replyTo}/replies`, { body });
              if (reply.ok) {
                url = (reply.json as { html_url?: string })?.html_url;
              } else {
                // GitHub can refuse a reply in the thread (e.g. an outdated one): post it as a PR comment pointing at it.
                mainWarn(`[reviews] reply in thread ${f.discussion.replyTo} on ${repo}#${number} refused (HTTP ${reply.status}); posting as a PR comment`);
                const to = f.discussion.lastAuthor ? `@${f.discussion.lastAuthor} ` : '';
                const res = await github(token, 'POST', `/repos/${repo}/issues/${number}/comments`, { body: `${to}Re: [this thread](${f.discussion.url ?? ''})\n\n${body}` });
                if (!res.ok) throw new Error(`GitHub returned HTTP ${reply.status} replying in the thread and ${res.status} as a PR comment.`);
                url = (res.json as { html_url?: string })?.html_url;
              }
              posted = true;
            } else if (f.file && f.line) {
              const inline = await github(token, 'POST', `/repos/${repo}/pulls/${number}/comments`, {
                body,
                commit_id: stored.result.headSha,
                path: f.file,
                line: f.endLine && f.endLine > f.line ? f.endLine : f.line,
                ...(f.endLine && f.endLine > f.line ? { start_line: f.line, start_side: 'RIGHT' } : {}),
                side: 'RIGHT',
              });
              if (inline.ok) {
                posted = true;
                url = (inline.json as { html_url?: string })?.html_url;
              } else if (inline.status !== 422) {
                throw new Error(`GitHub returned HTTP ${inline.status}.`);
              }
            }
            if (!posted) {
              // GitHub cannot pin it to a changed line: post it as a plain PR comment, with its location.
              const where = f.file ? `**\`${f.file}${f.line ? `:${f.line}` : ''}\`**\n\n` : '';
              const res = await github(token, 'POST', `/repos/${repo}/issues/${number}/comments`, { body: `${where}${body}` });
              if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
              url = (res.json as { html_url?: string })?.html_url;
            }
          }
          fresh.posted[id] = { at: Date.now(), url };
          writeState(projectId, repo, number, fresh);
          run.posted = fresh.posted;
        } catch (err) {
          run.errors[id] = err instanceof Error ? err.message : String(err);
          mainWarn(`[reviews] posting ${id} to ${repo}#${number} failed: ${run.errors[id]}`);
        }
        // Done with this one: the bar shows "waiting", not "posting", until the next goes out.
        run.current = undefined;
        broadcast(run);
      }
      run.current = undefined;
      run.queue = [];
      run.state = Object.keys(run.errors).length ? 'failed' : 'done';
      broadcast(run);
    })();
    return { success: true, run };
  });
}
