/**
 * Roku-focused AI pull request review pipeline.
 *
 * Runs in the Electron main process (or a child process it starts), never in the renderer, so it
 * can run headless later. Every AI call goes through the Cursor SDK with the project's own Cursor
 * API key, which callers pass in per call and which this package never stores or logs.
 *
 * Pieces: model discovery, team knowledge from the LLM Wiki, PR checkout, diff budgeting,
 * read-only Cursor agents, the reviewer/judge prompts, and the review run itself. Device probes
 * and posting come in later phases.
 */

import { Cursor } from '@cursor/sdk';

export * from './wiki';
export * from './diff';
export * from './git';
export * from './agent';
export * from './ci';
export * from './prompts';
export * from './review';
export * from './build-detect';
export * from './device';

export interface CursorModel {
  id: string;
  label: string;
  /** Cursor's own one-line description, when it provides one. */
  description?: string;
}

/** Models the key's Cursor account can use, sorted by label. Throws with a readable message. */
export async function listCursorModels(apiKey: string): Promise<CursorModel[]> {
  if (!apiKey.trim()) throw new Error('Cursor API key is empty.');
  try {
    const models = await Cursor.models.list({ apiKey });
    return models
      .map((m) => ({ id: m.id, label: m.displayName || m.id, ...(m.description ? { description: m.description } : {}) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'AuthenticationError') throw new Error('Cursor rejected the API key.');
    if (name === 'RateLimitError') throw new Error('Cursor rate limit hit. Try again in a minute.');
    if (name === 'NetworkError') throw new Error('Could not reach Cursor. Check the network.');
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}
