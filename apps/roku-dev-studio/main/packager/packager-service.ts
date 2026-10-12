/**
 * Packager: lists roku-pkg projects, edits its config, and runs `roku-pkg generate --json` on a
 * chosen device. Sign keys and passwords stay here; the window gets masked projects and run state.
 */
import type { App, IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IPC } from '../../shared/ipc/channels';
import { appendHistory, historyEntry, mergeProjectSave, toView, validateSave, type BuildChoice, type HistoryEntry, type RunState } from '../../shared/packager';
import { PACKAGER_HOLDER } from '../../shared/device-claims';
import { findCli, inspectFolder, resetCliCache } from './cli';
import { readConfig, writeConfig } from './config-store';
import { activeRuns, cancelRun, startRun } from './runner';
import { claimPoolDevice, listPoolDevices, releasePoolDevice } from '../review/review-service';

/** roku-pkg's own saved device (from `roku-pkg device`), listed beside the pool. */
const CLI_DEVICE_KEY = 'cli';
let historyFile = '';
let history: HistoryEntry[] = [];
/** Project holding the CLI device, if any. Pool devices use the review service's busy map. */
let cliDeviceHolder: string | undefined;
/** Paths main itself produced (run results); reveal/copy accept only these. */
const knownOutputs = new Set<string>();

function loadHistory(): void {
  try {
    history = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as HistoryEntry[];
  } catch {
    history = [];
  }
  for (const h of history) if (h.packagePath) knownOutputs.add(h.packagePath);
}

function saveHistory(): void {
  try {
    fs.writeFileSync(historyFile, JSON.stringify(history));
  } catch {
    // History is a convenience; a failed write must not fail the run.
  }
}

