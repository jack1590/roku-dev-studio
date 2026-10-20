/**
 * The MCP bridge's review routes (`/review/*`): start a PR or local-branch review, poll it, read
 * its findings, post approved comments, list reviews. Kept out of `mcp-bridge.ts`, which only
 * forwards the parsed body here.
 *
 * `/review/post` is the bridge's only route that writes outside the machine. It needs the posting
 * key (header `X-RDS-Post-Key`) on top of the bridge token, and only posts finding ids of a
 * finished review at the head the caller read (see `checkPostRequest`). Never free text.
 */

import { timingSafeEqual } from 'crypto';
import type { ReviewResult } from 'roku-dev-studio-review';
import { checkPostRequest, draftView, encodeJobId, parseJobId, resolveProject } from '../../shared/review-mcp';
import { listProjectRecords } from '../ipc/project-handlers';
import { getPostKey } from '../mcp-post-key';
import { getLocalReview, startLocalReview } from './local-review';
import { readPostingState, startPosting } from './review-posting';
import { getReviewSummary, listReviews, readStored, startReview, type ReviewSummary } from './review-service';

export type RouteResult = { status: number; body: unknown };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function sameKey(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '', 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}

const prJobId = (s: ReviewSummary) => encodeJobId({ kind: 'pr', projectId: s.projectId, repo: s.repo, number: s.number });

function statusBody(jobId: string, s: { status: string; phase?: string; detail?: string; error?: string; headSha?: string; counts?: unknown; finishedAt?: number; lostLenses?: string[] }) {
  return { jobId, status: s.status, phase: s.phase, detail: s.detail, error: s.error, headSha: s.headSha, counts: s.counts, finishedAt: s.finishedAt, lostLenses: s.lostLenses };
}

function resultBody(result: ReviewResult) {
  return {
    headSha: result.headSha,
    finishedAt: result.finishedAt,
    summary: result.summary,
    counts: result.counts,
    ...(result.lostLenses?.length ? { lostLenses: result.lostLenses } : {}),
    ...(result.context.diffNotes.length ? { skippedFiles: result.context.diffNotes } : {}),
    ticket: result.context.ticket ? `${result.context.ticket.key}: ${result.context.ticket.summary}` : (result.context.ticketNote ?? 'none'),
    ...(result.incremental ? { incremental: result.incremental } : {}),
  };
}

/** Handles a `/review/*` POST; null for any other path. */
export async function reviewRoute(pathname: string, body: Record<string, unknown>, postKeyHeader: string | undefined): Promise<RouteResult | null> {
  if (pathname === '/review/start') {
    const projectId = str(body.projectId);
    const localPath = str(body.path);
    if (localPath) {
      const started = await startLocalReview({ path: localPath, base: str(body.base), projectId });
      return started.success ? { status: 200, body: { jobId: started.jobId, status: statusBody(started.jobId, started.summary) } } : { status: 400, body: { error: started.error } };
    }
    const repo = str(body.repo);
    const number = typeof body.number === 'number' ? body.number : NaN;
    if (!repo || !Number.isInteger(number) || number <= 0) return { status: 400, body: { error: 'Pass either path (a local checkout) or repo ("owner/name") and number.' } };
    const project = resolveProject(repo, listProjectRecords(), projectId);
    if (!project.ok) return { status: 400, body: { error: project.error } };
    const started = startReview(project.projectId, project.repo, number);
    if (!started.success) return { status: 400, body: { error: started.error } };
    const jobId = prJobId(started.summary);
    return { status: 200, body: { jobId, status: statusBody(jobId, started.summary) } };
  }

  if (pathname === '/review/status' || pathname === '/review/get') {
    const jobId = str(body.jobId) ?? '';
    const id = parseJobId(jobId);
    if (!id) return { status: 400, body: { error: 'Unknown jobId.' } };
    if (id.kind === 'pr') {
      const summary = getReviewSummary(id.projectId, id.repo, id.number);
      if (!summary) return { status: 404, body: { error: 'No review for this PR yet. Call review_start.' } };
      if (pathname === '/review/status') return { status: 200, body: statusBody(jobId, summary) };
      const stored = summary.status === 'done' ? readStored(id.projectId, id.repo, id.number) : null;
      if (!stored) return { status: 409, body: { error: `The review is ${summary.status}, not done yet.`, status: statusBody(jobId, summary) } };
      return {
        status: 200,
        body: { jobId, kind: 'pr', repo: id.repo, number: id.number, title: stored.title, url: stored.url, ...resultBody(stored.result), findings: draftView(stored.result, readPostingState(id.projectId, id.repo, id.number)) },
      };
    }
    const local = getLocalReview(id.projectId, id.repo, id.branch);
    if (!local) return { status: 404, body: { error: 'No review for this branch yet. Call review_start.' } };
    if (pathname === '/review/status') return { status: 200, body: statusBody(jobId, local.summary) };
    if (!local.result) return { status: 409, body: { error: `The review is ${local.summary.status}, not done yet.`, status: statusBody(jobId, local.summary) } };
    return {
      status: 200,
      body: { jobId, kind: 'local', repo: id.repo, branch: id.branch, base: local.base, ...resultBody(local.result), findings: draftView(local.result, { edits: {}, posted: {} }) },
    };
  }

  if (pathname === '/review/post') {
    const jobId = str(body.jobId) ?? '';
    const id = parseJobId(jobId);
    const key = getPostKey();
    const stored = id?.kind === 'pr' ? readStored(id.projectId, id.repo, id.number) : null;
    const findings = stored && id?.kind === 'pr' ? draftView(stored.result, readPostingState(id.projectId, id.repo, id.number)) : null;
    const check = checkPostRequest({ keySet: !!key, keyMatches: !!key && sameKey(postKeyHeader, key), jobId: id, storedHeadSha: stored?.result.headSha ?? null, storedFinishedAt: stored?.result.finishedAt ?? null, findings, headSha: body.headSha, finishedAt: body.finishedAt, ids: body.ids });
    if (!check.ok) return { status: check.status, body: { error: check.error } };
    const pr = id as { projectId: string; repo: string; number: number };
    const started = await startPosting({ projectId: pr.projectId, repo: pr.repo, number: pr.number, ids: check.ids, spaced: false });
    if (!started.success) return { status: 409, body: { error: started.error } };
    const run = await started.done;
    const results: Record<string, { posted: true; url?: string } | { error: string }> = {};
    for (const postId of check.ids) {
      if (run.errors[postId]) results[postId] = { error: run.errors[postId] };
      else if (run.posted[postId]) results[postId] = { posted: true, ...(run.posted[postId].url ? { url: run.posted[postId].url } : {}) };
    }
    return { status: 200, body: { jobId, results } };
  }

  if (pathname === '/review/list') {
    const projectId = str(body.projectId);
    const projects = listProjectRecords().filter((p) => !projectId || p.id === projectId);
    const reviews = projects.flatMap((p) => listReviews(p.id)).map((s) => ({ ...statusBody(prJobId(s), s), repo: s.repo, number: s.number, posting: s.posting }));
    return { status: 200, body: { reviews } };
  }

  return null;
}
