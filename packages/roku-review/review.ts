/**
 * One review: three reviewers in parallel (one lens each), then the judge.
 *
 * Findings end up in one of four buckets:
 * - issue: the judge verified it in the code and it clears the severity and confidence floors.
 * - needs-device: plausible, but only a device run can settle it. Never counted or posted as fact.
 * - noted: real but below the floors, or unverified because the judge was unavailable.
 * - dismissed: the judge ruled it out (with the reason kept).
 */

import { createHash } from 'crypto';
import { addCost, EMPTY_COST, extractJson, runReadOnlyAgent, type RunCost } from './agent';
import { ciFindings, ciInfraFailures, type CiReport } from './ci';
import { judgePrompt, LENSES, reviewerPrompt, type LensId, type PromptContext } from './prompts';
import type { DeviceReport } from './device';

export type Severity = 'info' | 'minor' | 'major' | 'critical';
export type FindingStatus = 'issue' | 'needs-device' | 'noted' | 'dismissed';

const SEVERITY_RANK: Record<Severity, number> = { info: 0, minor: 1, major: 2, critical: 3 };
/** Defaults: info notes and hedged findings are shown but do not count as work. */
export const SEVERITY_FLOOR: Severity = 'minor';
export const CONFIDENCE_FLOOR = 0.5;


export interface ReviewFinding {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  file?: string;
  line?: number;
  endLine?: number;
  status: FindingStatus;
  deviceCheck?: string;
  confidence?: number;
  reasoning: string;
  sources: string[];
  /** The file is part of this PR's diff. */
  inDiff: boolean;
  /** Draft inline GitHub comment, written to the team's comment style. Previewed, not posted yet. */
  comment?: string;
  /** Trimmed console lines from a device run that settled this finding. */
  deviceEvidence?: string;
  /** PR test files that exercise this finding (needs-device only); a device run executes them. */
  tests?: string[];
  /** Set for findings that come from CI annotations: facts, not judged. */
  ci?: { check: string; url?: string };
}

export interface AgentSummary {
  role: string;
  model: string;
  status: 'finished' | 'error' | 'cancelled' | 'skipped';
  error?: string;
  findings?: number;
  durationMs?: number;
  tokens?: number;
  usage?: RunCost;
  /** Tool calls made: a measure of how much the agent read. */
  toolCalls?: number;
  /** A reviewer that failed once and succeeded on its retry. */
  retried?: boolean;
  /** Reviewer only: how many of its findings the judge kept (not dismissed). Measures what a lens is worth. */
  kept?: number;
}

export interface ReviewResult {
  headSha: string;
  startedAt: number;
  finishedAt: number;
  summary: string;
  /** Draft overall PR review comment in the team's style. */
  reviewBody?: string;
  deviceRecommended: boolean;
  deviceReason?: string;
  findings: ReviewFinding[];
  counts: Record<FindingStatus, number>;
  agents: AgentSummary[];
  /** The device verification, when one ran or was blocked. */
  device?: DeviceReport;
  /** Set when only the commits since `sinceSha` were reviewed; `carried` findings were kept from that review unchanged. */
  incremental?: { sinceSha: string; carried: number; rechecked: number };
  /** CI on the head commit, as shown on the review. */
  ci?: { checks: { name: string; state: string; url?: string; annotations: number }[]; infra: string[]; error?: string };
  /** Reviewer lenses that failed even after a retry: the review is incomplete without them. */
  lostLenses?: string[];
  /** Tokens and approximate price of every agent run in this review, device run included. */
  usage?: RunCost;
  /** What the review was checked against, for the "checked against" card. */
  context: { standards: string[]; wikiPages: string[]; instructions: boolean; diffNotes: string[]; files: number };
}

