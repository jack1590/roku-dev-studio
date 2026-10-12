/**
 * A project is a company or team: a name plus its own tokens (GitHub, JIRA, Figma).,
 * the GitHub token decides which repos are available: the account's own repos plus every org it
 * belongs to. Projects are stored in the app registry, not in a repo, so no folder is needed.
 *
 * Tokens never live here. They are stored encrypted by `main/project-token-store.ts`.
 */

export const PROJECT_TOKEN_SERVICES = ['github', 'cursor', 'jira', 'figma'] as const;
export type ProjectTokenService = (typeof PROJECT_TOKEN_SERVICES)[number];

export interface ProjectRecord {
  /** Stable key for the project's tokens. Never changes after the project is added. */
  id: string;
  name: string;
  /** Legacy: projects added before multi-org support were keyed by one org login. */
  org?: string;
  /** Non-secret. JIRA base URL, e.g. https://acme.atlassian.net */
  jiraSite?: string;
  /** Non-secret. Account email for JIRA Basic auth (email:token). */
  jiraEmail?: string;
  /** Non-secret. A Figma file/design URL used to test the Figma token. */
  figmaTestUrl?: string;
  /** Repos whose PRs are reviewed, as "owner/name", from any owner the token can see. */
  repos?: string[];
  /** Cursor model id per review role. Missing or empty = not chosen yet. */
  models?: Partial<Record<ModelSlotId, string>>;
  /** Team rules added to every review prompt of this project. Never credentials. */
  reviewInstructions?: string;
  /** Build → deploy → observe cycles a review may run on a device. */
  probeRounds?: number;
  /** Total minutes one review may hold a device before it is released to the queue. */
  deviceMinutes?: number;
  /** After new commits, review only those commits and carry over still-open findings. Default on. */
  incrementalReview?: boolean;
  /** Use the user's LLM Wiki as team knowledge in review prompts. */
  wikiEnabled?: boolean;
  /** Wiki root; "~/" is the home folder. */
  wikiDir?: string;
  /** Extra page tags to include besides project-<repo> and the company tag. */
  wikiTags?: string[];
  /** Groups wiki pages across all of this company's repos and orgs. Empty = company-<project slug>. */
  wikiCompanyTag?: string;
  /** Per repo ("owner/name"): how a device review builds it. Non-secret; the env lives in the keychain store. */
  builds?: Record<string, BuildConfig>;
}

// ---------------------------------------------------------------------------------------------
// Device builds
// ---------------------------------------------------------------------------------------------

export interface BuildConfig {
  /** Shell command run in the build folder, e.g. "npm run generate-code". Empty = no build step. */
  command: string;
  /** Folder (relative to the repo root) that is zipped and sideloaded, e.g. "dist". */
  outDir: string;
  /** Dependency install, e.g. "npm ci". Empty = none. Runs once per lockfile, cached. */
  install: string;
  /** Folder of the repo that holds the Roku project, e.g. "sample-app". Empty = the repo root. Commands run there. */
  rootDir?: string;
  /** Test channel build for device checks, e.g. "npm run test:build". Empty = no device tests for this repo. */
  testCommand?: string;
  /** Folder the test build writes (zipped and sideloaded), e.g. "out/tests-staging". */
  testOutDir?: string;
  /** Where the commands were detected from, for display. */
  detectedFrom?: string;
  /** Set when the user approved these exact commands. Device runs only use approved commands. */
  approvedAt?: number;
  /** Counts only, for display: the env itself is encrypted in the keychain store. */
  envFiles?: number;
  envVars?: number;
}

/** Filled in from the chosen test device at build time; never stored with the pasted env. */
export const DEVICE_ENV_KEYS = ['ROKU_IP', 'ROKU_DEV_PASSWORD', 'ROKU_DEV_USERNAME'] as const;

const ENV_FILE_PATTERN = /^\.env(\.[A-Za-z0-9_-]{1,40})?$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/;

