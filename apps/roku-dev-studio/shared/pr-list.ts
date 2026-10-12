/**
 * Pull requests shown in the PR Reviews panel, and the pure logic around them: which state a PR
 * is in, which filter it belongs to, and how to describe its age. Used by the main process (to
 * shape GitHub data) and the renderer (to filter and label), and pinned by
 * `scripts/verify-project-config.ts`.
 */

export type ChecksState = 'success' | 'failure' | 'pending' | 'none';
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'none';

export interface PullRequestItem {
  /** "owner/name" */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  head: string;
  base: string;
  additions: number;
  deletions: number;
  /** ISO timestamp */
  updatedAt: string;
  conflicts: boolean;
  checks: ChecksState;
  decision: ReviewDecision;
  /** A review is requested from the signed-in user directly (not through a team). */
  reviewRequested: boolean;
  /** Head commit, to tell whether a saved review is outdated. */
  headSha: string;
}

export type PrFilter = 'needs-you' | 'mine' | 'problems' | 'all';

export const PR_FILTERS: { id: PrFilter; label: string }[] = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'mine', label: 'Mine' },
  { id: 'problems', label: 'Problems' },
  { id: 'all', label: 'All' },
];

export type PrTone = 'danger' | 'warn' | 'success' | 'info' | 'muted';

export interface PrState {
  label: string;
  /** One sentence on what the state means, shown next to the label. */
  hint: string;
  tone: PrTone;
}

const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Something stops this PR from merging as it is. */
export function hasProblem(pr: PullRequestItem): boolean {
  return pr.conflicts || pr.checks === 'failure' || pr.decision === 'changes_requested';
}

/** The one state worth showing on a row. First match wins, most urgent first. */
export function prState(pr: PullRequestItem): PrState {
  if (pr.conflicts) return { label: 'Has conflicts', hint: 'Resolve the merge conflicts before it can merge.', tone: 'danger' };
  if (pr.decision === 'changes_requested') return { label: 'Changes requested', hint: 'A reviewer asked for changes.', tone: 'danger' };
  if (pr.checks === 'failure') return { label: 'Checks failing', hint: 'A required check is failing.', tone: 'danger' };
  if (pr.draft) return { label: 'Draft', hint: 'Not ready for review yet.', tone: 'muted' };
  if (pr.decision === 'approved') return { label: 'Approved', hint: pr.checks === 'pending' ? 'Approved. Checks are still running.' : 'Approved and ready to merge.', tone: 'success' };
  if (pr.reviewRequested) return { label: 'Review requested', hint: 'Your review was requested.', tone: 'warn' };
  if (pr.checks === 'pending') return { label: 'Checks running', hint: 'Waiting for checks to finish.', tone: 'info' };
  return { label: 'Open', hint: pr.decision === 'review_required' ? 'Waiting for a review.' : 'No review activity yet.', tone: 'info' };
}

export function matchesFilter(pr: PullRequestItem, filter: PrFilter, viewer: string): boolean {
  const mine = sameLogin(pr.author, viewer);
  switch (filter) {
    case 'needs-you':
      return pr.reviewRequested || (mine && hasProblem(pr));
    case 'mine':
      return mine;
    case 'problems':
      return hasProblem(pr);
    default:
      return true;
  }
}

/** Free-text match over what a row shows: title, number, author, repo, and branches. */
export function matchesSearch(pr: PullRequestItem, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/^#/, '');
  if (!needle) return true;
  return [pr.title, String(pr.number), pr.author, pr.repo, pr.head, pr.base].some((field) => field.toLowerCase().includes(needle));
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date for anything older than 30 days. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