export interface ReviewInput {
  apiKey: string;
  models: { reviewer1?: string; reviewer2?: string; reviewer3?: string; judge?: string };
  ctx: PromptContext;
  worktree: string;
  headSha: string;
  changedFiles: string[];
  wikiPages: string[];
  signal?: AbortSignal;
  onPhase?: (phase: 'reviewing' | 'judging', detail: string) => void;
  /** CI evidence for the head commit; annotated failures become confirmed findings. */
  ci?: CiReport;
  /** Re-review after new commits: previous findings to re-check (files the commits touched) and to carry over as they are. */
  previous?: { sinceSha: string; recheck: ReviewFinding[]; carry: ReviewFinding[]; prFiles: string[] };
}

interface RawFinding {
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  endLine?: unknown;
  title?: unknown;
  detail?: unknown;
  deviceCheck?: unknown;
  verdict?: unknown;
  needsDevice?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  sources?: unknown;
  comment?: unknown;
  previousId?: unknown;
  tests?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
const severityOf = (v: unknown): Severity => (typeof v === 'string' && v in SEVERITY_RANK ? (v as Severity) : 'minor');

function fingerprint(file: string | undefined, title: string): string {
  return createHash('sha256').update(`${file ?? ''}\n${title.toLowerCase()}`).digest('hex').slice(0, 12);
}

/** Sort a judged finding into its bucket. Pure; pinned by verify-review.ts. */
export function classify(f: { verdict: 'real' | 'dismissed'; needsDevice: boolean; severity: Severity; confidence?: number }): FindingStatus {
  if (f.verdict === 'dismissed') return 'dismissed';
  if (f.needsDevice) return 'needs-device';
  const belowSeverity = SEVERITY_RANK[f.severity] < SEVERITY_RANK[SEVERITY_FLOOR];
  const belowConfidence = f.confidence !== undefined && f.confidence < CONFIDENCE_FLOOR;
  return belowSeverity || belowConfidence ? 'noted' : 'issue';
}

/** Errors a retry cannot fix: usage or spend limits, auth, a model that does not exist. */
export function isPermanentFailure(error: string): boolean {
  return /usage limit|spend limit|quota|unauthori[sz]ed|invalid api key|forbidden|model .*not (found|available)/i.test(error);
}

const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
function similar(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.4;
}

/**
 * Merge findings that several lenses raised about the same thing (same file, lines within 3,
 * similar title), so the judge verifies each issue once. Pure; pinned by verify-review.ts.
 */
export function mergeFindings(byLens: Record<string, Record<string, unknown>[]>): (Record<string, unknown> & { raisedBy: string[] })[] {
  const merged: (Record<string, unknown> & { raisedBy: string[] })[] = [];
  for (const [lens, list] of Object.entries(byLens)) {
    for (const f of list) {
      const file = str(f.file), title = str(f.title), line = int(f.line);
      const same = merged.find((m) => str(m.file) === file && (line === undefined || int(m.line) === undefined || Math.abs(int(m.line)! - line) <= 3) && (str(m.title).toLowerCase() === title.toLowerCase() || similar(str(m.title), title)));
      if (!same) {
        merged.push({ ...f, raisedBy: [lens] });
        continue;
      }
      if (!same.raisedBy.includes(lens)) same.raisedBy.push(lens);
      // Keep the stronger severity; keep the other reviewer's reasoning and evidence for the judge.
      if (SEVERITY_RANK[severityOf(f.severity)] > SEVERITY_RANK[severityOf(same.severity)]) same.severity = f.severity;
      if (str(f.detail)) same.detail = `${str(same.detail)}\nAlso (${lens}): ${str(f.detail)}`.trim();
      if (str(f.evidence)) same.evidence = `${str(same.evidence)}\n${str(f.evidence)}`.trim();
    }
  }
  return merged;
}

function parseReviewerFindings(text: string): RawFinding[] | null {
  const parsed = extractJson<{ findings?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.findings)) return null;
  return parsed.findings.filter((f): f is RawFinding => typeof f === 'object' && f !== null && !!str((f as RawFinding).title));
}