export function parseBuildConfig(raw: unknown): { ok: true; config: BuildConfig } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Invalid build settings.' };
  const input = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const command = text(input.command);
  const install = text(input.install);
  const folder = (v: unknown, fallback: string) => text(v).replace(/^\.\/+/, '').replace(/\/+$/, '') || fallback;
  const outDir = folder(input.outDir, '.');
  const rootDir = folder(input.rootDir, '');
  const testCommand = text(input.testCommand);
  const testOutDir = folder(input.testOutDir, '');
  for (const [label, value] of [['Build command', command], ['Install command', install], ['Test build command', testCommand]] as const) {
    if (value.length > 300 || /[\r\n]/.test(value)) return { ok: false, error: `${label}: one line, up to 300 characters.` };
  }
  const badFolder = (f: string) => f.startsWith('/') || /^[A-Za-z]:/.test(f) || f.split('/').includes('..') || f.length > 200;
  if (badFolder(rootDir)) return { ok: false, error: 'Project folder must be a folder inside the repo.' };
  if (badFolder(outDir)) return { ok: false, error: 'Output folder must be a path inside the repo, like dist.' };
  if (badFolder(testOutDir)) return { ok: false, error: 'Test output folder must be a path inside the repo, like out/tests-staging.' };
  if (testCommand && !testOutDir) return { ok: false, error: 'Add the test output folder (where the test build writes the channel).' };
  return {
    ok: true,
    config: { command, outDir, install, ...(rootDir ? { rootDir } : {}), ...(testCommand ? { testCommand, testOutDir } : {}), ...(typeof input.detectedFrom === 'string' ? { detectedFrom: input.detectedFrom.slice(0, 200) } : {}) },
  };
}

export interface ParsedEnv {
  /** File name → key → value. */
  files: Record<string, Record<string, string>>;
  vars: number;
  /** Device keys that were removed because they come from the test device. */
  removed: string[];
}

/**
 * Parse pasted .env content. Lines `# file: .env.STG` start a new file (the default is `.env`).
 * Accepts `KEY=value`, `export KEY=value`, and quoted values; skips comments and blank lines.
 */
export function parseEnvBulk(text: string): { ok: true; env: ParsedEnv } | { ok: false; error: string } {
  const env: ParsedEnv = { files: {}, vars: 0, removed: [] };
  let file = '.env';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const header = /^#\s*file\s*:\s*(\S+)\s*$/i.exec(line);
    if (header) {
      if (!ENV_FILE_PATTERN.test(header[1])) return { ok: false, error: `Line ${i + 1}: file name must look like .env or .env.STG.` };
      file = header[1];
      continue;
    }
    if (line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match) return { ok: false, error: `Line ${i + 1}: expected KEY=value.` };
    const key = match[1];
    if (!ENV_KEY_PATTERN.test(key)) return { ok: false, error: `Line ${i + 1}: "${key.slice(0, 40)}" is not a valid variable name.` };
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    if ((DEVICE_ENV_KEYS as readonly string[]).includes(key)) {
      if (!env.removed.includes(key)) env.removed.push(key);
      continue;
    }
    (env.files[file] ??= {})[key] = value;
  }
  env.vars = Object.values(env.files).reduce((n, vars) => n + Object.keys(vars).length, 0);
  if (Object.keys(env.files).length > 10) return { ok: false, error: 'Up to 10 env files.' };
  return { ok: true, env };
}

/** One env file's content, quoting values that need it. */
export function serializeEnvFile(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .map(([k, v]) => (/^[A-Za-z0-9_./:@%+,-]*$/.test(v) ? `${k}=${v}` : `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`))
      .join('\n') + '\n'
  );
}

// ---------------------------------------------------------------------------------------------
// AI review settings
// ---------------------------------------------------------------------------------------------

export const MODEL_SLOTS = [
  { id: 'reviewer1', label: 'Reviewer 1', help: 'Correctness: logic errors, edge cases, error paths, async and state bugs.' },
  { id: 'reviewer2', label: 'Reviewer 2', help: 'Security and data: secrets, untrusted input, unsafe defaults, data loss.' },
  { id: 'reviewer3', label: 'Reviewer 3', help: 'Roku platform and maintainability: SceneGraph threads and Task nodes, observers, memory, focus, manifest.' },
  { id: 'judge', label: 'Judge', help: 'Merges the three reviews, checks the code, and decides what needs a device check. Use a strong model.' },
  { id: 'fixer', label: 'Fix writer', help: 'Edits code to fix accepted issues. Used in a later phase.' },
  { id: 'builder', label: 'Builder', help: 'Writes code for JIRA tasks. Leave unset to reuse the fix writer. Used in a later phase.' },
] as const;
export type ModelSlotId = (typeof MODEL_SLOTS)[number]['id'];

/**
 * Recommended Cursor model per role, first available id wins. Reviewers come from three vendors so
 * their reviews are independent; the judge is the strongest Claude; the Roku lens and the fix
 * writer use a strong coding model. GPT-5.6 Luna/Sol/Terra are skipped: Cursor does not describe
 * their tiers.
 */
