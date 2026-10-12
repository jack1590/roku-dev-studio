/** One `roku-pkg generate --json` run per project. Spawned without a shell; the password is an arg, never logged. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { applyEvent, buildArgs, createLineSplitter, finishWithoutResult, initialRunState, parseEventLine, type BuildChoice, type RunState } from '../../shared/packager';
import type { CliInfo } from './cli';

export interface StartRunInput {
  cli: CliInfo;
  project: string;
  device: { key: string; name: string; ip: string; password: string };
  build: BuildChoice;
  skipRekey?: boolean;
  packageOnly?: boolean;
  /** SIGKILL a CLI that ignores SIGTERM after this long. */
  killAfterMs?: number;
  /** Batch state updates to at most one per this many ms (a chatty build prints thousands of lines). */
  updateEveryMs?: number;
  onState(state: RunState): void;
  onExit(state: RunState): void;
}

const runs = new Map<string, { state: RunState; kill: () => void; cancelled: boolean }>();
const KILL_AFTER_MS = 10_000;
const UPDATE_EVERY_MS = 150;

export const activeRuns = (): RunState[] => [...runs.values()].map((r) => r.state);

export function startRun(input: StartRunInput): { ok: true; runId: string } | { ok: false; error: string } {
  if ([...runs.values()].some((r) => r.state.project === input.project)) return { ok: false, error: `${input.project} is already generating.` };
  const runId = randomUUID();
  const args = buildArgs(input.project, input.device.ip, input.device.password, input.build, input);
  const child = spawn(input.cli.path, [...input.cli.args, ...args], { cwd: os.homedir(), env: input.cli.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = () => {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, input.killAfterMs ?? KILL_AFTER_MS).unref();
  };
  const entry = { state: initialRunState(runId, input.project, input.device.name, Date.now()), kill, cancelled: false };
  runs.set(runId, entry);
  const stderrTail: string[] = [];
  let finished = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const set = (s: RunState) => {
    entry.state = s;
    pending ??= setTimeout(() => {
      pending = null;
      if (!finished) input.onState(entry.state);
    }, input.updateEveryMs ?? UPDATE_EVERY_MS);
  };

  const out = createLineSplitter((line) => {
    const e = parseEventLine(line) ?? { type: 'log' as const, level: 'info' as const, text: line };
    set(applyEvent(entry.state, e, Date.now()));
  });
  const err = createLineSplitter((line) => {
    stderrTail.push(line);
    if (stderrTail.length > 20) stderrTail.shift();
    set(applyEvent(entry.state, { type: 'log', level: 'error', text: line }, Date.now()));
  });
  child.stdout.setEncoding('utf8').on('data', (c: string) => out.push(c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => err.push(c));

  const finish = () => {
    if (finished) return;
    finished = true;
    if (pending) clearTimeout(pending);
    out.end();
    err.end();
    const final = finishWithoutResult(entry.state, stderrTail, Date.now(), entry.cancelled);
    entry.state = final;
    runs.delete(runId);
    input.onState(final);
    input.onExit(final);
  };
  child.on('close', finish);
  child.on('error', (e) => {
    stderrTail.push(e.message);
    finish();
  });
  return { ok: true, runId };
}

export function cancelRun(runId: string): boolean {
  const r = runs.get(runId);
  if (!r) return false;
  r.cancelled = true;
  r.kill();
  return true;
}