export async function runReview(input: ReviewInput): Promise<ReviewResult> {
  const startedAt = Date.now();
  const changed = new Set(input.previous?.prFiles ?? input.changedFiles);
  const reviewers: [LensId, string | undefined][] = [
    ['correctness', input.models.reviewer1],
    ['security', input.models.reviewer2],
    ['roku', input.models.reviewer3],
  ];
  const active = reviewers.filter((r): r is [LensId, string] => !!r[1]);
  if (!active.length) throw new Error('Choose at least one reviewer model in Settings → Projects → AI review.');
  if (!input.models.judge) throw new Error('Choose a judge model in Settings → Projects → AI review.');

  input.onPhase?.('reviewing', `${active.length} reviewers reading the PR`);
  const agents: AgentSummary[] = reviewers
    .filter(([, model]) => !model)
    .map(([lens]) => ({ role: LENSES[lens].label, model: '', status: 'skipped' as const }));

  /** One reviewer, retried once when the failure looks transient (looping, a bad reply, a dropped run). */
  const runLens = async (lens: LensId, model: string): Promise<{ summary: AgentSummary; findings: RawFinding[] | null }> => {
    const role = LENSES[lens].label;
    let usage: RunCost | undefined;
    let durationMs = 0;
    let error = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const run = await runReadOnlyAgent({ apiKey: input.apiKey, model, cwd: input.worktree, prompt: reviewerPrompt(input.ctx, lens), name: `RDS review ${input.ctx.repo}#${input.ctx.prNumber} (${lens})`, signal: input.signal });
        usage = run.usage ? addCost(usage ?? EMPTY_COST, run.usage) : usage;
        durationMs += run.durationMs;
        const findings = run.status === 'finished' ? parseReviewerFindings(run.text) : null;
        if (findings) return { summary: { role, model, status: 'finished', findings: findings.length, durationMs, tokens: usage?.total, usage, toolCalls: run.toolCalls, ...(attempt > 1 ? { retried: true } : {}) }, findings };
        error = run.error ?? 'The reply was not valid JSON.';
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      // A spent quota or a cancel will not get better on a second try.
      if (input.signal?.aborted || isPermanentFailure(error)) break;
    }
    return { summary: { role, model, status: 'error', error, durationMs, tokens: usage?.total, usage }, findings: null };
  };

  const results = await Promise.all(active.map(([lens, model]) => runLens(lens, model)));
  if (input.signal?.aborted) throw new Error('Review cancelled.');

  const byLens: Record<string, RawFinding[]> = {};
  for (const { summary, findings } of results) {
    agents.push(summary);
    if (findings) byLens[summary.role] = findings;
  }
  if (!Object.keys(byLens).length) {
    throw new Error(`Every reviewer failed: ${agents.filter((a) => a.error).map((a) => `${a.role}: ${a.error}`).join('; ')}`);
  }

  input.onPhase?.('judging', 'judge verifying findings in the code');
  const judgeInput = {
    apiKey: input.apiKey,
    model: input.models.judge,
    cwd: input.worktree,
    prompt: judgePrompt(input.ctx, mergeFindings(byLens as unknown as Record<string, Record<string, unknown>[]>), (input.previous?.recheck ?? []).map((f) => ({ id: f.id, title: f.title, detail: f.detail, severity: f.severity, file: f.file, line: f.line }))),
    name: `RDS review ${input.ctx.repo}#${input.ctx.prNumber} (judge)`,
    signal: input.signal,
  };
  const runJudge = () => runReadOnlyAgent(judgeInput).catch((err: unknown) => ({ text: '', status: 'error' as const, error: err instanceof Error ? err.message : String(err), durationMs: 0, tokens: undefined, usage: undefined, toolCalls: undefined }));
  let judgeRun = await runJudge();
  let judgeRetried = false;
  const judgeOk = (r: typeof judgeRun) => r.status === 'finished' && Array.isArray(extractJson<{ findings?: unknown }>(r.text)?.findings);
  // Like the reviewers: one retry for a transient failure (stuck run, bad reply), none for quota or auth.
  if (!judgeOk(judgeRun) && !input.signal?.aborted && !isPermanentFailure(judgeRun.error ?? '')) {
    const first = judgeRun;
    judgeRun = await runJudge();
    judgeRetried = true;
    judgeRun = { ...judgeRun, usage: first.usage ? addCost(first.usage, judgeRun.usage) : judgeRun.usage, durationMs: first.durationMs + judgeRun.durationMs };
  }
  if (input.signal?.aborted) throw new Error('Review cancelled.');

  const judged = judgeRun.status === 'finished' ? extractJson<{ summary?: unknown; reviewBody?: unknown; deviceRecommended?: unknown; deviceReason?: unknown; findings?: unknown }>(judgeRun.text) : null;
  agents.push({
    role: 'judge',
    model: input.models.judge,
    status: judged && Array.isArray(judged.findings) ? 'finished' : 'error',
    error: judged && Array.isArray(judged.findings) ? undefined : judgeRun.error ?? 'The reply was not valid JSON.',
    durationMs: judgeRun.durationMs,
    tokens: judgeRun.tokens?.total,
    usage: judgeRun.usage,
    toolCalls: judgeRun.toolCalls,
    ...(judgeRetried && judgeOk(judgeRun) ? { retried: true } : {}),
  });

  const findings: ReviewFinding[] = [];
  let summary: string;
  let reviewBody: string | undefined;
  let deviceRecommended = false;
  let deviceReason: string | undefined;

  if (judged && Array.isArray(judged.findings)) {
    summary = str(judged.summary) || 'Review finished.';
    reviewBody = str(judged.reviewBody) || undefined;
    deviceRecommended = judged.deviceRecommended === true;
    deviceReason = str(judged.deviceReason) || undefined;
    for (const raw of judged.findings as RawFinding[]) {
      const title = str(raw?.title);
      if (!title) continue;
      const file = str(raw.file) || undefined;
      const severity = severityOf(raw.severity);
      const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence > 1 ? raw.confidence / 100 : raw.confidence)) : undefined;
      const verdict = raw.verdict === 'dismissed' ? 'dismissed' : 'real';
      const needsDevice = raw.needsDevice === true;
      findings.push({
        // A re-checked previous finding keeps its id, so comments and history line up across reviews.
        id: (input.previous?.recheck.some((f) => f.id === str(raw.previousId)) ? str(raw.previousId) : '') || fingerprint(file, title),
        title,
        detail: str(raw.detail),
        severity,
        file,
        line: int(raw.line),
        endLine: int(raw.endLine),
        status: classify({ verdict, needsDevice, severity, confidence }),
        deviceCheck: str(raw.deviceCheck) || undefined,
        confidence,
        reasoning: str(raw.reasoning),
        sources: Array.isArray(raw.sources) ? raw.sources.filter((s): s is string => typeof s === 'string') : [],
        inDiff: file ? changed.has(file) : false,
        comment: verdict === 'real' ? str(raw.comment) || undefined : undefined,
        ...(needsDevice && Array.isArray(raw.tests) ? { tests: raw.tests.filter((t): t is string => typeof t === 'string' && (input.ctx.prTests ?? []).includes(t)) } : {}),
      });
    }
  } else {
    // No judge ruling: show what the reviewers found, but nothing is confirmed.
    summary = `The judge could not finish (${judgeRun.error ?? 'invalid reply'}). Reviewer findings are shown unverified.`;
    for (const [role, list] of Object.entries(byLens)) {
      for (const raw of list) {
        const title = str(raw.title);
        const file = str(raw.file) || undefined;
        findings.push({
          id: fingerprint(file, title),
          title,
          detail: str(raw.detail),
          severity: severityOf(raw.severity),
          file,
          line: int(raw.line),
          endLine: int(raw.endLine),
          status: 'noted',
          deviceCheck: str(raw.deviceCheck) || undefined,
          reasoning: 'Not verified: the judge was unavailable.',
          sources: [role],
          inDiff: file ? changed.has(file) : false,
        });
      }
    }
  }

  // CI annotations are facts: confirmed findings, no judging. They replace an AI finding on the same spot.
  for (const { check, url, annotation: a } of input.ci ? ciFindings(input.ci) : []) {
    const title = a.title?.trim() || a.message.split('\n')[0].slice(0, 120);
    const id = fingerprint(a.path, `ci:${check}:${a.line ?? ''}:${title}`);
    for (let i = findings.length - 1; i >= 0; i--) {
      const f = findings[i];
      if (f.file === a.path && f.line !== undefined && a.line !== undefined && Math.abs(f.line - a.line) <= 2 && f.status !== 'dismissed') findings.splice(i, 1);
    }
    findings.push({
      id,
      title,
      detail: a.message,
      severity: a.level === 'failure' ? 'major' : 'minor',
      file: a.path,
      line: a.line,
      endLine: a.endLine,
      status: 'issue',
      confidence: 1,
      reasoning: `Reported by the CI check "${check}" on this commit.`,
      sources: [`CI: ${check}`],
      inDiff: changed.has(a.path),
      ci: { check, url },
    });
  }

  if (input.previous) {
    const have = new Set(findings.map((f) => f.id));
    // Untouched files: carried as they were. Re-checks the judge skipped: carried rather than lost.
    for (const f of [...input.previous.carry, ...input.previous.recheck.filter((r) => !have.has(r.id))]) {
      if (have.has(f.id)) continue;
      findings.push({ ...f, inDiff: f.file ? changed.has(f.file) : false, reasoning: f.reasoning.startsWith('Carried over') ? f.reasoning : `Carried over from the review at ${input.previous.sinceSha.slice(0, 7)}. ${f.reasoning}`.trim() });
      have.add(f.id);
    }
  }

  if (judged) {
    for (const agent of agents) {
      if (agent.status === 'finished' && agent.role !== 'judge') agent.kept = findings.filter((f) => f.status !== 'dismissed' && f.sources.includes(agent.role)).length;
    }
  }

  const order: Record<FindingStatus, number> = { issue: 0, 'needs-device': 1, noted: 2, dismissed: 3 };
  findings.sort((a, b) => order[a.status] - order[b.status] || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const counts: Record<FindingStatus, number> = { issue: 0, 'needs-device': 0, noted: 0, dismissed: 0 };
  for (const f of findings) counts[f.status]++;

  return {
    headSha: input.headSha,
    startedAt,
    finishedAt: Date.now(),
    summary,
    reviewBody,
    deviceRecommended,
    deviceReason,
    findings,
    counts,
    agents,
    usage: agents.reduce((sum, a) => addCost(sum, a.usage), EMPTY_COST),
    lostLenses: agents.filter((a) => a.status === 'error').map((a) => a.role),
    ...(input.ci
      ? { ci: { checks: input.ci.checks.map((c) => ({ name: c.name, state: c.state, url: c.url, annotations: c.annotations.length })), infra: ciInfraFailures(input.ci).map((c) => c.name), ...(input.ci.error ? { error: input.ci.error } : {}) } }
      : {}),
    ...(input.previous ? { incremental: { sinceSha: input.previous.sinceSha, carried: input.previous.carry.length, rechecked: input.previous.recheck.length } } : {}),
    context: {
      standards: input.ctx.standards.map((s) => s.path),
      wikiPages: input.wikiPages,
      instructions: !!input.ctx.instructions.trim(),
      diffNotes: input.ctx.diffNotes,
      files: input.changedFiles.length,
    },
  };
}
