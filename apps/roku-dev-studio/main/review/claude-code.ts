/**
 * Finding and checking the user's Claude Code CLI for the Claude review engine.
 *
 * The app started from Finder has no shell PATH, so `claude` is looked up in the login shell's
 * PATH (the same probe the Packager and device builds use). Nothing here reads or stores
 * credentials: `claude auth status` only says whether someone is signed in and how.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AgentBackend, ClaudeCli } from 'roku-dev-studio-review';
import * as tokenStore from '../project-token-store';
import { shellPath } from '../packager/cli';

const run = promisify(execFile);

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  /** "claude.ai" for a Claude plan login, or the API-key method. */
  method?: string;
  error?: string;
}

export async function findClaude(): Promise<ClaudeCli | null> {
  const PATH = (await shellPath()) || process.env.PATH || '';
  const env: NodeJS.ProcessEnv = { ...process.env, PATH };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const bin = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return { bin, env };
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

/** What a review needs to run its agents with the project's engine; throws a readable message when it cannot. */
export async function agentBackendFor(project: { id: string; engine?: 'cursor' | 'claude' }): Promise<{ apiKey: string; backend: AgentBackend }> {
  if (project.engine === 'claude') {
    const claude = await findClaude();
    if (!claude) throw new Error('Claude Code was not found. Install it and run `claude` once to sign in, then retry.');
    return { apiKey: '', backend: { engine: 'claude', claude } };
  }
  const apiKey = tokenStore.getToken(project.id, 'cursor');
  if (!apiKey) throw new Error('Save a Cursor API key for this project first.');
  return { apiKey, backend: { engine: 'cursor' } };
}

export async function claudeStatus(): Promise<ClaudeStatus> {
  const cli = await findClaude();
  if (!cli) return { installed: false };
  try {
    const [{ stdout: v }, auth] = await Promise.all([
      run(cli.bin, ['--version'], { env: cli.env, timeout: 15_000 }),
      run(cli.bin, ['auth', 'status'], { env: cli.env, timeout: 15_000 }).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' })),
    ]);
    const version = /\d+\.\d+\.\d+/.exec(v)?.[0];
    let loggedIn = false;
    let method: string | undefined;
    try {
      const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string };
      loggedIn = parsed.loggedIn === true;
      method = parsed.authMethod;
    } catch {
      // Older CLIs print text; treat as unknown.
    }
    return { installed: true, version, loggedIn, method };
  } catch (err) {
    return { installed: true, error: err instanceof Error ? err.message : String(err) };
  }
}
