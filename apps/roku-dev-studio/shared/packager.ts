/**
 * Packager: pure logic shared by main and renderer. Parses `roku-pkg generate --json` output into
 * a run state, masks projects for the window, and validates saves. No Node or Electron imports.
 */

/** 1.2.1: KEY_MISMATCH errors and absolute package paths, which the panel relies on. */
export const MIN_CLI_VERSION = '1.2.1';
export const STEPS = ['home', 'build', 'validate', 'rekey', 'deploy', 'sign', 'save'] as const;
export type PkgStep = (typeof STEPS)[number];
export const STEP_LABELS: Record<PkgStep, string> = {
  home: 'Send device home',
  build: 'Build',
  validate: 'Check build',
  rekey: 'Rekey device',
  deploy: 'Deploy to device',
  sign: 'Sign package',
  save: 'Save to output'
};
export type PkgErrorCode =
  | 'PROJECT_NOT_FOUND' | 'DEVICE_UNREACHABLE' | 'AUTH_FAILED' | 'NEEDS_BUILD_CHOICE'
  | 'TASK_NOT_FOUND' | 'BUILD_FAILED' | 'BUILD_TIMEOUT' | 'INVALID_BUILD' | 'SIGNED_PKG_MISSING'
  | 'REKEY_FAILED' | 'DEPLOY_FAILED' | 'DEPLOY_TIMEOUT' | 'SIGN_FAILED' | 'KEY_MISMATCH' | 'CANCELLED' | 'UNKNOWN';
type StepStatus = 'start' | 'done' | 'skip' | 'fail';
export type PkgEvent =
  | { type: 'step'; step: PkgStep; status: StepStatus; ms?: number; detail?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'result'; ok: true; packagePath: string; sizeBytes: number; version?: string }
  | { type: 'result'; ok: false; step?: PkgStep; code: PkgErrorCode; message: string; hint?: string };
export type PkgResult = Extract<PkgEvent, { type: 'result' }>;

/** A project as roku-pkg stores it. Unknown fields are kept on save. */
export interface CliProject {
  name: string;
  rootDir: string;
  signKey: string;
  signPackageLocation: string;
  outputLocation: string;
  defaultBuildTask?: string;
  [extra: string]: unknown;
}
/** What the window may see of a project: never the sign key. */
export interface ProjectView {
  name: string;
  rootDir: string;
  signPackageLocation: string;
  outputLocation: string;
  defaultBuildTask?: string;
  hasSignKey: boolean;
}
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export interface RunState {
  runId: string;
  project: string;
  deviceName: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'ok' | 'failed' | 'cancelled';
  steps: Record<PkgStep, { state: StepState; ms?: number; detail?: string }>;
  current?: PkgStep;
  /** Last LOG_CAP lines. */
  log: string[];
  result?: PkgResult;
}
export interface HistoryEntry {
  runId: string;
  project: string;
  at: number;
  ok: boolean;
  code?: PkgErrorCode;
  step?: PkgStep;
  message?: string;
  packagePath?: string;
  sizeBytes?: number;
  version?: string;
  /** Build task that ran, if any. */
  buildLabel?: string;
  rekeySkipped?: boolean;
  ms: number;
}
export type BuildChoice = { kind: 'task'; label: string } | { kind: 'existing' } | { kind: 'none' };
export interface SaveInput {
  originalName?: string;
  name: string;
  rootDir: string;
  signPackageLocation: string;
  outputLocation: string;
  defaultBuildTask?: string;
  /** Empty on edit = keep the saved key. */
  signKey?: string;
}

export const LOG_CAP = 2000;
export const HISTORY_PER_PROJECT = 20;

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Stream chunks in, whole lines out (stdout chunks can split a JSON line). */
export function createLineSplitter(onLine: (line: string) => void): { push(chunk: string): void; end(): void } {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? '';
      for (const p of parts) if (p.trim()) onLine(p);
    },
    end() {
      if (buf.trim()) onLine(buf);
      buf = '';
    }
  };
}

const isStep = (v: unknown): v is PkgStep => typeof v === 'string' && (STEPS as readonly string[]).includes(v);

