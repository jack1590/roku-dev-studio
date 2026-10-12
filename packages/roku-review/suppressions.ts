/**
 * Findings the team said no to, remembered per repository, so the next PR does not
 * raise them again.
 *
 * Two tiers: one dismissal suppresses the same objection on the same file; a second dismissal of
 * the same objection (anywhere) suppresses it across the whole repo. "Same objection" is a similar
 * title, since models reword between runs. Suppressed findings are kept on the review under
 * Dismissed with the history that dismissed them, never deleted. CI findings are facts and are
 * never suppressed.
 */

import type { FindingStatus, ReviewFinding } from './review';

export interface Dismissal {
  id: string;
  file?: string;
  title: string;
  reason?: string;
  at: number;
  /** The PR it was dismissed on. */
  prNumber?: number;
}

/** Dismissals after this many similar ones apply anywhere in the repo, not just on their file. */
export const REPO_WIDE_AFTER = 2;
const MAX_PROMPT_ENTRIES = 15;

const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Word overlap (Jaccard) of two titles. Pure; pinned by verify-review.ts. */
export function similar(a: string, b: string, threshold = 0.4): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= threshold;
}

// ponytail: word-overlap match; a reworded title with few shared words slips through. Embeddings if that bites.
const sameObjection = (a: string, b: string) => similar(a, b, 0.5);

/** The dismissal that suppresses this finding, if any. Pure; pinned by verify-review.ts. */
export function matchDismissal(f: { file?: string; title: string }, list: Dismissal[]): Dismissal | undefined {
  const alike = list.filter((d) => sameObjection(d.title, f.title));
  return alike.find((d) => (d.file ?? '') === (f.file ?? '')) ?? (alike.length >= REPO_WIDE_AFTER ? alike[0] : undefined);
}

/** Dismissals that a Restore of this finding should forget: every remembered copy of the objection. */
export function dismissalsFor(f: { title: string }, list: Dismissal[]): Dismissal[] {
  return list.filter((d) => sameObjection(d.title, f.title));
}

/** Move suppressed findings to Dismissed, keeping why and where they were. Mutates; returns how many. */
export function applyDismissals(findings: ReviewFinding[], list: Dismissal[]): number {
  let n = 0;
  for (const f of findings) {
    if (f.ci || f.status === 'dismissed') continue;
    const d = matchDismissal(f, list);
    if (!d) continue;
    f.userDismissed = { at: d.at, reason: d.reason, previousStatus: f.status, remembered: true, ...(d.prNumber ? { prNumber: d.prNumber } : {}) };
    f.status = 'dismissed';
    n++;
  }
  return n;
}

export function countFindings(findings: { status: FindingStatus }[]): Record<FindingStatus, number> {
  const counts: Record<FindingStatus, number> = { issue: 0, 'needs-device': 0, noted: 0, dismissed: 0 };
  for (const f of findings) counts[f.status]++;
  return counts;
}

/** What the reviewers and judge are told not to raise. Most recent first, capped to stay cheap. */
export function dismissalPromptBlock(list: Dismissal[]): string {
  if (!list.length) return '';
  const lines = [...list]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_PROMPT_ENTRIES)
    .map((d) => `- "${d.title}"${d.file ? ` (${d.file})` : ''}${d.reason ? `: ${d.reason}` : ''}`);
  return `The team already dismissed these findings in this repository. Do not raise them, or close rewordings of them, again unless this PR makes them clearly worse:\n${lines.join('\n')}`;
}
