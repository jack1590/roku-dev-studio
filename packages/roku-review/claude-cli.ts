/**
 * One review agent run on the Claude Code CLI (`claude -p`), using the signed-in user's Claude
 * plan instead of an API key. Same contract as the Cursor run in agent.ts.
 *
 * Locked down like the Cursor agent: read-only built-in tools (Read, Grep, Glob), no MCP servers,
 * no user/project/local settings (so personal hooks, plugins and permissions never reach a
 * review), no saved session. The prompt goes in on stdin; the reply is the CLI's JSON result.
 */

import { spawn } from 'child_process';
import type { AgentRunInput, AgentRunOutput } from './agent';
import { estimateCents } from './pricing';

export interface ClaudeCli {
  /** Absolute path of the `claude` executable. */
  bin: string;
  /** Environment with the login shell's PATH. */
  env: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
export const CLAUDE_READ_ONLY_TOOLS = 'Read,Grep,Glob';

export function claudeArgs(model: string): string[] {
  return ['-p', '--model', model, '--output-format', 'json', '--tools', CLAUDE_READ_ONLY_TOOLS, '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk'];
}

interface ClaudeResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/** The CLI prints notices before its JSON; take the last line that is a result object. Pure; pinned by verify-review.ts. */
export function parseClaudeOutput(stdout: string): ClaudeResult | null {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as ClaudeResult;
      if (parsed.type === 'result') return parsed;
    } catch {
      // Not the result line.
    }
  }
  return null;
}

/** Map a result to the agent contract. Pure; pinned by verify-review.ts. */
export function toAgentOutput(model: string, result: ClaudeResult | null, durationMs: number, stderr: string): AgentRunOutput {
  if (!result) return { text: '', status: 'error', error: stderr.trim().split('\n').slice(-3).join(' ') || 'Claude Code gave no result.', durationMs };
  const u = result.usage ?? {};
  const input = u.input_tokens ?? 0, output = u.output_tokens ?? 0, cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  const listCents = (result.total_cost_usd ?? 0) * 100;
  return {
    text: result.result ?? '',
    status: result.is_error ? 'error' : 'finished',
    ...(result.is_error ? { error: (result.result ?? 'Claude Code run failed.').slice(0, 500) } : {}),
    durationMs,
    toolCalls: Math.max(0, (result.num_turns ?? 1) - 1),
    tokens: { input, output, total },
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total,
      // Claude Code reports list price; on a Claude plan nothing is charged per run.
      rawCents: listCents,
      chargedCents: 0,
      costMissing: 0,
      estCents: estimateCents(model, { input, output, cacheRead, cacheWrite }) ?? listCents,
    },
  };
}

export function runClaudeAgent(input: AgentRunInput & { claude: ClaudeCli }): Promise<AgentRunOutput> {
  const started = Date.now();
  if (input.signal?.aborted) return Promise.resolve({ text: '', status: 'cancelled', durationMs: 0 });
  return new Promise((resolve) => {
    const env = { ...input.claude.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(input.claude.bin, claudeArgs(input.model), { cwd: input.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    const stop = () => {
      cancelled = true;
      child.kill('SIGTERM');
    };
    input.signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const done = (out: AgentRunOutput) => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', stop);
      resolve(out);
    };
    child.on('error', (err) => done({ text: '', status: 'error', error: `Could not start Claude Code: ${err.message}`, durationMs: Date.now() - started }));
    child.on('close', () => {
      if (cancelled) return done({ text: '', status: input.signal?.aborted ? 'cancelled' : 'error', error: input.signal?.aborted ? undefined : 'The agent run timed out.', durationMs: Date.now() - started });
      done(toAgentOutput(input.model, parseClaudeOutput(stdout), Date.now() - started, stderr));
    });
    child.stdin.end(input.prompt);
  });
}