/** Null = not an event (stray output); the caller treats it as a log line. */
export function parseEventLine(line: string): PkgEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const e = o as Record<string, unknown>;
  if (e.type === 'step') return isStep(e.step) && ['start', 'done', 'skip', 'fail'].includes(String(e.status)) ? (e as PkgEvent) : null;
  if (e.type === 'log') return typeof e.text === 'string' ? (e as PkgEvent) : null;
  if (e.type === 'result') return typeof e.ok === 'boolean' ? (e as PkgEvent) : null;
  return null;
}

export function initialRunState(runId: string, project: string, deviceName: string, now: number): RunState {
  const steps = Object.fromEntries(STEPS.map((s) => [s, { state: 'pending' as StepState }])) as RunState['steps'];
  return { runId, project, deviceName, startedAt: now, status: 'running', steps, log: [] };
}

// Build tools colour their output; the log shows plain text.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const pushLog = (log: string[], text: string) => (log.length >= LOG_CAP ? [...log.slice(log.length - LOG_CAP + 1), text] : [...log, text]);

export function applyEvent(state: RunState, e: PkgEvent, now: number): RunState {
  if (e.type === 'log') return { ...state, log: pushLog(state.log, e.text.replace(ANSI, '')) };
  if (e.type === 'step') {
    const map: Record<StepStatus, StepState> = { start: 'running', done: 'done', skip: 'skipped', fail: 'failed' };
    const steps = { ...state.steps, [e.step]: { state: map[e.status], ms: e.ms, detail: e.detail ?? state.steps[e.step].detail } };
    return { ...state, steps, current: e.status === 'start' ? e.step : state.current };
  }
  const status: RunState['status'] = e.ok ? 'ok' : e.code === 'CANCELLED' ? 'cancelled' : 'failed';
  const steps =
    !e.ok && e.step && state.steps[e.step].state !== 'failed'
      ? { ...state.steps, [e.step]: { ...state.steps[e.step], state: 'failed' as StepState } }
      : state.steps;
  return { ...state, steps, status, result: e, endedAt: now };
}

/** The CLI exited without a result event (crash, kill): end the run as UNKNOWN or CANCELLED. */
export function finishWithoutResult(state: RunState, stderrTail: string[], now: number, cancelled: boolean): RunState {
  if (state.result) return state;
  const step = state.current && state.steps[state.current].state === 'running' ? state.current : undefined;
  const result: PkgResult = cancelled
    ? { type: 'result', ok: false, step, code: 'CANCELLED', message: 'Cancelled' }
    : { type: 'result', ok: false, step, code: 'UNKNOWN', message: `roku-pkg stopped without a result.${stderrTail.length ? ` ${stderrTail.slice(-5).join(' | ')}` : ''}` };
  return applyEvent(state, result, now);
}

export function toView(p: CliProject): ProjectView {
  return { name: p.name, rootDir: p.rootDir, signPackageLocation: p.signPackageLocation, outputLocation: p.outputLocation, defaultBuildTask: p.defaultBuildTask, hasSignKey: !!p.signKey };
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const isAbs = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

export function validateSave(input: unknown, existingNames: string[]): { ok: true; value: SaveInput } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Nothing to save.' };
  const i = input as Record<string, unknown>;
  const value: SaveInput = {
    originalName: str(i.originalName) || undefined,
    name: str(i.name),
    rootDir: str(i.rootDir),
    signPackageLocation: str(i.signPackageLocation),
    outputLocation: str(i.outputLocation),
    defaultBuildTask: str(i.defaultBuildTask) || undefined,
    signKey: typeof i.signKey === 'string' ? i.signKey.trim() : undefined
  };
  if (!value.name || value.name.length > 80) return { ok: false, error: 'Give the project a name (up to 80 characters).' };
  if (value.name !== value.originalName && existingNames.includes(value.name)) return { ok: false, error: `A project named "${value.name}" already exists.` };
  if (!isAbs(value.rootDir)) return { ok: false, error: 'Choose the app folder.' };
  if (!isAbs(value.signPackageLocation) || !value.signPackageLocation.endsWith('.pkg')) return { ok: false, error: 'Choose the signed .pkg file.' };
  if (!isAbs(value.outputLocation) || !value.outputLocation.endsWith('.pkg')) return { ok: false, error: 'Choose where to save the package (.pkg).' };
  if (value.outputLocation === value.signPackageLocation) return { ok: false, error: 'Save the package somewhere else: this is the signed package used to rekey the device.' };
  return { ok: true, value };
}

