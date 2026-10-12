/**
 * Fits a PR diff into a prompt budget without hiding what was dropped.
 *
 * Generated, vendored and binary files are left out entirely (the reviewers can still open any
 * file from the checkout); oversized files are truncated; and anything cut is listed so the
 * review can say what it did not see.
 */

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  text: string;
}

export interface BudgetedDiff {
  /** The diff text that goes into the prompt. */
  text: string;
  /** Every changed file, including the ones left out. */
  files: { path: string; additions: number; deletions: number; included: 'full' | 'truncated' | 'omitted'; reason?: string }[];
  /** Human-readable notes about what was left out, for the prompt and the result. */
  notes: string[];
}

const DEFAULT_BUDGET = 150_000;
const PER_FILE_CAP = 30_000;

const SKIP_RULES: { test: RegExp; reason: string }[] = [
  { test: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i, reason: 'lock file' },
  { test: /(^|\/)(node_modules|vendor|third_party|\.yarn)\//i, reason: 'vendored code' },
  { test: /(^|\/)(dist|build|out|staging|\.roku-deploy-staging)\//i, reason: 'build output' },
  { test: /(^|\/)__snapshots__\/|\.snap$/i, reason: 'test snapshot' },
  { test: /\.(map|min\.js|min\.css)$/i, reason: 'generated file' },
  { test: /\.(png|jpe?g|gif|webp|ico|bmp|svgz|pdf|zip|pkg|gz|tgz|jar|woff2?|ttf|otf|eot|mp3|mp4|mov|m4v|wav)$/i, reason: 'binary or media' },
];

/** `.ts` is not listed: it is both TypeScript and MPEG-TS media, and git already flags media as binary. */
function skipReason(file: DiffFile): string | null {
  if (file.binary) return 'binary file';
  return SKIP_RULES.find((rule) => rule.test.test(file.path))?.reason ?? null;
}

/** Split `git diff` output into one entry per file. */
export function splitDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  const lines: string[] = [];
  const flush = () => {
    if (current) {
      current.text = lines.join('\n');
      files.push(current);
    }
    lines.length = 0;
  };
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      current = { path: header[2], additions: 0, deletions: 0, binary: false, text: '' };
    }
    if (!current) continue;
    lines.push(line);
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) current.binary = true;
    else if (line.startsWith('+') && !line.startsWith('+++')) current.additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions++;
  }
  flush();
  return files;
}

export function budgetDiff(diff: string, budget = DEFAULT_BUDGET): BudgetedDiff {
  const files = splitDiff(diff);
  const result: BudgetedDiff = { text: '', files: [], notes: [] };
  const parts: string[] = [];
  let used = 0;
  const omitted: Record<string, string[]> = {};

  for (const file of files) {
    const reason = skipReason(file);
    if (reason) {
      (omitted[reason] ??= []).push(file.path);
      result.files.push({ path: file.path, additions: file.additions, deletions: file.deletions, included: 'omitted', reason });
      continue;
    }
    let text = file.text;
    let included: 'full' | 'truncated' = 'full';
    if (text.length > PER_FILE_CAP) {
      text = `${text.slice(0, PER_FILE_CAP)}\n… (diff for this file truncated; open the file to read the rest)`;
      included = 'truncated';
    }
    if (used + text.length > budget) {
      (omitted['over the size budget'] ??= []).push(file.path);
      result.files.push({ path: file.path, additions: file.additions, deletions: file.deletions, included: 'omitted', reason: 'over the size budget' });
      continue;
    }
    used += text.length;
    parts.push(text);
    result.files.push({ path: file.path, additions: file.additions, deletions: file.deletions, included });
  }

  for (const [reason, paths] of Object.entries(omitted)) {
    result.notes.push(`${paths.length} file(s) left out of the diff (${reason}): ${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ', …' : ''}`);
  }
  const truncated = result.files.filter((f) => f.included === 'truncated').map((f) => f.path);
  if (truncated.length) result.notes.push(`Truncated because they are large: ${truncated.join(', ')}`);
  result.text = parts.join('\n');
  return result;
}

/** One line per changed file, so reviewers know the whole change even when parts of the diff are out. */
export function fileInventory(budgeted: BudgetedDiff): string {
  return budgeted.files
    .map((f) => `- ${f.path} (+${f.additions} −${f.deletions})${f.included === 'full' ? '' : f.included === 'truncated' ? ' [diff truncated]' : ` [not in diff: ${f.reason}]`}`)
    .join('\n');
}
