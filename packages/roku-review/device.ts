/**
 * Device check: runs the PR's own unit tests on a real Roku when a finding needs proof that reading
 * code (and CI) cannot give. Nothing is written or planned by AI: the judge names which test files
 * of the PR exercise a finding; this builds the repo's test channel in an isolated copy (other
 * test-named files removed so only those run), sideloads it, captures the BrightScript console until
 * the framework prints its result, and the judge rules on that output.
 *
 * Project-agnostic: the test build command and output folder are per-repo settings; test files are
 * recognised by name (*.spec.*, *.test.*); the result line is recognised for common Roku frameworks,
 * otherwise the run ends when the console goes quiet or the device time runs out.
 *
 * Secrets: the device password and env values exist only in the build copy and in this process.
 * Console output and build logs are redacted before they are stored or shown to the AI.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import type { Socket } from 'net';
import { REVIEW_DIR } from './git';
import { addCost, EMPTY_COST, extractJson, runReadOnlyAgent, type RunCost , type AgentBackend } from './agent';
import type { PromptContext } from './prompts';
import type { ReviewFinding } from './review';

interface RokuApi {
  sideloadChannel(o: { ip: string; zipData: Buffer; filename?: string; password: string }): Promise<{ success: boolean; error?: string }>;
  connectRokuDebugTelnet(ip: string, o?: { connectTimeoutMs?: number }): Promise<{ success: boolean; socket?: Socket; error?: string }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const roku = require('roku-dev-studio-api') as RokuApi;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip') as new () => { addLocalFolder(dir: string): void; toBuffer(): Buffer };

const CONSOLE_EXCERPT_CHARS = 10_000;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
/** No new console output for this long after some output means the test run is over. */
const QUIET_MS = 25_000;

/** BrightScript test files by name, whatever the folder layout: foo.spec.bs, foo.test.brs (never configs like bsconfig.test.json). */
export const TEST_FILE = /\.(spec|test)\.(bs|brs)$/i;

/** Result lines of common Roku test frameworks (Rooibos 5, Rooibos 4 / roca style). */
const RESULT_LINE = /\[Rooibos Result\]:\s*(PASS|FAIL)|^\s*RESULT:\s*(Success|Fail)/im;

/** PASS / FAIL from a test console, or undefined when no known result line was printed. */
/** @internal exported for verify-review.ts */
export function testResult(consoleText: string): 'PASS' | 'FAIL' | undefined {
  const m = RESULT_LINE.exec(consoleText);
  if (!m) return undefined;
  return /pass|success/i.test(m[1] ?? m[2] ?? '') ? 'PASS' : 'FAIL';
}

export interface DeviceRound {
  index: number;
  goal: string;
  /** PR test files that ran. */
  tests: string[];
  /** Framework result line, when one was printed. */
  result?: 'PASS' | 'FAIL';
  build: 'ok' | 'failed' | 'skipped';
  sideload: 'ok' | 'failed' | 'skipped';
  error?: string;
  /** Redacted build output tail, when the build failed. */
  buildLog?: string;
  /** Redacted console excerpt: test results, errors, and the tail. */
  console: string;
  outcomes: { id: string; outcome: 'confirmed' | 'refuted' | 'inconclusive'; evidence: string }[];
  /** The judge's summary of the run up to this round. */
  summary?: string;
}

export interface DeviceReport {
  status: 'done' | 'blocked' | 'failed' | 'timeout' | 'cancelled';
  reason?: string;
  device?: { name: string; ip: string };
  rounds: DeviceRound[];
  startedAt?: number;
  finishedAt?: number;
  /** One paragraph: what the run set out to test and the result. From the judge's last ruling. */
  summary?: string;
  /** Tokens and cost of the ruling agent. */
  usage?: RunCost;
}

export interface DeviceRunInput {
  apiKey: string;
  backend?: AgentBackend;
  judgeModel: string;
  ctx: PromptContext;
  worktree: string;
  repo: string;
  prNumber: number;
  /** The repo's test build: command, output folder (must hold a manifest), install command, and the
   * project folder inside the repo they run in ('' = root). */
  test: { command: string; outDir: string; install: string; root?: string };
  /** File name → variables, from the repo's saved build env. */
  envFiles: Record<string, Record<string, string>>;
  device: { name: string; ip: string; password: string };
  dataDir: string;
  /** PATH for the build commands. The app started from Finder or the Dock lacks the shell's PATH (npm, nvm), so the caller passes the login shell's. */
  shellPath?: string;
  findings: ReviewFinding[];
  deadline: number;
  signal?: AbortSignal;
  onProgress?: (detail: string) => void;
}