/** True when the Roku answers ECP at this IP (no password needed). */
async function probeOnline(ip: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${ip}:8060/query/device-info`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function isBuildChoice(b: unknown): b is BuildChoice {
  if (!b || typeof b !== 'object') return false;
  const c = b as { kind?: unknown; label?: unknown };
  return c.kind === 'existing' || c.kind === 'none' || (c.kind === 'task' && typeof c.label === 'string' && c.label.length > 0);
}

function setupPackagerHandlers(app: App): void {
  const { ipcMain, dialog, shell, clipboard, BrowserWindow } = require('electron') as typeof import('electron');
  historyFile = path.join(app.getPath('userData'), 'packager-history.json');
  loadHistory();
  const broadcast = (state: RunState) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.PackagerUpdate, state);
  };

  ipcMain.handle(IPC.PackagerStatus, async (_e: IpcMainInvokeEvent, input?: { refresh?: unknown }) => {
    // Finding the CLI runs an interactive login shell: only redo it when asked ("Check again").
    if (input?.refresh === true) resetCliCache();
    const cli = await findCli();
    return { success: true, cli: { found: !!cli, version: cli?.version, ok: !!cli?.ok } };
  });

  ipcMain.handle(IPC.PackagerList, async () => {
    try {
      const cfg = readConfig();
      const projects = cfg.projects.map((p) => ({ ...toView(p), signPkgExists: fs.existsSync(p.signPackageLocation), lastRun: history.find((h) => h.project === p.name) }));
      return { success: true, projects, history, runs: activeRuns() };
    } catch (err) {
      return { success: false, error: `Could not read ~/.roku-pkg/config.json: ${errorText(err)}` };
    }
  });

  ipcMain.handle(IPC.PackagerInspect, async (_e: IpcMainInvokeEvent, rootDir: unknown) => {
    const cli = await findCli();
    if (!cli?.ok) return { success: false, error: 'roku-pkg 1.2.0 or later is required.' };
    if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) return { success: false, error: 'Choose a folder.' };
    const r = await inspectFolder(cli, rootDir);
    return r.ok ? { success: true, result: r.result } : { success: false, error: r.error };
  });

  ipcMain.handle(IPC.PackagerSave, async (_e: IpcMainInvokeEvent, input: unknown) => {
    try {
      const cfg = readConfig();
      const v = validateSave(input, cfg.projects.map((p) => p.name));
      if (!v.ok) return { success: false, error: v.error };
      if (!fs.existsSync(path.join(v.value.rootDir, 'manifest'))) return { success: false, error: 'That folder has no Roku manifest.' };
      if (activeRuns().some((r) => r.project === (v.value.originalName ?? v.value.name))) return { success: false, error: 'Wait for the running package to finish.' };
      const idx = v.value.originalName ? cfg.projects.findIndex((p) => p.name === v.value.originalName) : -1;
      if (v.value.originalName && idx < 0) return { success: false, error: 'Project not found. It may have been removed in the terminal.' };
      const merged = mergeProjectSave(idx >= 0 ? cfg.projects[idx] : undefined, v.value);
      if (!merged.ok) return { success: false, error: merged.error };
      if (idx >= 0) cfg.projects[idx] = merged.project;
      else cfg.projects.push(merged.project);
      writeConfig(cfg);
      return { success: true };
    } catch (err) {
      return { success: false, error: errorText(err) };
    }
  });

  ipcMain.handle(IPC.PackagerRemove, async (_e: IpcMainInvokeEvent, name: unknown) => {
    try {
      const cfg = readConfig();
      const next = cfg.projects.filter((p) => p.name !== name);
      if (next.length === cfg.projects.length) return { success: false, error: 'Project not found.' };
      if (activeRuns().some((r) => r.project === name)) return { success: false, error: 'Wait for the running package to finish.' };
      writeConfig({ ...cfg, projects: next });
      return { success: true };
    } catch (err) {
      return { success: false, error: errorText(err) };
    }
  });

  ipcMain.handle(IPC.PackagerPick, async (event: IpcMainInvokeEvent, input: { kind?: unknown; defaultPath?: unknown }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = typeof input?.defaultPath === 'string' ? input.defaultPath : undefined;
    if (input?.kind === 'save') {
      const opts = { defaultPath, filters: [{ name: 'Roku package', extensions: ['pkg'] }] };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return { success: false };
      return { success: true, path: r.filePath.endsWith('.pkg') ? r.filePath : `${r.filePath}.pkg` };
    }
    const opts: Electron.OpenDialogOptions =
      input?.kind === 'pkg'
        ? { defaultPath, properties: ['openFile'], filters: [{ name: 'Roku package', extensions: ['pkg'] }] }
        : { defaultPath, properties: ['openDirectory'] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? { success: false } : { success: true, path: r.filePaths[0] };
  });

  ipcMain.handle(IPC.PackagerDevices, async () => {
    const pool = (await listPoolDevices()).map((d) => ({ key: d.key, name: d.name, ip: d.ip, online: d.online, hasPassword: d.hasPassword, busyWith: d.busyWith, source: 'pool' as const }));
    let cliDevice: { ip: string; password: string; name?: string } | undefined;
    try {
      cliDevice = readConfig().rokuDevice;
    } catch {
      cliDevice = undefined;
    }
    // The same TV saved in both places shows once, as the pool device (it has the busy tracking).
    const showCli = !!cliDevice?.ip && !pool.some((d) => d.ip === cliDevice!.ip);
    const cliOnline = showCli ? await probeOnline(cliDevice!.ip) : false;
    const cliRow =
      showCli
        ? [{ key: CLI_DEVICE_KEY, name: cliDevice!.name || 'roku-pkg device', ip: cliDevice!.ip, online: cliOnline, hasPassword: !!cliDevice!.password, busyWith: cliDeviceHolder ? `Packaging ${cliDeviceHolder}` : undefined, source: 'cli' as const }]
        : [];
    return { success: true, devices: [...pool, ...cliRow] };
  });

  ipcMain.handle(IPC.PackagerGenerate, async (_e: IpcMainInvokeEvent, input: { name?: unknown; deviceKey?: unknown; build?: unknown; skipRekey?: unknown; packageOnly?: unknown }) => {
    const cli = await findCli();
    if (!cli?.ok) return { success: false, error: 'roku-pkg 1.2.0 or later is required.' };
    const name = typeof input?.name === 'string' ? input.name : '';
    const deviceKey = typeof input?.deviceKey === 'string' ? input.deviceKey : '';
    const build = input?.build;
    if (!isBuildChoice(build)) return { success: false, error: 'Choose how to build.' };
    let cfg;
    try {
      cfg = readConfig();
    } catch (err) {
      return { success: false, error: errorText(err) };
    }
    if (!cfg.projects.some((p) => p.name === name)) return { success: false, error: 'Project not found.' };
    if (activeRuns().some((r) => r.project === name)) return { success: false, error: `${name} is already generating.` };

    let device: { key: string; name: string; ip: string; password: string };
    let release: () => void;
    if (deviceKey === CLI_DEVICE_KEY) {
      const d = cfg.rokuDevice;
      if (!d.ip || !d.password) return { success: false, error: 'The roku-pkg device has no IP or password. Run `roku-pkg device` in a terminal.' };
      if (cliDeviceHolder) return { success: false, error: `${d.name || 'The roku-pkg device'} is busy (packaging ${cliDeviceHolder}).` };
      cliDeviceHolder = name;
      device = { key: CLI_DEVICE_KEY, name: d.name || 'roku-pkg device', ip: d.ip, password: d.password };
      release = () => {
        cliDeviceHolder = undefined;
      };
    } else {
      const claim = claimPoolDevice(deviceKey, `${PACKAGER_HOLDER}${name}`);
      if (!claim.ok) return { success: false, error: claim.error };
      device = { key: deviceKey, name: claim.name, ip: claim.ip, password: claim.password };
      release = () => releasePoolDevice(deviceKey);
    }

    // Re-check right before starting: the list in the window can be up to a few seconds old.
    if (!(await probeOnline(device.ip))) {
      release();
      return { success: false, error: `${device.name} is not reachable at ${device.ip}. Check it is on and on the same network.` };
    }

    const started = startRun({
      cli,
      project: name,
      device,
      build,
      skipRekey: input.skipRekey === true,
      packageOnly: input.packageOnly === true,
      onState: broadcast,
      onExit: (final) => {
        release();
        const entry = historyEntry(final);
        if (entry.packagePath) knownOutputs.add(entry.packagePath);
        history = appendHistory(history, entry);
        saveHistory();
      }
    });
    if (!started.ok) release();
    return started.ok ? { success: true, runId: started.runId } : { success: false, error: started.error };
  });

  ipcMain.handle(IPC.PackagerCancel, async (_e: IpcMainInvokeEvent, runId: unknown) => ({ success: typeof runId === 'string' && cancelRun(runId) }));

  ipcMain.handle(IPC.PackagerReveal, async (_e: IpcMainInvokeEvent, p: unknown) => {
    if (typeof p !== 'string' || !knownOutputs.has(p) || !fs.existsSync(p)) return { success: false };
    shell.showItemInFolder(p);
    return { success: true };
  });

  ipcMain.handle(IPC.PackagerCopyPath, async (_e: IpcMainInvokeEvent, p: unknown) => {
    if (typeof p !== 'string' || !knownOutputs.has(p)) return { success: false };
    clipboard.writeText(p);
    return { success: true };
  });

  // Runs die with the app: stop them so the CLI cleans its temp folder.
  app.on('before-quit', () => {
    for (const r of activeRuns()) cancelRun(r.runId);
  });
}

export { setupPackagerHandlers };