/**
 * Defaults (reviewers Composer / Claude Sonnet / GPT, Claude Opus as arbiter and fixer)
 * and measured reviews: Sonnet on the Roku lens kept the most findings; Gemini on the security lens
 * cost the most per kept finding, so Composer (Cursor's own, cheaper) takes that lens; a non-Claude
 * judge stalled once, Opus verifies best.
 */
export const RECOMMENDED_MODELS: Record<ModelSlotId, string[]> = {
  reviewer1: ['gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1'],
  reviewer2: ['composer-2.5', 'composer-2', 'gemini-3.1-pro'],
  reviewer3: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'],
  judge: ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'],
  fixer: ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'],
  builder: [],
};

export const REVIEW_LIMITS = {
  probeRounds: { default: 5, min: 1, max: 10 },
  deviceMinutes: { default: 30, min: 5, max: 120 },
} as const;
export const REVIEW_INSTRUCTIONS_MAX = 8000;
export const WIKI_DEFAULTS = { enabled: true, dir: '~/wiki', tags: [] as string[] };
const WIKI_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}$/;
const COMPANY_TAG_PATTERN = /^company-[a-z0-9][a-z0-9-]{0,60}$/;

/** The company tag a project uses when none is set: company-<slug of its name>, e.g. "Acme" → company-acme. */
export function defaultCompanyTag(projectName: string): string {
  return `company-${projectIdFor(projectName)}`;
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,100}$/;
/** Things that look like credentials. Instructions and wiki excerpts go into prompts sent to Cursor. */
const SECRET_IN_TEXT = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|(password|passwd|api[_-]?key|token)\s*[=:]\s*\S{6,})/i;

export function containsSecret(text: string): boolean {
  return SECRET_IN_TEXT.test(text);
}

export interface ReviewSettings {
  models: Partial<Record<ModelSlotId, string>>;
  reviewInstructions: string;
  probeRounds: number;
  deviceMinutes: number;
  incrementalReview: boolean;
  wikiEnabled: boolean;
  wikiDir: string;
  wikiTags: string[];
  wikiCompanyTag: string;
}

/** Wiki fields only, so a preview can validate unsaved values the same way Save does. */
export function parseWikiSettings(input: Record<string, unknown>): { ok: true; wikiEnabled: boolean; wikiDir: string; wikiTags: string[]; wikiCompanyTag: string } | { ok: false; error: string } {
  const wikiEnabled = typeof input.wikiEnabled === 'boolean' ? input.wikiEnabled : WIKI_DEFAULTS.enabled;
  const wikiDir = typeof input.wikiDir === 'string' && input.wikiDir.trim() ? input.wikiDir.trim() : WIKI_DEFAULTS.dir;
  if (wikiDir.length > 300 || /[\r\n]/.test(wikiDir) || !(wikiDir.startsWith('/') || wikiDir.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(wikiDir))) {
    return { ok: false, error: 'Wiki folder must be an absolute path or start with ~/.' };
  }
  const rawTags = Array.isArray(input.wikiTags) ? input.wikiTags : typeof input.wikiTags === 'string' ? input.wikiTags.split(/[\s,]+/) : WIKI_DEFAULTS.tags;
  const wikiTags = [...new Set(rawTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  if (wikiTags.length > 20 || wikiTags.some((t) => !WIKI_TAG_PATTERN.test(t))) {
    return { ok: false, error: 'Wiki tags: up to 20 lowercase tags like project-roku.' };
  }
  const wikiCompanyTag = typeof input.wikiCompanyTag === 'string' ? input.wikiCompanyTag.trim().toLowerCase() : '';
  if (wikiCompanyTag && !COMPANY_TAG_PATTERN.test(wikiCompanyTag)) {
    return { ok: false, error: 'Company tag must look like company-acme.' };
  }
  return { ok: true, wikiEnabled, wikiDir, wikiTags, wikiCompanyTag };
}

function clampInt(raw: unknown, limit: { default: number; min: number; max: number }): number | null {
  if (raw === undefined || raw === null || raw === '') return limit.default;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < limit.min || n > limit.max) return null;
  return n;
}

/** Validate the AI review section. Returns a message, never echoes a detected secret. */
export function parseReviewSettings(raw: unknown): { ok: true; settings: ReviewSettings } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Invalid review settings.' };
  const input = raw as Record<string, unknown>;

  const models: Partial<Record<ModelSlotId, string>> = {};
  const rawModels = typeof input.models === 'object' && input.models !== null ? (input.models as Record<string, unknown>) : {};
  for (const slot of MODEL_SLOTS) {
    const value = rawModels[slot.id];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !MODEL_ID_PATTERN.test(value)) return { ok: false, error: `${slot.label}: invalid model id.` };
    models[slot.id] = value;
  }

  const reviewInstructions = typeof input.reviewInstructions === 'string' ? input.reviewInstructions.replace(/\r\n/g, '\n').trim() : '';
  if (reviewInstructions.length > REVIEW_INSTRUCTIONS_MAX) {
    return { ok: false, error: `Instructions are too long (max ${REVIEW_INSTRUCTIONS_MAX} characters).` };
  }
  if (containsSecret(reviewInstructions)) {
    return { ok: false, error: 'Instructions look like they contain a credential. Remove it: instructions are sent to the AI models.' };
  }

  const probeRounds = clampInt(input.probeRounds, REVIEW_LIMITS.probeRounds);
  if (probeRounds === null) return { ok: false, error: `Probe rounds must be ${REVIEW_LIMITS.probeRounds.min}–${REVIEW_LIMITS.probeRounds.max}.` };
  const deviceMinutes = clampInt(input.deviceMinutes, REVIEW_LIMITS.deviceMinutes);
  if (deviceMinutes === null) return { ok: false, error: `Device time must be ${REVIEW_LIMITS.deviceMinutes.min}–${REVIEW_LIMITS.deviceMinutes.max} minutes.` };

  const incrementalReview = typeof input.incrementalReview === 'boolean' ? input.incrementalReview : true;

  const wiki = parseWikiSettings(input);
  if (!wiki.ok) return wiki;
  return { ok: true, settings: { models, reviewInstructions, probeRounds, deviceMinutes, incrementalReview, wikiEnabled: wiki.wikiEnabled, wikiDir: wiki.wikiDir, wikiTags: wiki.wikiTags, wikiCompanyTag: wiki.wikiCompanyTag } };
}