const slug = (repo: string) => repo.replace('/', '__');

/** @internal exported for verify-review.ts */
export function makeRedactor(secrets: string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((s) => s && s.length >= 6))].sort((a, b) => b.length - a.length);
  return (text) =>
    values
      .reduce((out, value) => out.split(value).join('•••'), text)
      // Secrets we were never told about (keys the build downloads, tokens the app logs): JWTs and
      // values of anything named like a key, token, secret or auth header.
      .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '•••')
      .replace(/((?:[\w-]*(?:key|token|secret|auth|jwt|password|signature|cookie)[\w-]*)["']?\s*[:=]\s*["']?(?:Bearer\s+|token\s+)?)[^\s'",;&]{6,}/gi, '$1•••');
}

/** Values of every .env* file in a folder (e.g. ones the build generated), for redaction. */
async function envFileValues(dir: string): Promise<string[]> {
  const values: string[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!/^\.env(\..+)?$/.test(name)) continue;
    const text = await fs.readFile(path.join(dir, name), 'utf-8').catch(() => '');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?[A-Za-z_][\w]*\s*=\s*(.*)$/.exec(line);
      if (m) values.push(m[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
    }
  }
  return values;
}

function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // No stdin: an interactive prompt (e.g. "overwrite? [y/N]") gets EOF instead of hanging until the timeout.
    const child = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', command] : ['-c', command], { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-20_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}

function serializeEnv(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => (/^[A-Za-z0-9_./:@%+,-]*$/.test(v) ? `${k}=${v}` : `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`))
    .join('\n') + '\n';
}

/** A fresh copy of the checkout without .git or node_modules: the only place secrets and probe prints go. */
async function prepareBuildDir(input: DeviceRunInput, buildDir: string): Promise<void> {
  await fs.rm(buildDir, { recursive: true, force: true });
  await fs.cp(input.worktree, buildDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(input.worktree, src);
      const first = rel.split(path.sep)[0];
      return first !== '.git' && first !== 'node_modules' && first !== REVIEW_DIR;
    },
  });
  const files = { ...input.envFiles };
  files['.env'] = { ...(files['.env'] ?? {}), ROKU_IP: input.device.ip, ROKU_DEV_PASSWORD: input.device.password, ROKU_DEV_USERNAME: 'rokudev' };
  const projectDir = path.resolve(buildDir, input.test.root ?? '');
  for (const [name, vars] of Object.entries(files)) await fs.writeFile(path.join(projectDir, name), serializeEnv(vars), { encoding: 'utf-8', mode: 0o600 });
}

/** Remove every test-named file except the ones to run, so the test channel runs only those. Helpers stay. */
async function keepOnlyTests(buildDir: string, keep: string[]): Promise<number> {
  const wanted = new Set(keep.map((p) => path.resolve(buildDir, p)));
  let removed = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) await walk(abs);
      } else if (TEST_FILE.test(entry.name) && !wanted.has(abs)) {
        await fs.rm(abs, { force: true });
        removed++;
      }
    }
  };
  await walk(buildDir);
  return removed;
}

