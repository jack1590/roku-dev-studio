/**
 * Prompts for the three reviewers and the judge. Written for Roku (BrightScript / SceneGraph)
 * codebases. Each reviewer gets one lens so three models buy three perspectives; the judge
 * verifies against the checkout, and anything the code alone cannot settle is marked for a device
 * check instead of being reported as fact.
 */

import type { StandardsFile } from './git';

export type LensId = 'correctness' | 'security' | 'roku';

export const LENSES: Record<LensId, { label: string; brief: string }> = {
  correctness: {
    label: 'correctness',
    brief: `Your lens is CORRECTNESS. Hunt for code that does the wrong thing: inverted or incomplete conditions, off-by-one and boundary errors, unhandled invalid/empty values (BrightScript \`invalid\`, missing AA keys, empty arrays), wrong types compared or coerced (string vs integer, Integer vs Float division), error paths that leave state half-updated, silent failure paths (input rejected or an operation failing with no log, message or fallback the user or developer can see; return values that callers ignore), wrong order of operations, and broken contracts with callers the diff did not update. Trace real values through the changed code instead of reading it for plausibility.`,
  },
  security: {
    label: 'security & data',
    brief: `Your lens is SECURITY AND DATA. Hunt for secrets, tokens or credentials in code, logs or analytics; untrusted input (deep-link params, API responses, registry values) used without validation; unsafe URL building or string concatenation into requests; personal data logged or sent where it should not be; registry/storage writes that can corrupt or lose user data; unbounded reads or downloads; and anything that widens what a caller or deep link is allowed to do. If the diff touches none of these surfaces (deep-link or input params, network requests, registry/storage, logging/analytics, auth, secrets), review the diff itself and reply without exploring the repository.`,
  },
  roku: {
    label: 'Roku platform & maintainability',
    brief: `Your lens is the ROKU PLATFORM and MAINTAINABILITY. Check the change against how SceneGraph actually runs:
- Threads: blocking work (roUrlTransfer sync calls, sleep, wait on ports, heavy loops, file IO) must not run on the render thread. Task nodes must be started and stopped deliberately (control = "RUN" / "STOP"). Reading or writing render-thread node fields from a Task causes a rendezvous; flag rendezvous inside loops or on hot paths.
- Observers: observeField / observeFieldScoped must be paired with unobserve when the owner goes away or re-initialises; re-observing without unobserving fires callbacks more than once. Watch m.global field churn and observers on fields that change every frame.
- Node lifecycle and memory: removed children still referenced from m or fields, components holding their own m in cycles, timers not stopped, Video and ContentNode trees that only grow, screens pushed without being torn down.
- Focus and keys: setFocus after dialogs, overlays and screen changes; onKeyEvent returning true only when the key was handled; back-key behaviour; deep-link entry paths.
- Playback: Video state transitions, content metadata, bookmarks/resume, and ad integrations (RAF must run in a Task with its own message port).
- Manifest and config: version bumps, bs_const flags, ui_resolutions, assets.
- BrightScript pitfalls: case-insensitive field names, AA iteration order, invalid vs uninitialized, crashes in Run/init paths.
Then maintainability: duplicated logic, misleading names, dead code, and changes that break callers or conventions this repository declares (say which rule or file establishes it).`,
  },
};

export interface PromptContext {
  repo: string;
  prNumber: number;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  inventory: string;
  diffNotes: string[];
  diff: string;
  standards: StandardsFile[];
  wikiBlock: string;
  instructions: string;
  /** Re-review after new commits: the diff shows only the commits since this head. */
  sinceSha?: string;
  /** Current content of changed files, for small PRs, so agents need not open them. */
  files?: { path: string; text: string }[];
  /** What CI says about the head commit (see ci.ts). */
  ciBlock?: string;
  /** Test files this PR adds or changes; the only tests a device check may run. */
  prTests?: string[];
}

const READ_ONLY = `You can read any file in the repository (it is your working directory) with your read, grep, glob, ls and search tools. You cannot run commands or edit files. Read the code around each change before judging it: a finding confirmed by reading the code is worth far more than one inferred from the diff.
Read economically, it costs on every later turn: find the spot first (grep or search), then read only the line range you need instead of the whole file; read a whole file only when it is short or you truly need all of it. Never re-read what you already have, including the changed files shown below.`;

const SEVERITY = `Severity: "critical" = crash, data loss, security hole, or broken playback for users; "major" = wrong behaviour users will notice; "minor" = real but limited impact (edge case, maintainability cost); "info" = an observation worth knowing, not a problem.`;

