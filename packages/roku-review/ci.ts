/**
 * CI evidence for a review, from GitHub: check runs with their file/line annotations,
 * plus classic commit statuses, on the PR's head commit.
 *
 * - A red check with annotations is a fact (a compiler or lint error, a failing assertion): its
 *   annotations become confirmed findings that skip the judge.
 * - A red check without code annotations (device not reached, timeout, runner crash) is not
 *   evidence about the code: it is shown as an infrastructure failure and not counted.
 * - Pending checks are shown as pending; green checks are passed to the agents as context.
 *
 * The GitHub token is only used in the request header; it is never logged or returned.
 */

export type CiState = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'cancelled';

export interface CiAnnotation {
  path: string;
  line?: number;
  endLine?: number;
  level: 'failure' | 'warning' | 'notice';
  title?: string;
  message: string;
}

export interface CiCheck {
  name: string;
  state: CiState;
  url?: string;
  annotations: CiAnnotation[];
}

export interface CiReport {
  headSha: string;
  checks: CiCheck[];
  /** Set when GitHub could not be read; the review goes on without CI. */
  error?: string;
}

interface CheckRunApi {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  output?: { annotations_count?: number };
}

const MAX_ANNOTATIONS_PER_CHECK = 50;

/**
 * GitHub Actions adds its own annotations to any failed step ("Process completed with exit code 1"
 * on .github): they say a job failed, not where the code is wrong. Pure; pinned by verify-review.ts.
 */
export function isCodeAnnotation(filePath: string, message: string): boolean {
  if (filePath === '.github' || filePath.startsWith('.github/')) return false;
  return !/^Process completed with exit code \d+/i.test(message.trim());
}

function stateOfRun(run: CheckRunApi): CiState {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'neutral':
      return 'neutral';
    case 'skipped':
      return 'skipped';
    case 'cancelled':
      return 'cancelled';
    default:
      // failure, timed_out, action_required, stale
      return 'failure';
  }
}

async function githubJson<T>(token: string, url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`https://api.github.com${url}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal,
  });
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for CI checks.`);
  return (await res.json()) as T;
}

export async function fetchCi(input: { token: string; repo: string; headSha: string; signal?: AbortSignal }): Promise<CiReport> {
  const { token, repo, headSha, signal } = input;
  if (!/^[0-9a-f]{40}$/.test(headSha)) return { headSha, checks: [], error: 'Invalid commit.' };
  try {
    const [runs, statuses] = await Promise.all([
      githubJson<{ check_runs: CheckRunApi[] }>(token, `/repos/${repo}/commits/${headSha}/check-runs?per_page=100`, signal),
      githubJson<{ statuses: { context: string; state: string; target_url?: string }[] }>(token, `/repos/${repo}/commits/${headSha}/status`, signal).catch(() => ({ statuses: [] })),
    ]);
    const checks: CiCheck[] = [];
    // Re-runs leave older runs of the same check on the commit: only the latest one counts.
    const latest = new Map<string, CheckRunApi>();
    for (const run of [...(runs.check_runs ?? [])].sort((a, b) => b.id - a.id)) if (!latest.has(run.name)) latest.set(run.name, run);
    for (const run of latest.values()) {
      const state = stateOfRun(run);
      let annotations: CiAnnotation[] = [];
      if (state === 'failure' && (run.output?.annotations_count ?? 0) > 0) {
        const raw = await githubJson<{ path: string; start_line?: number; end_line?: number; annotation_level: string; title?: string; message: string }[]>(
          token,
          `/repos/${repo}/check-runs/${run.id}/annotations?per_page=${MAX_ANNOTATIONS_PER_CHECK}`,
          signal
        ).catch(() => []);
        annotations = raw
          .filter((a) => a.path && a.message && (a.annotation_level === 'failure' || a.annotation_level === 'warning') && isCodeAnnotation(a.path, a.message))
          .map((a) => ({ path: a.path, line: a.start_line, endLine: a.end_line, level: a.annotation_level as 'failure' | 'warning', title: a.title, message: a.message.slice(0, 2000) }));
      }
      checks.push({ name: run.name, state, url: run.html_url, annotations });
    }
    for (const s of statuses.statuses ?? []) {
      // Classic statuses carry no annotations; a red one is reported like an unannotated check.
      const state: CiState = s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure';
      if (!checks.some((c) => c.name === s.context)) checks.push({ name: s.context, state, url: s.target_url, annotations: [] });
    }
    return { headSha, checks };
  } catch (err) {
    return { headSha, checks: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Code-level CI failures (annotations on red checks). Pure; pinned by verify-review.ts. */
export function ciFindings(report: CiReport): { check: string; url?: string; annotation: CiAnnotation }[] {
  return report.checks
    .filter((c) => c.state === 'failure')
    .flatMap((c) => c.annotations.filter((a) => a.level === 'failure' || a.level === 'warning').map((annotation) => ({ check: c.name, url: c.url, annotation })));
}

/** Red checks that say nothing about the code: likely infrastructure (device unreachable, timeout). */
export function ciInfraFailures(report: CiReport): CiCheck[] {
  return report.checks.filter((c) => c.state === 'failure' && !c.annotations.length);
}

/** What the agents are told about CI. Empty when there is nothing to say. */
export function ciPromptBlock(report: CiReport | undefined): string {
  if (!report) return '';
  if (report.error) return `CI checks: could not be read (${report.error}). Do not claim the code builds, lints or passes tests.`;
  if (!report.checks.length) return 'CI checks: none reported on this commit. Do not claim the code builds, lints or passes tests.';
  const line = (c: CiCheck) => {
    if (c.state === 'failure') return c.annotations.length ? `- ${c.name}: FAILED with ${c.annotations.length} code annotation(s), already reported as confirmed findings; do not repeat them` : `- ${c.name}: failed without code annotations (likely infrastructure, e.g. device not reached); not evidence about the code`;
    return `- ${c.name}: ${c.state}`;
  };
  return `CI checks on the head commit:
${report.checks.map(line).join('\n')}
Only claim the code builds, lints or passes tests where a green check above covers it.`;
}