/** node_modules cached per repo and lockfile: install once, link from then on. */
async function linkDependencies(input: DeviceRunInput, buildDir: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; log: string }> {
  if (!input.test.install) return { ok: true, log: '' };
  // Install and link inside the project folder of the repo.
  buildDir = path.resolve(buildDir, input.test.root ?? '');
  const lock = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'package.json'].find((f) => existsSync(path.join(buildDir, f)));
  if (!lock) return { ok: true, log: '' };
  const hash = createHash('sha256').update(await fs.readFile(path.join(buildDir, lock))).digest('hex').slice(0, 16);
  const cache = path.join(input.dataDir, 'deps', slug(input.repo) + (input.test.root ? `__${input.test.root.replace(/[^\w-]/g, '_')}` : ''), hash, 'node_modules');
  if (!existsSync(cache)) {
    input.onProgress?.(`installing dependencies (${input.test.install}); cached for next time`);
    const result = await runShell(input.test.install, buildDir, env, BUILD_TIMEOUT_MS, input.signal);
    if (!result.ok) return { ok: false, log: result.output };
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.rename(path.join(buildDir, 'node_modules'), cache);
  }
  await fs.symlink(cache, path.join(buildDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return { ok: true, log: '' };
}

function evidencePrompt(input: DeviceRunInput, pending: ReviewFinding[], round: DeviceRound): string {
  return `You are the judge of a Roku PR review. To settle findings that reading code could not, the PR's own unit tests that exercise them were run on a real Roku. Rule on each finding using ONLY this evidence; the PR is checked out in your working directory if you need to reread code or tests.

Pull request #${input.prNumber} in ${input.repo}: ${input.ctx.title}

Findings to settle (with the PR tests named for each):
${JSON.stringify(pending.map((f) => ({ id: f.id, title: f.title, file: f.file, line: f.line, detail: f.detail, tests: f.tests, comment: f.comment })), null, 2)}

Test run: ${round.tests.join(', ')}. Build: ${round.build}. Sideload: ${round.sideload}. Framework result: ${round.result ?? 'no result line seen'}.${round.error ? ` Error: ${round.error}` : ''}
BrightScript console (secrets redacted as •••):
--- CONSOLE ---
${round.console || '(no output captured)'}
--- END CONSOLE ---

For each finding: "confirmed" when a failing assertion or crash shows the problem, "refuted" when the tests that exercise it pass on the device, "inconclusive" when the run did not reach it or the tests do not really cover it (say so). Quote the decisive console lines in "evidence" (trimmed, a few lines). For a confirmed finding, rewrite "comment" as the GitHub comment to post, in the team's comment style, with a short trimmed excerpt. Report a crash or BrightScript error in changed code as a new finding in "newFindings".
Also write "summary": ONE short paragraph (2 to 4 sentences, plain words, no log lines, no secrets): which PR tests ran on the device, what they showed, and the result for each finding.

Reply with ONE JSON object and nothing else:
{"summary":"one paragraph","outcomes":[{"id":"finding id","outcome":"confirmed|refuted|inconclusive","evidence":"log lines","comment":"updated comment (confirmed only)"}],"newFindings":[{"title":"","detail":"","severity":"minor|major|critical","file":"","line":1,"evidence":"","comment":""}]}`;
}

/** Test results, errors, crashes, and the tail of the console. */
/** @internal exported for verify-review.ts */
export function excerptConsole(raw: string): string {
  // Long lines (apps log whole requests) are cut so they cannot crowd out the probe lines.
  // eslint-disable-next-line no-control-regex
  const lines = raw.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
  const important = lines.filter((l) => /\[RDS-PROBE\]|\[Rooibos|RESULT:|\bFAIL(ED|URE)?\b|Assert|expected|BRIGHTSCRIPT: ERROR|Runtime Error|Backtrace|crash|STOP \(runtime|Type Mismatch|Invalid value|Member function not found|-------> |scrpt\.ctx\.run\.(enter|exit)/i.test(l));
  // Important lines first and kept whole up to 60% of the budget; the tail gets the rest.
  const head = [...new Set(important)].join('\n').slice(0, Math.floor(CONSOLE_EXCERPT_CHARS * 0.6));
  const tail = lines.slice(-80).filter((l) => !important.includes(l)).join('\n');
  const room = CONSOLE_EXCERPT_CHARS - head.length - 20;
  return `${head}\n… last lines …\n${tail.length > room ? tail.slice(-room) : tail}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export async function runDeviceVerification(input: DeviceRunInput): Promise<{ report: DeviceReport; findings: ReviewFinding[] }> {
  const report: DeviceReport = { status: 'done', device: { name: input.device.name, ip: input.device.ip }, rounds: [], startedAt: Date.now() };
  const findings = input.findings.map((f) => ({ ...f }));
  const pending = findings.filter((f) => f.status === 'needs-device' && f.tests?.length);
  const tests = [...new Set(pending.flatMap((f) => f.tests ?? []))];
  const secrets = [input.device.password, ...Object.values(input.envFiles).flatMap((vars) => Object.values(vars))];
  let redact = makeRedactor(secrets);
  const buildDir = path.join(input.dataDir, 'builds', `${slug(input.repo)}__pr${input.prNumber}`);
  const envVars = Object.assign({}, ...Object.values(input.envFiles));
  const env: NodeJS.ProcessEnv = { ...process.env, ...(input.shellPath ? { PATH: input.shellPath } : {}), ...envVars, ROKU_IP: input.device.ip, ROKU_DEV_PASSWORD: input.device.password, ROKU_DEV_USERNAME: 'rokudev', CI: '1' };
  const round: DeviceRound = { index: 1, goal: `Run the PR tests that exercise ${pending.length} finding(s)`, tests, build: 'skipped', sideload: 'skipped', console: '', outcomes: [] };
  report.rounds.push(round);

  try {
    input.onProgress?.(`building the test channel (${tests.length} PR test file(s))`);
    await prepareBuildDir(input, buildDir);
    await keepOnlyTests(buildDir, tests);
    const projectDir = path.resolve(buildDir, input.test.root ?? '');
    if (!projectDir.startsWith(buildDir)) throw new Error('Invalid project folder.');
    const deps = await linkDependencies(input, buildDir, env);
    if (!deps.ok) {
      round.build = 'failed';
      round.error = 'Installing dependencies failed.';
      round.buildLog = redact(deps.log).slice(-6000);
      report.status = 'failed';
      report.reason = round.error;
      return { report, findings };
    }
    if (input.test.command) {
      const built = await runShell(input.test.command, projectDir, env, Math.min(BUILD_TIMEOUT_MS, Math.max(60_000, input.deadline - Date.now())), input.signal);
      // The build may download more env (e.g. generate-envs); never let those values out either.
      redact = makeRedactor([...secrets, ...(await envFileValues(buildDir))]);
      if (!built.ok) {
        round.build = 'failed';
        round.error = 'The test build failed.';
        round.buildLog = redact(built.output).slice(-6000);
        report.status = 'failed';
        report.reason = round.error;
        return { report, findings };
      }
    }
    round.build = 'ok';
    const outDir = path.resolve(projectDir, input.test.outDir);
    if (!outDir.startsWith(buildDir) || !existsSync(path.join(outDir, 'manifest'))) {
      round.build = 'failed';
      round.error = `No manifest in the test output folder "${input.test.outDir}".`;
      report.status = 'failed';
      report.reason = round.error;
      return { report, findings };
    }
    const zip = new AdmZip();
    zip.addLocalFolder(outDir);

    // Console first, so the whole test run is captured.
    let consoleRaw = '';
    let lastOutput = Date.now();
    const telnet = await roku.connectRokuDebugTelnet(input.device.ip, { connectTimeoutMs: 5000 });
    telnet.socket?.on('data', (chunk: Buffer) => {
      consoleRaw = (consoleRaw + chunk.toString()).slice(-2_000_000);
      lastOutput = Date.now();
    });
    try {
      input.onProgress?.(`sideloading the test channel to ${input.device.name}`);
      const sideload = await roku.sideloadChannel({ ip: input.device.ip, zipData: zip.toBuffer(), filename: 'rds-tests.zip', password: input.device.password });
      if (!sideload.success) {
        round.sideload = 'failed';
        round.error = `Sideload failed: ${sideload.error ?? 'unknown error'}`;
        report.status = 'failed';
        report.reason = round.error;
        return { report, findings };
      }
      round.sideload = 'ok';
      input.onProgress?.(`running ${tests.length} PR test file(s) on ${input.device.name}`);
      const started = Date.now();
      const until = Math.min(started + TEST_TIMEOUT_MS, input.deadline);
      // Until the framework prints its result, the console goes quiet, or time runs out.
      while (!input.signal?.aborted && Date.now() < until) {
        if (testResult(consoleRaw)) break;
        if (consoleRaw && Date.now() - lastOutput > QUIET_MS) break;
        await sleep(1000, input.signal);
      }
      await sleep(1500, input.signal);
      if (!testResult(consoleRaw) && Date.now() >= until) round.error = 'No test result before the time limit.';
    } finally {
      telnet.socket?.destroy();
    }
    if (!telnet.success) round.error = `Console not captured: ${telnet.error ?? 'could not connect to port 8085'}`;
    round.result = testResult(consoleRaw);
    round.console = redact(excerptConsole(consoleRaw));

    input.onProgress?.('judge reading the test results');
    const rule = () => runReadOnlyAgent({ ...input.backend, apiKey: input.apiKey, model: input.judgeModel, cwd: input.worktree, prompt: evidencePrompt(input, pending, round), name: `RDS device ruling ${input.repo}#${input.prNumber}`, signal: input.signal });
    let ruling = await rule();
    let ruled = extractJson<{ summary?: unknown; outcomes?: unknown; newFindings?: unknown }>(ruling.text);
    report.usage = addCost(report.usage ?? EMPTY_COST, ruling.usage);
    if (!ruled && !input.signal?.aborted) {
      // One retry for a stuck or malformed ruling, as for the reviewers and the judge.
      ruling = await rule();
      ruled = extractJson<{ summary?: unknown; outcomes?: unknown; newFindings?: unknown }>(ruling.text);
      report.usage = addCost(report.usage ?? EMPTY_COST, ruling.usage);
    }
    if (!ruled) {
      report.status = 'failed';
      report.reason = `Could not rule on the test results (${ruling.error ?? 'invalid reply'}).`;
      return { report, findings };
    }
    if (typeof ruled.summary === 'string' && ruled.summary.trim()) round.summary = report.summary = redact(ruled.summary.trim()).slice(0, 900);
    for (const o of (Array.isArray(ruled.outcomes) ? ruled.outcomes : []) as { id?: unknown; outcome?: unknown; evidence?: unknown; comment?: unknown }[]) {
      const finding = findings.find((f) => f.id === o.id && f.status === 'needs-device');
      if (!finding) continue;
      const outcome = o.outcome === 'confirmed' || o.outcome === 'refuted' ? o.outcome : 'inconclusive';
      const evidence = typeof o.evidence === 'string' ? redact(o.evidence).slice(0, 2000) : '';
      round.outcomes.push({ id: finding.id, outcome, evidence });
      if (outcome === 'confirmed') {
        finding.status = 'issue';
        finding.reasoning = `Confirmed by the PR tests on ${input.device.name}. ${finding.reasoning}`.trim();
        if (typeof o.comment === 'string' && o.comment.trim()) finding.comment = redact(o.comment.trim());
      } else if (outcome === 'refuted') {
        finding.status = 'dismissed';
        finding.reasoning = `Refuted on ${input.device.name}: the PR tests that exercise it pass. ${finding.reasoning}`.trim();
      }
      finding.deviceEvidence = evidence || finding.deviceEvidence;
    }
    for (const n of (Array.isArray(ruled.newFindings) ? ruled.newFindings : []) as Record<string, unknown>[]) {
      const title = typeof n.title === 'string' ? n.title.trim() : '';
      if (!title) continue;
      const file = typeof n.file === 'string' && n.file ? n.file : undefined;
      findings.push({
        id: createHash('sha256').update(`${file ?? ''}\n${title.toLowerCase()}`).digest('hex').slice(0, 12),
        title,
        detail: typeof n.detail === 'string' ? n.detail : '',
        severity: n.severity === 'critical' || n.severity === 'major' ? n.severity : 'minor',
        file,
        line: typeof n.line === 'number' ? n.line : undefined,
        status: 'issue',
        reasoning: `Seen on ${input.device.name} while running the PR tests.`,
        sources: ['device tests'],
        inDiff: false,
        comment: typeof n.comment === 'string' ? redact(n.comment) : undefined,
        deviceEvidence: typeof n.evidence === 'string' ? redact(n.evidence).slice(0, 2000) : undefined,
      });
    }
  } catch (err) {
    if (input.signal?.aborted) {
      report.status = 'cancelled';
    } else {
      report.status = 'failed';
      report.reason = redact(err instanceof Error ? err.message : String(err));
    }
  } finally {
    // The build copy holds the env and the device password: never leave it behind.
    await fs.rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
    report.finishedAt = Date.now();
  }
  return { report, findings };
}
