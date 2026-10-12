/**
 * The app ships its own roku-pkg-cli (a dependency) and runs it on its own runtime
 * (`process.execPath` with ELECTRON_RUN_AS_NODE), so nothing needs installing.
 * Build tasks inside a run still call the user's node/npm, and Electron started from Finder
 * lacks the shell PATH (nvm), so the login shell's PATH is read once and reused.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { MIN_CLI_VERSION, compareVersions } from '../../shared/packager';

const run = promisify(execFile);

export interface CliInfo {
  /** Executable to spawn. */
  path: string;
  /** Leading args (the bundled CLI's entry script); empty for a standalone executable. */
  args: string[];
  version: string;
  ok: boolean;
  env: NodeJS.ProcessEnv;
}
export interface InspectResult {
  manifest: { title?: string; version?: string } | null;
  buildDir: string;
  buildDirSource: string;
  buildExists: boolean;
  buildMtime?: number;
  tasks: { label: string; isBuild: boolean }[];
}

let cached: Promise<CliInfo | null> | null = null;
export const resetCliCache = () => {
  cached = null;
};

/** Pull the marked roku-pkg path and PATH out of a shell probe; rc files may print anything around them. */
export function parseShellProbe(stdout: string): { bin?: string; PATH: string } | null {
  const bin = /__RDS_BIN__(.*?)__RDS_BIN__/s.exec(stdout)?.[1].trim();
  const PATH = /__RDS_PATH__(.*?)__RDS_PATH__/s.exec(stdout)?.[1].trim();
  if (!PATH) return null;
  return { bin: bin?.startsWith('/') ? bin : undefined, PATH };
}

/**
 * Interactive login shell (-ilc): nvm and friends are set up in ~/.zshrc, which a
 * non-interactive login shell skips. Markers keep rc-file output out of the result.
 */
async function loginShellPath(): Promise<{ bin?: string; PATH: string } | null> {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const { stdout } = await run(shell, ['-ilc', 'printf "__RDS_BIN__%s__RDS_BIN____RDS_PATH__%s__RDS_PATH__" "$(command -v roku-pkg)" "$PATH"'], { timeout: 15_000 });
    return parseShellProbe(stdout);
  } catch {
    return null;
  }
}

/** The roku-pkg-cli installed with the app, or null if it is missing. */
function bundledCli(): { entry: string; version: string } | null {
  try {
    const pkgFile = require.resolve('roku-pkg-cli/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { version: string; bin?: Record<string, string> };
    const entry = path.join(path.dirname(pkgFile), pkg.bin?.['roku-pkg'] ?? 'dist/index.js');
    return fs.existsSync(entry) ? { entry, version: pkg.version } : null;
  } catch {
    return null;
  }
}

/** `override` points at a specific executable (tests); it is not cached. */
export function findCli(opts: { override?: string } = {}): Promise<CliInfo | null> {
  if (cached && !opts.override) return cached;
  const p = (async (): Promise<CliInfo | null> => {
    if (opts.override) {
      const env = { ...process.env };
      try {
        const { stdout } = await run(opts.override, ['--version'], { env, timeout: 10_000 });
        const version = stdout.trim();
        return { path: opts.override, args: [], version, ok: compareVersions(version, MIN_CLI_VERSION) >= 0, env };
      } catch {
        return null;
      }
    }
    const bundled = bundledCli();
    if (!bundled) return null;
    const shell = await loginShellPath();
    const env = { ...process.env, PATH: shell?.PATH || process.env.PATH || '', ELECTRON_RUN_AS_NODE: '1' };
    return { path: process.execPath, args: [bundled.entry], version: bundled.version, ok: compareVersions(bundled.version, MIN_CLI_VERSION) >= 0, env };
  })();
  if (!opts.override) cached = p;
  return p;
}

export async function inspectFolder(cli: CliInfo, dir: string): Promise<{ ok: true; result: InspectResult } | { ok: false; error: string }> {
  try {
    const { stdout } = await run(cli.path, [...cli.args, 'inspect', dir, '--json'], { env: cli.env, timeout: 15_000 });
    const line = stdout.trim().split('\n').pop() ?? '';
    return { ok: true, result: JSON.parse(line) as InspectResult };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