const LOCATION = `Location: "file" is the repository-relative path exactly as the diff spells it, "line" (and optional "endLine") a line number in the NEW version of the file. Point at a changed line whenever you can.`;

/** Reading discipline: input tokens (agents re-reading the repo) are almost all of a review's cost. */
const FOCUS = `Work from the diff. Open a file only to check a specific suspicion: the changed files, and the callers or callees of what changed. Do not survey the repository or read files unrelated to the change. Batch lookups (one grep for several names) instead of many single searches. Stop once your lens has nothing more to find in this change.`;

const NOISE = `Do not report: style or formatting preferences that no repository rule requires, restatements of what the diff obviously does, praise, or the same problem twice.`;

function prBlock(ctx: PromptContext): string {
  const body = ctx.body.trim() ? ctx.body.trim().slice(0, 4000) : '(no description)';
  return `Repository: ${ctx.repo}
Pull request #${ctx.prNumber} by ${ctx.author}: ${ctx.title}
Branch: ${ctx.headRef} → ${ctx.baseRef}

PR description:
${body}`;
}

function standardsBlock(ctx: PromptContext): string {
  if (!ctx.standards.length) {
    return `Repository standards: none found (no AGENTS.md, CLAUDE.md, .cursor/rules, CONTRIBUTING.md, bsconfig.json or bslint.json). Use widely accepted Roku/BrightScript practice; do not invent house rules.`;
  }
  return `Repository standards (read from the checkout; hold the change to these and name the rule when you cite one):
${ctx.standards.map((f) => `### ${f.path}\n${f.text}`).join('\n\n')}`;
}

function teamBlock(ctx: PromptContext): string {
  const parts: string[] = [];
  if (ctx.instructions.trim()) parts.push(`## Team instructions (from the project settings; follow them)\n${ctx.instructions.trim()}`);
  if (ctx.wikiBlock.trim()) parts.push(ctx.wikiBlock.trim());
  return parts.join('\n\n');
}

function changeBlock(ctx: PromptContext): string {
  const notes = ctx.diffNotes.length ? `\nNot fully shown below (open the files if you need them):\n${ctx.diffNotes.map((n) => `- ${n}`).join('\n')}` : '';
  const scope = ctx.sinceSha
    ? `This is a re-review after new commits. The diff below is ONLY the commits since ${ctx.sinceSha.slice(0, 7)}, which was already reviewed; review those changes and the code they affect, not the rest of the PR. The whole PR diff is in .rds-review/pr.diff if you need context.`
    : `The whole PR diff is also in .rds-review/pr.diff, uncut, if something below is shortened.`;
  return `${scope}

Changed files${ctx.sinceSha ? ' in the new commits' : ''}:
${ctx.inventory}${notes}

--- DIFF ---
${ctx.diff}
--- END DIFF ---${filesBlock(ctx)}`;
}

function filesBlock(ctx: PromptContext): string {
  if (!ctx.files?.length) return '';
  const numbered = (text: string) => text.split('\n').map((line, i) => `${i + 1}| ${line}`).join('\n');
  return `

Current content of the changed files (line-numbered, NEW version). Use these instead of opening them:
${ctx.files.map((f) => `--- FILE ${f.path} ---\n${numbered(f.text)}`).join('\n')}
--- END FILES ---`;
}

/** Everything the reviewers and the judge share, first, so same-model agents reuse the provider's prompt cache. */
function sharedContext(ctx: PromptContext): string {
  return `${prBlock(ctx)}

${standardsBlock(ctx)}

${teamBlock(ctx)}

${changeBlock(ctx)}
${ctx.ciBlock ? `\n${ctx.ciBlock}\n` : ''}
${READ_ONLY}`;
}

export function reviewerPrompt(ctx: PromptContext, lens: LensId): string {
  return `${sharedContext(ctx)}

=== YOUR TASK ===
You are an expert Roku (BrightScript / SceneGraph) code reviewer. Review the pull request above and report actionable findings only.

${LENSES[lens].brief}
Your lens says what to hunt for, not what you may report: if you notice something serious outside it, report it anyway.

${FOCUS}

Do not guess about runtime behaviour. If a problem depends on timing, threads, rendering, focus, playback or memory over time and you cannot prove it from the code, still report it, but say exactly what would confirm it on a device in "deviceCheck".

${SEVERITY}
${LOCATION}
${NOISE}

Reply with ONE JSON object and nothing else:
{"findings":[{"severity":"info|minor|major|critical","file":"path","line":1,"endLine":1,"title":"short summary","detail":"what is wrong, why, and the fix","evidence":"the decisive code, quoted: path:line then up to 10 lines, from the diff or files you read (also the caller or helper that matters)","deviceCheck":"optional: what to observe on a device to confirm"}]}
If the change looks good, reply {"findings":[]}.`;
}

