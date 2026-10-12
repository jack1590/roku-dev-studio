/**
 * One Cursor agent run, locked down for reviewing.
 *
 * The agent works in the PR's checkout but can only read: `read`, `grep`, `glob`, `ls` and
 * semantic search. No shell, no edits, no deletes, no subagents, no MCP, no web. The SDK enforces
 * this through its tool allow-list, so it does not depend on the prompt being obeyed.
 */

import { Agent } from '@cursor/sdk';
import { estimateCents } from './pricing';

export const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'ls', 'semSearch'] as const;

export interface AgentRunInput {
  apiKey: string;
  model: string;
  cwd: string;
  prompt: string;
  /** Shown in Cursor's agent list. */
  name: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgentRunOutput {
  text: string;
  status: 'finished' | 'error' | 'cancelled';
  error?: string;
  durationMs: number;
  tokens?: { input: number; output: number; total: number };
  usage?: RunCost;
  /** Tool calls the agent made: a measure of how much it read. */
  toolCalls?: number;
}

/** Tokens and cost of one or more agent runs. Cents are float, as Cursor reports them. */
export interface RunCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** List price of the tokens. */
  rawCents: number;
  /** What Cursor actually charged (0 when included in the plan). */
  chargedCents: number;
  /** Runs whose cost Cursor had not reported yet; the price is then a lower bound. */
  costMissing: number;
  /** Estimate from our price table (pricing.ts), for when Cursor reports no cost. 0 for unknown models. */
  estCents: number;
}

export const EMPTY_COST: RunCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, rawCents: 0, chargedCents: 0, costMissing: 0, estCents: 0 };

export function addCost(a: RunCost, b: RunCost | undefined): RunCost {
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
    rawCents: a.rawCents + b.rawCents,
    chargedCents: a.chargedCents + b.chargedCents,
    costMissing: a.costMissing + b.costMissing,
    estCents: (a.estCents ?? 0) + (b.estCents ?? 0),
  };
}

/** Cursor's own billing for the agent; cost can lag a moment after the run, so retry briefly. */
async function costOf(agent: { getUsage: () => Promise<{ cost?: { rawCostCents: number; chargedCents: number } }> }): Promise<{ rawCostCents: number; chargedCents: number } | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const usage = await agent.getUsage();
      if (usage.cost) return usage.cost;
    } catch {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return undefined;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export async function runReadOnlyAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const started = Date.now();
  if (input.signal?.aborted) return { text: '', status: 'cancelled', durationMs: 0 };
  const agent = await Agent.create({
    apiKey: input.apiKey,
    model: { id: input.model },
    name: input.name,
    tools: [...READ_ONLY_TOOLS],
    // No ambient Cursor settings at all: the user's personal rules and skills must not reach a review
    // (they cost tokens on every turn and can change how reviewers write). The repo's own rules
    // (AGENTS.md, CLAUDE.md, .cursor/rules, CONTRIBUTING.md) are put in the prompt by readStandards.
    local: { cwd: input.cwd, settingSources: [] },
  });
  try {
    const run = await agent.send(input.prompt);
    let toolCalls = 0;
    const onAbort = () => void run.cancel().catch(() => undefined);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      // Count tool calls as they stream (a measurement only; agents read until they are done).
      const counting = run.unsupportedReason('stream')
        ? Promise.resolve()
        : (async () => {
            for await (const message of run.stream()) if (message.type === 'tool_call' && message.status === 'running') toolCalls++;
          })().catch(() => undefined);
      const result = await run.wait();
      await counting;
      const usage = result.usage;
      const status = result.status === 'finished' ? 'finished' : result.status === 'cancelled' ? 'cancelled' : 'error';
      const u = usage;
      const cost = u ? await costOf(agent) : undefined;
      return {
        text: result.result ?? '',
        status,
        error: status === 'error' ? result.error?.message ?? 'The agent run failed.' : undefined,
        durationMs: Date.now() - started,
        toolCalls,
        tokens: u ? { input: u.inputTokens, output: u.outputTokens, total: u.totalTokens } : undefined,
        usage: u
          ? {
              input: u.inputTokens,
              output: u.outputTokens,
              cacheRead: u.cacheReadTokens ?? 0,
              cacheWrite: u.cacheWriteTokens ?? 0,
              total: u.totalTokens,
              rawCents: cost?.rawCostCents ?? 0,
              chargedCents: cost?.chargedCents ?? 0,
              costMissing: cost ? 0 : 1,
              estCents: estimateCents(input.model, { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens ?? 0, cacheWrite: u.cacheWriteTokens ?? 0 }) ?? 0,
            }
          : undefined,
      };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    agent.close();
  }
}

/**
 * The first balanced JSON object in a model's reply. Models wrap JSON in prose or code fences
 * despite instructions, so this scans for it instead of trusting the whole text.
 */
export function extractJson<T = unknown>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as T;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
