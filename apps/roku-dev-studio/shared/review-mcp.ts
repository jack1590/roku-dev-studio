/**
 * Pure helpers for the review tools in the MCP server: job ids the agent passes back, which
 * project a repo belongs to, the GitHub repo behind a git remote, and the findings view an agent
 * reads (with the comment text that would actually post). No Electron, no file access.
 */

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type ReviewJobId =
  | { kind: 'pr'; projectId: string; repo: string; number: number }
  | { kind: 'local'; projectId: string; repo: string; branch: string };

export function encodeJobId(id: ReviewJobId): string {
  return id.kind === 'pr' ? `pr:${id.projectId}:${id.repo}#${id.number}` : `local:${id.projectId}:${id.repo}:${id.branch}`;
}

export function parseJobId(s: string): ReviewJobId | null {
  const pr = /^pr:([^:]+):([^:#]+)#(\d+)$/.exec(s);
  if (pr) {
    const number = Number(pr[3]);
    return REPO_PATTERN.test(pr[2]) && Number.isInteger(number) && number > 0 ? { kind: 'pr', projectId: pr[1], repo: pr[2], number } : null;
  }
  const local = /^local:([^:]+):([^:]+):(.+)$/.exec(s);
  if (local && REPO_PATTERN.test(local[2])) return { kind: 'local', projectId: local[1], repo: local[2], branch: local[3] };
  return null;
}

/** `owner/name` for a GitHub remote URL (https, scp-style or ssh), else null. */
export function parseGitHubRemote(url: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m && REPO_PATTERN.test(m[1]) ? m[1] : null;
}

/** The project whose repos include `repo`; ambiguous unless `projectId` picks one. */
export function resolveProject(repo: string, projects: { id: string; name: string; repos?: string[] }[], projectId?: string): { ok: true; projectId: string } | { ok: false; error: string } {
  if (projectId) {
    const chosen = projects.find((p) => p.id === projectId);
    if (!chosen) return { ok: false, error: `No project with id "${projectId}".` };
    return (chosen.repos ?? []).includes(repo) ? { ok: true, projectId } : { ok: false, error: `${repo} is not in project ${chosen.name}. Add it in Settings → Projects.` };
  }
  const matches = projects.filter((p) => (p.repos ?? []).includes(repo));
  if (matches.length === 1) return { ok: true, projectId: matches[0].id };
  if (!matches.length) return { ok: false, error: `No Dev Studio project lists ${repo}. Add it in Settings → Projects.` };
  return { ok: false, error: `${repo} is in more than one project (${matches.map((p) => `${p.name} [${p.id}]`).join(', ')}). Pass projectId.` };
}

export interface DraftSource {
  id: string;
  postId?: string;
  title: string;
  detail: string;
  status: string;
  severity: string;
  confidence?: number;
  file?: string;
  line?: number;
  endLine?: number;
  comment?: string;
}

export interface McpFinding {
  /** Post id: what `review_post` takes. */
  id: string;
  title: string;
  detail: string;
  status: string;
  severity: string;
  confidence?: number;
  file?: string;
  line?: number;
  endLine?: number;
  /** The text that would post: the user's saved edit, else the AI's draft. */
  comment?: string;
  posted: boolean;
  postedUrl?: string;
  postable: boolean;
}

export function draftView(result: { headSha: string; findings: DraftSource[] }, posting: { edits: Record<string, string>; posted: Record<string, { url?: string }> }): McpFinding[] {
  return result.findings.map((f) => {
    const id = f.postId ?? f.id;
    const comment = posting.edits[id] ?? f.comment;
    const done = posting.posted[id];
    return {
      id,
      title: f.title,
      detail: f.detail,
      status: f.status,
      severity: f.severity,
      ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
      ...(f.file ? { file: f.file } : {}),
      ...(f.line ? { line: f.line } : {}),
      ...(f.endLine ? { endLine: f.endLine } : {}),
      ...(comment ? { comment } : {}),
      posted: !!done,
      ...(done?.url ? { postedUrl: done.url } : {}),
      postable: (f.status === 'issue' || f.status === 'needs-device') && !!comment?.trim(),
    };
  });
}

/**
 * The checks `review_post` runs before anything reaches GitHub, in order: posting key, PR (not
 * local) review, saved review, unchanged head (the user approved this exact review), known
 * postable ids. Ids already posted pass: posting skips them.
 */
export function checkPostRequest(input: {
  keySet: boolean;
  keyMatches: boolean;
  jobId: ReviewJobId | null;
  storedHeadSha: string | null;
  findings: McpFinding[] | null;
  headSha: unknown;
  ids: unknown;
}): { ok: true; ids: string[] } | { ok: false; status: number; error: string } {
  if (!input.keySet || !input.keyMatches) {
    return { ok: false, status: 403, error: 'Posting is not enabled for this client. Set a posting key in Dev Studio → Settings → MCP Server and pass it to this client as RDS_POST_KEY.' };
  }
  if (!input.jobId) return { ok: false, status: 400, error: 'Unknown jobId.' };
  if (input.jobId.kind !== 'pr') return { ok: false, status: 400, error: 'Local reviews are never posted.' };
  if (!input.storedHeadSha || !input.findings) return { ok: false, status: 404, error: 'No finished review for this PR yet.' };
  if (input.headSha !== input.storedHeadSha) {
    return { ok: false, status: 409, error: `The review changed since you read it (now at ${input.storedHeadSha.slice(0, 7)}). Call review_get again and get approval for the new comments.` };
  }
  const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string') : [];
  if (!ids.length) return { ok: false, status: 400, error: 'Pass ids: the finding ids the user approved.' };
  const postable = new Set(input.findings.filter((f) => f.postable).map((f) => f.id));
  const bad = ids.filter((id) => !postable.has(id));
  if (bad.length) return { ok: false, status: 400, error: `Not postable on this review: ${bad.join(', ')}. Nothing was posted.` };
  return { ok: true, ids };
}