/** A finding from the previous review that the new commits may have fixed. */
export interface PreviousFinding {
  id: string;
  title: string;
  detail: string;
  severity: string;
  file?: string;
  line?: number;
}

export function judgePrompt(ctx: PromptContext, findings: unknown[], previous: PreviousFinding[] = []): string {
  return `${sharedContext(ctx)}

=== YOUR TASK ===
You are a senior Roku engineer acting as the judge over three independent AI code reviews of the pull request above. Each reviewer had a different lens. Findings that several reviewers raised are already merged ("raisedBy" lists them); merge any remaining duplicates, verify each finding against the code, and rule.

Your job is to verify, not to review the PR again. Each finding carries "evidence": the code its reviewer quoted. Rule from that evidence, the diff and the changed files first. Open other files only when they do not settle it: a finding with no or partial evidence, or one whose truth depends on code outside the quote (a caller that may already validate, a helper that may handle invalid, an observer that may be unobserved elsewhere). Most false positives come from exactly that, so check those before ruling real. Do not hunt for new issues; add one only if you meet a serious problem while verifying.

No speculation. For each finding decide:
- "verdict": "real" when the code proves it, "dismissed" when the code disproves it or it is not worth acting on (say why).
- "needsDevice": true when it is plausible but its truth depends on runtime behaviour you cannot prove by reading code (threads and rendezvous, races and timing, rendering and layout, focus and key handling, playback state, memory growth, real API responses). A needsDevice finding is not reported as fact until a device run confirms it, so set it instead of guessing. Give "deviceCheck": the exact behaviour to observe and what evidence settles it (e.g. a console print to add and the value expected, a key sequence and the screen expected).
- "tests": for a needsDevice finding only, the test files of THIS PR that exercise it (from the list below), so a device run can execute them. Leave it empty when none does. Never ask for or plan new tests here; when a missing test matters, say so in the finding's comment instead.
- "confidence": 0 to 1, how sure you are after reading the code. 0.9+ only when you verified it.
Also say whether the whole PR deserves a manual device check even with no specific finding ("deviceRecommended"; shown to the reader, nothing runs automatically). A device run costs minutes on a shared TV, so keep it for real risk: true only when the change alters runtime behaviour in threading, playback, focus/navigation, deep links, app startup, or memory-sensitive screens AND there is a concrete behaviour that reading the code cannot settle. False for docs, tests, config, styling-only, renames, or small changes whose effect the code makes clear. When true, "deviceReason" names the exact behaviour to observe.

Write the GitHub comments a human reviewer would post:
- "comment" on every finding you keep (verdict "real"): the exact text of an inline PR comment on that file and line. Follow the comment style in the team instructions when there is one. Otherwise: pointed and specific, one concrete ask ("Could we …?") rather than a list, no praise or filler. Write as a teammate: never mention AI, a judge, reviewers, lenses or confidence. For a needsDevice finding, phrase it as something to verify, not as fact.
- "reviewBody": the overall review comment for the PR, 1 to 4 short sentences or bullets in the same style, or "" when there is nothing to say beyond the inline comments.

${SEVERITY}
${LOCATION} Carry the location from the finding you kept and correct it against the diff when it is wrong.

Test files in this PR: ${ctx.prTests?.length ? ctx.prTests.join(', ') : 'none (so no device test can run; do not set "tests")'}

Reviewer findings (JSON; "raisedBy" = the lenses that raised it; copy it to "sources"):
${JSON.stringify(findings, null, 2)}
${previous.length ? `
Still-open findings from the previous review, in files the new commits touched (JSON). Check each against the current code and return it in "findings" with "previousId" set to its id: verdict "real" if it is still there (update the location), "dismissed" with reasoning starting "Fixed in the new commits:" if the commits fixed it. Do not drop any of them.
${JSON.stringify(previous, null, 2)}
` : ''}
Reply with ONE JSON object and nothing else:
{"summary":"2-4 sentences on the PR overall","reviewBody":"overall PR comment, or empty","deviceRecommended":false,"deviceReason":"why, if recommended","findings":[{"title":"short summary","detail":"what is wrong and the fix","severity":"info|minor|major|critical","file":"path","line":1,"endLine":1,"verdict":"real|dismissed","needsDevice":false,"deviceCheck":"","tests":[],"confidence":0.0,"reasoning":"what you read in the code that decides it","sources":["lens labels that raised it"],"comment":"the inline GitHub comment text (verdict real only)","previousId":"only for a previous finding"}]}`;
}