export function mergeProjectSave(existing: CliProject | undefined, input: SaveInput): { ok: true; project: CliProject } | { ok: false; error: string } {
  const signKey = input.signKey || existing?.signKey || '';
  if (!signKey) return { ok: false, error: 'Paste the sign key for this package.' };
  const project: CliProject = {
    ...(existing ?? {}),
    name: input.name,
    rootDir: input.rootDir,
    signPackageLocation: input.signPackageLocation,
    outputLocation: input.outputLocation,
    signKey
  };
  if (input.defaultBuildTask) project.defaultBuildTask = input.defaultBuildTask;
  else delete project.defaultBuildTask;
  return { ok: true, project };
}

/** Args for `roku-pkg`, one element per value: spawned without a shell, so names with spaces or quotes pass unchanged. */
export function buildArgs(name: string, host: string, password: string, build: BuildChoice, opts: { skipRekey?: boolean; packageOnly?: boolean }): string[] {
  const args = ['generate', name, '--json', '--host', host, '--password', password];
  if (build.kind === 'task') args.push('--build-task', build.label);
  else if (build.kind === 'existing') args.push('--use-existing-build');
  else args.push('--skip-build');
  if (opts.skipRekey) args.push('--skip-rekey');
  if (opts.packageOnly) args.push('--package-only');
  return args;
}

export function historyEntry(state: RunState): HistoryEntry {
  const r = state.result;
  const base = {
    runId: state.runId,
    project: state.project,
    at: state.endedAt ?? Date.now(),
    ms: (state.endedAt ?? state.startedAt) - state.startedAt,
    buildLabel: state.steps.build.state === 'done' ? state.steps.build.detail : undefined,
    rekeySkipped: state.steps.rekey.state === 'skipped' || undefined
  };
  if (r?.ok) return { ...base, ok: true, packagePath: r.packagePath, sizeBytes: r.sizeBytes, version: r.version };
  return { ...base, ok: false, code: r && !r.ok ? r.code : 'UNKNOWN', step: r && !r.ok ? r.step : undefined, message: r && !r.ok ? r.message : undefined };
}

/** Plain reasons for the failures people hit most; others read "<step> failed". */
const FAILURE_REASONS: Partial<Record<PkgErrorCode, string>> = {
  KEY_MISMATCH: 'Device keyed for another app',
  AUTH_FAILED: 'Wrong dev password',
  DEVICE_UNREACHABLE: 'Device not reachable',
  SIGNED_PKG_MISSING: 'Signed package missing',
  CANCELLED: 'Cancelled'
};

/** One history row: what came out (or why it failed) and the options that mattered. */
export function historyLabel(h: HistoryEntry): string {
  const extras = [h.ok ? h.buildLabel : undefined, h.rekeySkipped ? 'rekey skipped' : undefined];
  const head = h.ok
    ? [h.version ? `v${h.version}` : '', h.sizeBytes !== undefined ? `${(h.sizeBytes / 1048576).toFixed(1)} MB` : ''].filter(Boolean).join(' · ') || 'Packaged'
    : (h.code && FAILURE_REASONS[h.code]) ?? `${h.step ? STEP_LABELS[h.step] : 'Run'} failed`;
  return [head, ...extras.filter(Boolean)].join(' · ');
}

/** Newest first; at most HISTORY_PER_PROJECT entries per project. */
export function appendHistory(all: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  let count = 0;
  return [entry, ...all].filter((h) => h.project !== entry.project || ++count <= HISTORY_PER_PROJECT);
}

/** Which fix a failed run's error card offers. */
export function fixFor(code: PkgErrorCode | undefined): 'rekey' | 'edit-signing' | 'device' | 'log' | 'retry' {
  // The device is keyed for another app: running again with the rekey fixes it.
  if (code === 'KEY_MISMATCH') return 'rekey';
  if (code === 'REKEY_FAILED' || code === 'SIGNED_PKG_MISSING') return 'edit-signing';
  if (code === 'DEVICE_UNREACHABLE' || code === 'AUTH_FAILED') return 'device';
  if (code === 'BUILD_FAILED' || code === 'BUILD_TIMEOUT' || code === 'INVALID_BUILD' || code === 'TASK_NOT_FOUND' || code === 'NEEDS_BUILD_CHOICE') return 'log';
  return 'retry';
}
