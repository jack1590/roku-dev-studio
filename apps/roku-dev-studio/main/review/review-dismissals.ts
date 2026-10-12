/**
 * Findings the user dismissed, remembered per repository in `<userData>/review/dismissals.json`
 * (matching rules live in packages/roku-review/suppressions.ts).
 *
 * - Dismiss: the finding moves to Dismissed on its review and is remembered for the repo.
 * - Restore (from a review): forgets every remembered copy of that objection and puts the finding
 *   back where it was.
 * - Settings lists them per repo, and Restore there forgets one.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/ipc/channels';
import { countFindings, dismissalsFor, type Dismissal, type ReviewResult } from 'roku-dev-studio-review';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto') as typeof import('crypto');

interface StoredLike {
  projectId: string;
  repo: string;
  number: number;
  result: ReviewResult;
}

let file = '';

function readAll(): Record<string, Dismissal[]> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Dismissal[]>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Dismissal[]>): void {
  for (const repo of Object.keys(all)) if (!all[repo].length) delete all[repo];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf-8');
}

export function loadDismissals(repo: string): Dismissal[] {
  return readAll()[repo] ?? [];
}

const MAX_REASON = 400;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function setupDismissalHandlers(deps: {
  dataDir: string;
  resultPath: (projectId: string, repo: string, number: number) => string;
  readStored: (projectId: string, repo: string, number: number) => StoredLike | null;
  /** A review changed: refresh its summary everywhere. */
  onSaved: (stored: StoredLike) => void;
}): void {
  const { ipcMain } = require('electron') as typeof import('electron');
  file = path.join(deps.dataDir, 'dismissals.json');

  const save = (stored: StoredLike) => {
    stored.result.counts = countFindings(stored.result.findings);
    fs.writeFileSync(deps.resultPath(stored.projectId, stored.repo, stored.number), JSON.stringify(stored, null, 2), 'utf-8');
    deps.onSaved(stored);
  };
  const load = (payload: { projectId?: unknown; repo?: unknown; number?: unknown; id?: unknown } | undefined) => {
    const stored = deps.readStored(text(payload?.projectId), text(payload?.repo), Number(payload?.number));
    const finding = stored?.result.findings.find((f) => f.id === text(payload?.id));
    return stored && finding ? { stored, finding } : null;
  };

  ipcMain.handle(IPC.ReviewsDismiss, async (_e: IpcMainInvokeEvent, payload?: { projectId?: unknown; repo?: unknown; number?: unknown; id?: unknown; reason?: unknown }) => {
    const hit = load(payload);
    if (!hit) return { success: false, error: 'That finding is no longer on the review.' };
    const { stored, finding } = hit;
    if (finding.ci) return { success: false, error: 'CI findings are facts from the check run and cannot be dismissed.' };
    if (finding.status === 'dismissed') return { success: true, review: stored };
    const reason = text(payload?.reason).slice(0, MAX_REASON) || undefined;
    const at = Date.now();
    const all = readAll();
    (all[stored.repo] ??= []).push({ id: randomUUID(), file: finding.file, title: finding.title, reason, at, prNumber: stored.number });
    writeAll(all);
    finding.userDismissed = { at, reason, previousStatus: finding.status, remembered: false };
    finding.status = 'dismissed';
    save(stored);
    return { success: true, review: stored };
  });

  ipcMain.handle(IPC.ReviewsRestoreFinding, async (_e: IpcMainInvokeEvent, payload?: { projectId?: unknown; repo?: unknown; number?: unknown; id?: unknown }) => {
    const hit = load(payload);
    const was = hit?.finding.userDismissed;
    if (!hit || !was) return { success: false, error: 'That finding was not dismissed by you.' };
    const { stored, finding } = hit;
    const all = readAll();
    const forget = new Set(dismissalsFor(finding, all[stored.repo] ?? []).map((d) => d.id));
    all[stored.repo] = (all[stored.repo] ?? []).filter((d) => !forget.has(d.id));
    writeAll(all);
    finding.status = was.previousStatus;
    delete finding.userDismissed;
    save(stored);
    return { success: true, review: stored };
  });

  ipcMain.handle(IPC.ReviewsDismissals, async (_e: IpcMainInvokeEvent, payload?: { repos?: unknown }) => {
    const repos = Array.isArray(payload?.repos) ? payload.repos.filter((r): r is string => typeof r === 'string') : [];
    const all = readAll();
    return { success: true, dismissals: Object.fromEntries(repos.map((r) => [r, [...(all[r] ?? [])].sort((a, b) => b.at - a.at)])) };
  });

  ipcMain.handle(IPC.ReviewsForgetDismissal, async (_e: IpcMainInvokeEvent, payload?: { repo?: unknown; id?: unknown }) => {
    const all = readAll();
    const repo = text(payload?.repo);
    all[repo] = (all[repo] ?? []).filter((d) => d.id !== text(payload?.id));
    writeAll(all);
    return { success: true };
  });
}