const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Validate "owner/name" entries, de-duplicated and sorted. Any owner is allowed. */
export function parseRepoList(raw: unknown): { ok: true; repos: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'Repos must be a list.' };
  const repos = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || !REPO_FULL_NAME_PATTERN.test(item)) return { ok: false, error: 'Invalid repo name.' };
    repos.add(item);
  }
  return { ok: true, repos: [...repos].sort((a, b) => a.localeCompare(b)) };
}

/** Settings fields a row can save alongside its token. */
export const PROJECT_SETTING_KEYS = ['jiraSite', 'jiraEmail', 'figmaTestUrl'] as const;
export type ProjectSettingKey = (typeof PROJECT_SETTING_KEYS)[number];

export function parseJiraSite(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim().replace(/\/+$/, '');
  let isHttps = false;
  try {
    isHttps = new URL(value).protocol === 'https:';
  } catch {
    isHttps = false;
  }
  return isHttps ? { ok: true, value } : { ok: false, error: 'JIRA site must be an https URL, e.g. https://acme.atlassian.net.' };
}

export function parseJiraEmail(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? { ok: true, value } : { ok: false, error: 'Enter the JIRA account email.' };
}

/** Accepts figma.com /file/, /design/ or /proto/ URLs and returns the file key. */
export function parseFigmaTestUrl(raw: string): { ok: true; value: string; fileKey: string } | { ok: false; error: string } {
  const value = raw.trim();
  let host = '';
  try {
    host = new URL(value).hostname;
  } catch {
    return { ok: false, error: 'Enter a Figma file URL.' };
  }
  if (!/(^|\.)figma\.com$/i.test(host)) return { ok: false, error: 'Enter a figma.com URL.' };
  const match = /figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/.exec(value);
  if (!match) return { ok: false, error: 'The Figma URL must point to a file or design (figma.com/design/…).' };
  return { ok: true, value, fileKey: match[1] };
}

export type ProjectInputResult = { ok: true; name: string } | { ok: false; error: string };

/** Lowercase slug of the name, used as the id of a new project. */
export function projectIdFor(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

/** Validate the Add/Edit project form. Returns a message, never a token. */
export function parseProjectInput(raw: unknown): ProjectInputResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Invalid project.' };
  const name = typeof (raw as Record<string, unknown>).name === 'string' ? ((raw as Record<string, unknown>).name as string).trim() : '';
  if (!name || name.length > 80) return { ok: false, error: 'Enter a project name (1–80 characters).' };
  return { ok: true, name };
}
