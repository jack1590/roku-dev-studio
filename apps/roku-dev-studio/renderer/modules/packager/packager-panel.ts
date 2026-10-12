/**
 * Packager panel (main window): build and sign .pkg files with roku-pkg.
 *
 * App-level panel like PR Reviews: opened from the title bar, the sidebar footer or the welcome
 * card via `rds:app-panel-open`. Master–detail: projects on the left, the selected project's
 * workspace (Ready / Running / Success / Failed) on the right, Add/Edit in a side drawer.
 * roku-pkg runs in the main process; this module only renders the state main broadcasts.
 * Sign keys and device passwords never reach this window.
 */

import { escapeHtml } from '../utils/dom.js';
import { MIN_CLI_VERSION, STEPS, STEP_LABELS, fixFor, historyLabel } from '@shared/packager.js';
import type { BuildChoice, HistoryEntry, ProjectView, RunState } from '@shared/packager.js';

type ProjectRow = ProjectView & { signPkgExists: boolean; lastRun?: HistoryEntry };
interface PackagerDevice {
  key: string;
  name: string;
  ip: string;
  online: boolean;
  hasPassword: boolean;
  busyWith?: string;
  source: 'pool' | 'cli';
}
interface InspectResult {
  manifest: { title?: string; version?: string } | null;
  buildDir: string;
  buildDirSource: string;
  buildExists: boolean;
  buildMtime?: number;
  tasks: { label: string; isBuild: boolean }[];
}
interface PackagerApi {
  status(refresh?: boolean): Promise<{ success: boolean; cli: { found: boolean; version?: string; ok: boolean } }>;
  list(): Promise<{ success: boolean; projects?: ProjectRow[]; history?: HistoryEntry[]; runs?: RunState[]; error?: string }>;
  inspect(rootDir: string): Promise<{ success: boolean; result?: InspectResult; error?: string }>;
  save(input: object): Promise<{ success: boolean; error?: string }>;
  remove(name: string): Promise<{ success: boolean; error?: string }>;
  pick(input: { kind: 'folder' | 'pkg' | 'save'; defaultPath?: string }): Promise<{ success: boolean; path?: string }>;
  devices(): Promise<{ success: boolean; devices: PackagerDevice[] }>;
  generate(input: { name: string; deviceKey: string; build: BuildChoice; skipRekey?: boolean; packageOnly?: boolean }): Promise<{ success: boolean; runId?: string; error?: string }>;
  cancel(runId: string): Promise<{ success: boolean }>;
  reveal(p: string): Promise<{ success: boolean }>;
  copyPath(p: string): Promise<{ success: boolean }>;
  onUpdate(cb: (state: RunState) => void): () => void;
}

const PANEL_ID = 'packagerPanel';
const api = (window as unknown as { rdsPackager?: PackagerApi }).rdsPackager;

let cli: { found: boolean; version?: string; ok: boolean } | null = null;
let projects: ProjectRow[] = [];
let history: HistoryEntry[] = [];
let devices: PackagerDevice[] = [];
/** project → latest run (live, or finished and not yet dismissed). */
const runs = new Map<string, RunState>();
/** rootDir → what roku-pkg detected there. */
const inspected = new Map<string, InspectResult>();
/** rootDir → why roku-pkg could not read it. */
const inspectErrors = new Map<string, string>();
let selectedName: string | null = null;
let filter = '';
let listError = '';
let loaded = false;

const isOpen = () => document.getElementById(PANEL_ID)?.classList.contains('active') ?? false;
const selected = () => projects.find((p) => p.name === selectedName) ?? null;
const attr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');
const fileName = (p: string) => p.split('/').pop() ?? p;
const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const mb = (bytes?: number) => (bytes === undefined ? '' : `${(bytes / 1048576).toFixed(1)} MB`);

async function load(refreshCli = false): Promise<void> {
  if (!api) return;
  const [status, list, devs] = await Promise.all([api.status(refreshCli), api.list(), api.devices()]);
  cli = status.cli;
  devices = devs.success ? devs.devices : [];
  listError = list.success ? '' : list.error ?? 'Could not load projects.';
  projects = list.projects ?? [];
  history = list.history ?? [];
  for (const r of list.runs ?? []) runs.set(r.project, r);
  if (!selected()) selectedName = projects[0]?.name ?? null;
  loaded = true;
  render();
  const p = selected();
  if (p && cli?.ok && !inspected.has(p.rootDir)) void inspect(p.rootDir);
}

async function inspect(rootDir: string): Promise<void> {
  inspectErrors.delete(rootDir);
  const r = await api?.inspect(rootDir);
  if (r?.success && r.result) inspected.set(rootDir, r.result);
  else inspectErrors.set(rootDir, r?.error ?? 'roku-pkg could not read this folder.');
  render();
}

// ---------------------------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------------------------

function railChip(p: ProjectRow): string {
  const run = runs.get(p.name);
  if (run?.status === 'running') return `<span class="pkg-chip pkg-chip-live">● ${escapeHtml(run.current ? STEP_LABELS[run.current] : 'Starting')}…</span>`;
  const last = p.lastRun;
  if (!last) return `<span class="pkg-chip">never built</span>`;
  return last.ok
    ? `<span class="pkg-chip pkg-chip-ok">✓ ${timeAgo(last.at)}${last.sizeBytes ? ` · ${mb(last.sizeBytes)}` : ''}</span>`
    : `<span class="pkg-chip pkg-chip-warn">⚠ last run failed</span>`;
}

function patchRailChip(name: string): void {
  const p = projects.find((x) => x.name === name);
  const chip = document.querySelector(`#packagerRoot .pkg-rail-item[data-name="${CSS.escape(name)}"] .pkg-chip`);
  if (p && chip) chip.outerHTML = railChip(p);
}

function renderRail(): string {
  const q = filter.trim().toLowerCase();
  const rows = projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.rootDir.toLowerCase().includes(q));
  return `
    <nav class="pkg-rail" aria-label="Packager projects">
      <input class="pkg-filter" data-role="filter" type="search" placeholder="Filter projects…" aria-label="Filter projects" value="${attr(filter)}">
      <ul class="pkg-rail-list" role="listbox" aria-label="Projects">
        ${rows
          .map(
            (p) => `
          <li role="option" aria-selected="${p.name === selectedName}">
            <button type="button" class="pkg-rail-item${p.name === selectedName ? ' is-selected' : ''}" data-action="select" data-name="${attr(p.name)}">
              <span class="pkg-rail-name">${escapeHtml(p.name)}</span>
              <span class="pkg-rail-path">${escapeHtml(shortPath(p.rootDir))}</span>
              ${railChip(p)}
            </button>
          </li>`
          )
          .join('')}
      </ul>
      ${rows.length === 0 && projects.length ? `<p class="pkg-muted">No project matches “${escapeHtml(filter)}”.</p>` : ''}
    </nav>`;
}

function renderEmpty(): string {
  if (!cli?.found || !cli.ok) {
    // roku-pkg-cli ships with the app; this only shows if that install is missing or broken.
    return `
      <div class="pkg-empty">
        <div class="pkg-empty-icon" aria-hidden="true">📦</div>
        <h2>The package tool is missing</h2>
        <p>Roku Dev Studio includes <code>roku-pkg</code> ${MIN_CLI_VERSION}${cli?.version ? `, but found <b>${escapeHtml(cli.version)}</b>` : ', but it could not be loaded'}. Reinstall or update Roku Dev Studio.</p>
        <div class="pkg-row pkg-center"><button type="button" class="pkg-btn pkg-btn-primary" data-action="recheck">Check again</button></div>
      </div>`;
  }
  return `
    <div class="pkg-empty">
      <div class="pkg-empty-icon" aria-hidden="true">🗂</div>
      <h2>Add your first Roku project</h2>
      <p>Choose the app folder. Then point to the signed .pkg and its key.</p>
      <button type="button" class="pkg-btn pkg-btn-primary" data-action="add">+ Add project</button>
      <p class="pkg-muted">Projects are shared with the terminal CLI (~/.roku-pkg/config.json).</p>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Workspace: Ready / Running / Success / Failed
// ---------------------------------------------------------------------------------------------

/** Per-project choices on the Ready screen; they survive switching projects. */
interface Choice {
  deviceKey?: string;
  build?: BuildChoice;
  skipRekey: boolean;
  packageOnly: boolean;
  logOpen: boolean;
  error?: string;
}
const choices = new Map<string, Choice>();
function choiceFor(name: string): Choice {
  let c = choices.get(name);
  if (!c) {
    c = { skipRekey: false, packageOnly: false, logOpen: false };
    choices.set(name, c);
  }
  return c;
}

function defaultDevice(): PackagerDevice | undefined {
  return devices.find((d) => d.source === 'pool' && d.online && d.hasPassword && !d.busyWith) ?? devices.find((d) => d.hasPassword && !d.busyWith) ?? devices[0];
}

function defaultBuild(p: ProjectRow, info?: InspectResult): BuildChoice {
  if (p.defaultBuildTask && info?.tasks.some((t) => t.label === p.defaultBuildTask)) return { kind: 'task', label: p.defaultBuildTask };
  const firstBuild = info?.tasks.find((t) => t.isBuild);
  if (firstBuild) return { kind: 'task', label: firstBuild.label };
  return info?.buildExists ? { kind: 'existing' } : { kind: 'none' };
}

interface Check { label: string; ok: boolean; fix?: 'device' | 'edit-signing' }
function preflight(p: ProjectRow, device?: PackagerDevice): Check[] {
  const deviceCheck: Check = !device
    ? { label: 'Choose a device', ok: false, fix: 'device' }
    : device.busyWith
      ? { label: `${device.name} is busy (${device.busyWith})`, ok: false }
      : device.online
        ? { label: 'Device reachable', ok: true }
        : { label: `${device.name} is offline`, ok: false };
  return [
    deviceCheck,
    { label: device && !device.hasPassword ? 'No dev password saved' : 'Dev password saved', ok: !!device?.hasPassword, fix: 'device' },
    { label: p.signPkgExists ? 'Signed pkg found' : 'Signed pkg missing', ok: p.signPkgExists, fix: 'edit-signing' },
    { label: p.hasSignKey ? 'Sign key set' : 'Sign key missing', ok: p.hasSignKey, fix: 'edit-signing' }
  ];
}

const STATE_TEXT: Record<string, string> = { done: 'done', failed: 'failed', running: 'in progress', skipped: 'skipped', pending: 'waiting' };

function stepper(run: RunState): string {
  return `<ol class="pkg-steps" aria-label="Steps">${STEPS.map((s) => {
    const st = run.steps[s];
    const icon = st.state === 'done' ? '✓' : st.state === 'failed' ? '✕' : '';
    const ms = st.ms !== undefined && st.state === 'done' ? `${Math.max(1, Math.round(st.ms / 1000))}s` : '';
    return `<li class="pkg-step is-${st.state}"><span class="pkg-dot" aria-hidden="true">${icon}</span><span class="pkg-step-label">${escapeHtml(STEP_LABELS[s])}${st.detail ? ` <span class="pkg-muted">· ${escapeHtml(st.detail)}</span>` : ''}</span><span class="pkg-visually-hidden">, ${STATE_TEXT[st.state]}</span><span class="pkg-step-ms pkg-muted">${ms}</span></li>`;
  }).join('')}</ol>`;
}

function logBlock(run: RunState, c: Choice): string {
  return `
    <div class="pkg-log-wrap">
      <div class="pkg-row"><button type="button" class="pkg-link" data-action="toggle-log" aria-expanded="${c.logOpen}">${c.logOpen ? '▾' : '▸'} Log (${run.log.length} lines)</button><span class="pkg-spacer"></span>${c.logOpen ? `<button type="button" class="pkg-btn" data-action="copy-log">Copy</button>` : ''}</div>
      ${c.logOpen ? `<pre class="pkg-log" data-role="log" tabindex="0">${escapeHtml(run.log.slice(-400).join('\n'))}</pre>` : ''}
    </div>`;
}

function elapsed(run: RunState): string {
  const s = Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const progress = (run: RunState) => Math.round((STEPS.filter((s) => run.steps[s].state === 'done' || run.steps[s].state === 'skipped').length / STEPS.length) * 100);

function renderWorkspace(p: ProjectRow): string {
  const info = inspected.get(p.rootDir);
  const c = choiceFor(p.name);
  const run = runs.get(p.name);
  const running = run?.status === 'running';
  const failed = run && (run.status === 'failed' || run.status === 'cancelled') && run.result && !run.result.ok ? run.result : null;
  const statusChip = running
    ? `<span class="pkg-chip pkg-chip-live">● generating · <span data-role-elapsed>${elapsed(run!)}</span></span>`
    : run?.status === 'ok'
      ? `<span class="pkg-chip pkg-chip-ok">✓ packaged in ${elapsed(run)}</span>`
      : failed
        ? failed.code === 'CANCELLED'
          ? `<span class="pkg-chip">Cancelled</span>`
          : `<span class="pkg-chip pkg-chip-bad">✕ failed${failed.step ? ` at ${escapeHtml(STEP_LABELS[failed.step])}` : ''}</span>`
        : info?.manifest?.version
          ? `<span class="pkg-chip">v${escapeHtml(info.manifest.version)} · from manifest</span>`
          : '';
  const head = `
    <div class="pkg-row"><h2 class="pkg-ws-title">${escapeHtml(p.name)}</h2>${statusChip}
      <span class="pkg-spacer"></span>
      ${running ? `<button type="button" class="pkg-btn" data-action="cancel">Cancel</button>` : `<button type="button" class="pkg-btn" data-action="edit">Edit</button>`}
    </div>`;

  if (running) {
    return `${head}
      <div class="pkg-bar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress(run)}"><i style="width:${progress(run)}%"></i></div>
      ${stepper(run)}
      ${logBlock(run, c)}
      <p class="pkg-muted">You can leave this panel or switch projects. The run continues, and the project list shows its progress.</p>`;
  }

  if (run?.status === 'ok' && run.result?.ok) {
    const r = run.result;
    const past = history.filter((h) => h.project === p.name).slice(0, 5);
    return `${head}
      <div class="pkg-success" role="status">
        <div class="pkg-success-icon" aria-hidden="true">📦</div>
        <div class="pkg-success-body"><b>${escapeHtml(fileName(r.packagePath))}</b>
          <div class="pkg-muted">${[r.version ? `v${escapeHtml(r.version)}` : '', mb(r.sizeBytes), `on ${escapeHtml(run.deviceName)}`].filter(Boolean).join(' · ')}</div>
          <div class="pkg-muted pkg-path" title="${attr(r.packagePath)}">${escapeHtml(shortPath(r.packagePath))}</div></div>
        <div class="pkg-col"><button type="button" class="pkg-btn pkg-btn-primary" data-action="reveal" data-path="${attr(r.packagePath)}">Reveal in Finder</button><button type="button" class="pkg-btn" data-action="copy-path" data-path="${attr(r.packagePath)}">Copy path</button></div>
      </div>
      <div class="pkg-row"><button type="button" class="pkg-btn" data-action="again">▶ Generate again</button></div>
      ${logBlock(run, c)}
      ${past.length ? `<h3 class="pkg-label">History</h3><ul class="pkg-history">${past.map((h) => `<li>${h.ok ? '<span class="pkg-chip pkg-chip-ok">✓</span>' : '<span class="pkg-chip pkg-chip-bad">✕</span>'} <span title="${attr(h.message ?? '')}">${escapeHtml(historyLabel(h))}</span><span class="pkg-spacer"></span><span class="pkg-muted">${timeAgo(h.at)}</span></li>`).join('')}</ul>` : ''}`;
  }

  if (run && failed) {
    const fix = fixFor(failed.code);
    const fixButton =
      failed.code === 'CANCELLED' ? ''
        : fix === 'rekey' ? `<button type="button" class="pkg-btn pkg-btn-primary" data-action="rekey-retry">Rekey and try again</button>`
        : fix === 'edit-signing' ? `<button type="button" class="pkg-btn" data-action="edit">Edit signing…</button>`
          : fix === 'device' ? `<button type="button" class="pkg-btn" data-action="again">Choose another device</button>`
            : fix === 'log' && !c.logOpen ? `<button type="button" class="pkg-btn" data-action="toggle-log">View log</button>`
              : '';
    return `${head}
      ${stepper(run)}
      <div class="${failed.code === 'CANCELLED' ? 'pkg-note-card' : 'pkg-error-card'}" role="alert">
        <b>${escapeHtml(failed.code === 'CANCELLED' ? 'The run was cancelled.' : failed.message)}</b>
        ${failed.hint ? `<p>${escapeHtml(failed.hint)}</p>` : ''}
        <div class="pkg-row">${fixButton}<button type="button" class="pkg-btn" data-action="again">Try again</button></div>
      </div>
      ${logBlock(run, c)}`;
  }

  // Ready
  const device = devices.find((d) => d.key === c.deviceKey) ?? defaultDevice();
  const build = c.build ?? defaultBuild(p, info);
  const checks = preflight(p, device);
  const tasks = info?.tasks ?? [];
  const taskLabel = build.kind === 'task' ? build.label : (p.defaultBuildTask ?? tasks.find((t) => t.isBuild)?.label ?? tasks[0]?.label);
  const ready = !!info && checks.every((k) => k.ok) && !(build.kind === 'existing' && !info.buildExists);
  return `${head}
    <div class="pkg-cards">
      <div class="pkg-card"><label class="pkg-label" for="pkgDevice">Device</label>
        ${devices.length
          ? `<select id="pkgDevice" class="pkg-select" data-role="device">${devices.map((d) => `<option value="${attr(d.key)}" ${d.key === device?.key ? 'selected' : ''}>${escapeHtml(d.name)}${d.source === 'cli' ? ' (roku-pkg)' : ''}${d.busyWith ? ' · busy' : !d.online ? ' · offline' : !d.hasPassword ? ' · no password' : ''}</option>`).join('')}</select>
             <span class="pkg-muted">${escapeHtml(device?.ip ?? '')} · ${device?.online ? '<span class="pkg-ok">● online</span>' : '<span class="pkg-bad">● offline</span>'}</span>`
          : `<span class="pkg-muted">No devices yet. Add one in PR Reviews → Test devices.</span>`}
      </div>
      <div class="pkg-card"><span class="pkg-label">Signing</span><b class="pkg-path" title="${attr(p.signPackageLocation)}">${escapeHtml(fileName(p.signPackageLocation))}</b><span class="pkg-muted">key ${p.hasSignKey ? '••••••••' : 'missing'} · ${p.signPkgExists ? '<span class="pkg-ok">✓ file found</span>' : '<span class="pkg-bad">file missing</span>'}</span></div>
      <div class="pkg-card" title="${attr(p.outputLocation)}"><span class="pkg-label">Output</span><b class="pkg-path">${escapeHtml(fileName(p.outputLocation))}</b><span class="pkg-muted pkg-path">${escapeHtml(shortPath(p.outputLocation.replace(/[^/]+$/, '')))}</span></div>
    </div>
    <div class="pkg-card pkg-build">
      <span class="pkg-label" id="pkgBuildLabel">Build</span>
      ${!info ? (inspectErrors.has(p.rootDir) ? `<div class="pkg-row"><span class="pkg-bad">Could not read the project: ${escapeHtml(inspectErrors.get(p.rootDir)!)}</span><button type="button" class="pkg-btn" data-action="reinspect">Try again</button></div>` : `<span class="pkg-muted">Reading the project…</span>`) : `
      <div class="pkg-seg" role="radiogroup" aria-labelledby="pkgBuildLabel">
        <button type="button" role="radio" aria-checked="${build.kind === 'task'}" class="${build.kind === 'task' ? 'is-on' : ''}" data-action="build-kind" data-kind="task" ${tasks.length ? '' : 'disabled'}>Run task${taskLabel && tasks.length ? `: <b>${escapeHtml(taskLabel)}</b>` : ''}</button>
        <button type="button" role="radio" aria-checked="${build.kind === 'existing'}" class="${build.kind === 'existing' ? 'is-on' : ''}" data-action="build-kind" data-kind="existing" ${info.buildExists ? '' : 'disabled'}>Use existing <span class="pkg-muted">${info.buildExists ? `${escapeHtml(fileName(info.buildDir))}/${info.buildMtime ? ` · ${timeAgo(info.buildMtime)}` : ''}` : 'none yet'}</span></button>
        <button type="button" role="radio" aria-checked="${build.kind === 'none'}" class="${build.kind === 'none' ? 'is-on' : ''}" data-action="build-kind" data-kind="none">No build</button>
      </div>
      ${build.kind === 'task' && tasks.length > 1 ? `<select class="pkg-select" data-role="task" aria-label="Build task">${tasks.map((t) => `<option ${t.label === taskLabel ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}</select>` : ''}`}
      <div class="pkg-options" role="group" aria-label="Options">
        <label class="pkg-check"><input type="checkbox" data-role="skip-rekey" ${c.skipRekey ? 'checked' : ''}> Skip rekey <span class="pkg-muted">(the device is already keyed for ${escapeHtml(p.name)})</span></label>
        <label class="pkg-check"><input type="checkbox" data-role="package-only" ${c.packageOnly ? 'checked' : ''}> Package only <span class="pkg-muted">(the app is already on the device)</span></label>
      </div>
    </div>
    <div class="pkg-row pkg-go-row">
      <ul class="pkg-checks" aria-label="Before you generate">${checks.map((k) => `<li class="${k.ok ? 'pkg-ok' : 'pkg-bad'}"><span aria-hidden="true">${k.ok ? '✓' : '✕'}</span> ${escapeHtml(k.label)}${!k.ok && k.fix ? ` <button type="button" class="pkg-link" data-action="fix" data-fix="${k.fix}">Fix</button>` : ''}</li>`).join('')}</ul>
      <span class="pkg-spacer"></span>
      <button type="button" class="pkg-btn pkg-btn-primary pkg-go" data-action="generate" ${ready ? '' : 'disabled'} title="⌘↵">▶ Generate package</button>
    </div>
    ${c.error ? `<div class="pkg-error-card" role="alert">${escapeHtml(c.error)}</div>` : ''}
    <p class="pkg-muted">${c.skipRekey ? 'Rekey is skipped: the device must already be keyed for this project.' : `This rekeys <b>${escapeHtml(device?.name ?? 'the device')}</b> with ${escapeHtml(p.name)}'s signing key.`} ⌘↵ to start.</p>`;
}

async function startGenerate(): Promise<void> {
  const p = selected();
  if (!p || !api) return;
  const c = choiceFor(p.name);
  const device = devices.find((d) => d.key === c.deviceKey) ?? defaultDevice();
  if (!device) return;
  c.error = undefined;
  const res = await api.generate({ name: p.name, deviceKey: device.key, build: c.build ?? defaultBuild(p, inspected.get(p.rootDir)), skipRekey: c.skipRekey, packageOnly: c.packageOnly });
  if (!res.success) {
    c.error = res.error ?? 'Could not start.';
    render();
  }
}

// ---------------------------------------------------------------------------------------------
// Add / Edit drawer
// ---------------------------------------------------------------------------------------------

interface FormState {
  name: string;
  rootDir: string;
  signPackageLocation: string;
  outputLocation: string;
  defaultBuildTask: string;
  signKey: string;
  nameTouched: boolean;
}
interface DrawerState {
  mode: 'add' | 'edit';
  originalName?: string;
  form: FormState;
  info?: InspectResult;
  inspecting: boolean;
  error?: string;
  saving: boolean;
  confirmRemove: boolean;
  showKey: boolean;
  hasSavedKey: boolean;
}
let drawer: DrawerState | null = null;
/** data-action of the button that opened the drawer; re-queried on close since renders replace nodes. */
let openerAction = 'add';

function openDrawer(mode: 'add' | 'edit', p?: ProjectRow): void {
  openerAction = (document.activeElement as HTMLElement | null)?.dataset.action ?? mode;
  drawer = {
    mode,
    originalName: p?.name,
    inspecting: false,
    saving: false,
    confirmRemove: false,
    showKey: false,
    hasSavedKey: !!p?.hasSignKey,
    form: { name: p?.name ?? '', rootDir: p?.rootDir ?? '', signPackageLocation: p?.signPackageLocation ?? '', outputLocation: p?.outputLocation ?? '', defaultBuildTask: p?.defaultBuildTask ?? '', signKey: '', nameTouched: !!p },
    info: p ? inspected.get(p.rootDir) : undefined
  };
  render();
  document.querySelector<HTMLElement>(mode === 'add' ? '#packagerDrawer [data-action="pick-folder"]' : '#packagerDrawer [data-role="f-name"]')?.focus();
  if (p && !drawer.info) void inspectForDrawer(p.rootDir);
}

function closeDrawer(): void {
  drawer = null;
  render();
  document.querySelector<HTMLElement>(`#packagerRoot [data-action="${openerAction}"]`)?.focus();
}

async function inspectForDrawer(rootDir: string): Promise<void> {
  if (!drawer || !api) return;
  drawer.inspecting = true;
  drawer.info = undefined;
  render();
  const res = await api.inspect(rootDir);
  if (!drawer || drawer.form.rootDir !== rootDir) return;
  drawer.inspecting = false;
  if (res.success && res.result) {
    drawer.info = res.result;
    inspected.set(rootDir, res.result);
    if (!drawer.form.nameTouched && res.result.manifest?.title) drawer.form.name = res.result.manifest.title;
  } else drawer.error = res.error ?? 'Could not read that folder.';
  render();
}

function fieldErrors(d: DrawerState): Partial<Record<keyof FormState, string>> {
  const f = d.form;
  const e: Partial<Record<keyof FormState, string>> = {};
  if (!f.rootDir) e.rootDir = 'Choose the app folder.';
  else if (d.info && !d.info.manifest) e.rootDir = 'No Roku manifest in this folder.';
  const name = f.name.trim();
  if (!name) e.name = 'Give the project a name.';
  else if (name !== d.originalName && projects.some((p) => p.name === name)) e.name = 'A project with this name already exists.';
  if (!f.signPackageLocation) e.signPackageLocation = 'Choose the signed .pkg.';
  if (!f.signKey.trim() && !d.hasSavedKey) e.signKey = 'Paste the sign key.';
  if (!f.outputLocation) e.outputLocation = 'Choose where to save the package.';
  else if (f.outputLocation === f.signPackageLocation) e.outputLocation = 'This is the signed package used to rekey the device. Save the output somewhere else.';
  return e;
}

function field(id: string, label: string, control: string, hint: string, error?: string): string {
  return `
    <div class="pkg-field"><label class="pkg-field-label" for="${id}">${label}</label>${control}
      ${error ? `<div class="pkg-field-error" id="${id}-err">${escapeHtml(error)}</div>` : hint ? `<div class="pkg-hint" id="${id}-hint">${hint}</div>` : ''}
    </div>`;
}

function pathBox(id: string, value: string, action: string, placeholder: string, error?: string): string {
  return `<div class="pkg-row pkg-nowrap"><input id="${id}" class="pkg-input pkg-mono" readonly value="${attr(value ? shortPath(value) : '')}" placeholder="${attr(placeholder)}" title="${attr(value)}" ${error ? `aria-invalid="true" aria-describedby="${id}-err"` : ''}><button type="button" class="pkg-btn" data-action="${action}">Choose…</button></div>`;
}

function renderDetect(d: DrawerState): string {
  if (d.inspecting) return `<div class="pkg-detect pkg-muted" role="status">Reading the folder…</div>`;
  const info = d.info;
  if (!info) return '';
  const source = info.buildDirSource === 'launch.json' ? 'from .vscode/launch.json' : info.buildDirSource === 'bsconfig.json' ? 'from bsconfig.json' : info.buildDirSource === 'root' ? 'the app folder itself' : 'detected';
  const buildTasks = info.tasks.filter((t) => t.isBuild);
  const shown = (buildTasks.length ? buildTasks : info.tasks).map((t) => t.label);
  return `
    <div class="pkg-detect" role="status">
      <span class="${info.manifest ? 'pkg-ok' : 'pkg-bad'}" aria-hidden="true">${info.manifest ? '✓' : '✕'}</span>
      <span>${info.manifest ? `manifest: <b>${escapeHtml(info.manifest.title ?? '?')}</b>${info.manifest.version ? ` · v${escapeHtml(info.manifest.version)}` : ''}` : 'No manifest found'}</span>
      <span class="pkg-ok" aria-hidden="true">✓</span>
      <span>Build folder: <b>${escapeHtml(fileName(info.buildDir))}/</b> <span class="pkg-muted">(${source})</span></span>
      <span class="${info.tasks.length ? 'pkg-ok' : 'pkg-muted'}" aria-hidden="true">${info.tasks.length ? '✓' : '–'}</span>
      <span>${info.tasks.length ? `${shown.length} ${buildTasks.length ? 'VSCode build' : 'VSCode'} task${shown.length === 1 ? '' : 's'}: ${escapeHtml(shown.join(', '))}` : 'No VSCode tasks. Runs use the existing build folder.'}</span>
    </div>`;
}

function renderDrawer(): string {
  if (!drawer) return '';
  const d = drawer;
  const f = d.form;
  const errs = fieldErrors(d);
  const valid = Object.keys(errs).length === 0 && !d.inspecting;
  const title = d.mode === 'add' ? 'Add project' : `Edit ${escapeHtml(d.originalName ?? '')}`;
  return `
    <div class="prr-backdrop" data-action="drawer-close"></div>
    <aside class="prr-drawer pkg-drawer" role="dialog" aria-modal="true" aria-labelledby="pkgDrawerTitle">
      <header class="prr-drawer-head"><h2 id="pkgDrawerTitle" class="prr-drawer-title">${title}</h2><button type="button" class="pkg-icon-btn" data-action="drawer-close" aria-label="Close">✕</button></header>
      <div class="prr-drawer-body">
        <h3 class="pkg-label">1 · App</h3>
        ${field('pkgRoot', 'App folder', pathBox('pkgRoot', f.rootDir, 'pick-folder', 'Choose the Roku app folder', f.rootDir ? errs.rootDir : undefined), '', f.rootDir ? errs.rootDir : undefined)}
        ${renderDetect(d)}
        ${field('pkgName', 'Name', `<input id="pkgName" class="pkg-input" data-role="f-name" value="${attr(f.name)}" maxlength="80" autocomplete="off" ${errs.name && (f.nameTouched || f.name) ? 'aria-invalid="true" aria-describedby="pkgName-err"' : 'aria-describedby="pkgName-hint"'}>`, `Filled in from the manifest title. It's also the name the terminal uses: <code>roku-pkg generate ${escapeHtml(f.name.trim() || 'Name')}</code>`, f.nameTouched || f.name ? errs.name : undefined)}
        <h3 class="pkg-label">2 · Signing</h3>
        ${field('pkgPkg', 'Signed package (.pkg)', pathBox('pkgPkg', f.signPackageLocation, 'pick-pkg', 'Choose the signed .pkg'), 'The package made with this key, used to rekey the device.')}
        ${field('pkgKey', 'Sign key', `<div class="pkg-row pkg-nowrap"><input id="pkgKey" class="pkg-input pkg-mono" data-role="f-key" type="${d.showKey ? 'text' : 'password'}" autocomplete="off" spellcheck="false" value="${attr(f.signKey)}" placeholder="${d.hasSavedKey ? '•••• key saved. Type to replace' : 'Paste the key from genkey'}" aria-describedby="pkgKey-hint"><button type="button" class="pkg-btn" data-action="toggle-key" aria-pressed="${d.showKey}">${d.showKey ? 'Hide' : 'Show'}</button><button type="button" class="pkg-btn" data-action="paste-key">Paste</button></div>`, d.hasSavedKey ? 'Leave empty to keep the saved key. A saved key is never shown again.' : 'Saved in ~/.roku-pkg/config.json, the same as the CLI.')}
        <h3 class="pkg-label">3 · Output</h3>
        ${field('pkgOut', 'Save package as', pathBox('pkgOut', f.outputLocation, 'pick-output', 'Choose where to save the .pkg', f.outputLocation ? errs.outputLocation : undefined), 'Opens a Save dialog. The suggested name is &lt;Name&gt;.pkg.', f.outputLocation ? errs.outputLocation : undefined)}
        ${d.error ? `<div class="pkg-error-card" role="alert">${escapeHtml(d.error)}</div>` : ''}
      </div>
      <footer class="pkg-row pkg-drawer-foot">
        ${d.mode === 'edit'
          ? d.confirmRemove
            ? `<span class="pkg-bad">Remove ${escapeHtml(d.originalName ?? '')}? The terminal CLI loses it too.</span><button type="button" class="pkg-btn" data-action="remove-confirm">Remove</button><button type="button" class="pkg-link" data-action="remove">Keep</button>`
            : `<button type="button" class="pkg-link pkg-link-quiet" data-action="remove">Remove project…</button>`
          : ''}
        <span class="pkg-spacer"></span>
        <button type="button" class="pkg-btn" data-action="drawer-close">Cancel</button>
        <button type="button" class="pkg-btn pkg-btn-primary" data-action="save" ${valid && !d.saving ? '' : 'disabled'} title="${attr(valid ? '' : Object.values(errs)[0] ?? '')}">${d.saving ? 'Saving…' : d.mode === 'add' ? 'Add project' : 'Save'}</button>
      </footer>
    </aside>`;
}

const drawerActions: Record<string, (el: HTMLElement) => void | Promise<void>> = {
  add: () => openDrawer('add'),
  edit: () => {
    const p = selected();
    if (p) openDrawer('edit', p);
  },
  'drawer-close': () => closeDrawer(),
  'pick-folder': async () => {
    if (!drawer || !api) return;
    const r = await api.pick({ kind: 'folder', defaultPath: drawer.form.rootDir || undefined });
    if (!r.success || !r.path || !drawer) return;
    drawer.form.rootDir = r.path;
    drawer.error = undefined;
    await inspectForDrawer(r.path);
  },
  'pick-pkg': async () => {
    if (!drawer || !api) return;
    const r = await api.pick({ kind: 'pkg', defaultPath: drawer.form.signPackageLocation || undefined });
    if (r.success && r.path && drawer) {
      drawer.form.signPackageLocation = r.path;
      render();
    }
  },
  'pick-output': async () => {
    if (!drawer || !api) return;
    const f = drawer.form;
    // Suggest <app folder>/output/<Name>.pkg: never next to (or onto) the signed rekey package.
    const suggested = f.outputLocation && f.outputLocation !== f.signPackageLocation ? f.outputLocation : `${f.rootDir.replace(/\/+$/, '') || '~'}/output/${f.name.trim() || 'package'}.pkg`;
    const r = await api.pick({ kind: 'save', defaultPath: suggested });
    if (r.success && r.path && drawer) {
      drawer.form.outputLocation = r.path;
      render();
    }
  },
  'toggle-key': () => {
    if (!drawer) return;
    drawer.showKey = !drawer.showKey;
    render();
  },
  'paste-key': async () => {
    if (!drawer) return;
    try {
      drawer.form.signKey = (await navigator.clipboard.readText()).trim();
    } catch {
      drawer.error = 'The clipboard is not available. Paste with ⌘V.';
    }
    render();
  },
  save: async () => {
    if (!drawer || !api) return;
    drawer.saving = true;
    drawer.error = undefined;
    render();
    const f = drawer.form;
    const name = f.name.trim();
    const res = await api.save({ originalName: drawer.originalName, name, rootDir: f.rootDir, signPackageLocation: f.signPackageLocation, outputLocation: f.outputLocation, defaultBuildTask: f.defaultBuildTask || undefined, signKey: f.signKey.trim() || undefined });
    if (!drawer) return;
    drawer.saving = false;
    if (!res.success) {
      drawer.error = res.error ?? 'Could not save.';
      render();
      return;
    }
    if (drawer.originalName && drawer.originalName !== name) choices.delete(drawer.originalName);
    selectedName = name;
    drawer = null;
    await load();
    document.querySelector<HTMLElement>(`#packagerRoot [data-action="select"][data-name="${CSS.escape(name)}"]`)?.focus();
  },
  remove: () => {
    if (!drawer) return;
    drawer.confirmRemove = !drawer.confirmRemove;
    render();
  },
  'remove-confirm': async () => {
    if (!drawer?.originalName || !api) return;
    const name = drawer.originalName;
    const res = await api.remove(name);
    if (!drawer) return;
    if (!res.success) {
      drawer.error = res.error ?? 'Could not remove.';
      drawer.confirmRemove = false;
      render();
      return;
    }
    if (selectedName === name) selectedName = null;
    choices.delete(name);
    runs.delete(name);
    drawer = null;
    await load();
  }
};

/** Escape closes, Tab stays inside the drawer. Returns true when the drawer handled the key. */
function handleDrawerKeydown(e: KeyboardEvent): boolean {
  if (!drawer) return false;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeDrawer();
  } else if (e.key === 'Tab') {
    const items = [...document.querySelectorAll<HTMLElement>('#packagerDrawer .pkg-drawer :is(button:not([disabled]), input, select)')];
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
  return true; // no ⌘↵ or project-list arrows while the drawer is open
}

function handleDrawerInput(e: Event): void {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  if (!drawer) return;
  const f = drawer.form;
  if (el.dataset.role === 'f-name') {
    f.name = el.value;
    f.nameTouched = true;
  } else if (el.dataset.role === 'f-key') f.signKey = el.value;
  else return;
  render();
}

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------

function render(): void {
  const root = document.getElementById('packagerRoot');
  if (!root) return;
  // Keep the focused field (and caret) across a re-render.
  const active = document.activeElement as HTMLInputElement | null;
  const focusRole = active?.getAttribute?.('data-role') ?? null;
  const caret = focusRole && active && 'selectionStart' in active ? active.selectionStart : null;
  const focusAction = active?.getAttribute?.('data-action') ?? null;
  const focusName = active?.getAttribute?.('data-name') ?? null;

  const header = `
    <header class="pkg-header">
      <h1 class="pkg-title"><span aria-hidden="true">📦</span> Packager</h1>
      ${cli?.version ? `<span class="pkg-chip">roku-pkg ${escapeHtml(cli.version)}</span>` : ''}
      <span class="pkg-spacer"></span>
      ${cli?.ok && projects.length ? `<button type="button" class="pkg-btn" data-action="add">+ Add project</button>` : ''}
      <button type="button" class="pkg-icon-btn" data-action="close" aria-label="Close Packager">✕</button>
    </header>`;
  const p = selected();
  const body = !loaded
    ? `<p class="pkg-muted pkg-loading">Loading projects…</p>`
    : listError
      ? `<div class="pkg-error-card" role="alert">${escapeHtml(listError)}</div>`
      : !cli?.ok || !projects.length
        ? renderEmpty()
        : `<div class="pkg-split">${renderRail()}<section class="pkg-workspace" aria-live="polite">${p ? renderWorkspace(p) : ''}</section></div>`;
  root.innerHTML = header + body;

  const drawerEl = document.getElementById('packagerDrawer');
  if (drawerEl) {
    const html = renderDrawer();
    drawerEl.hidden = !html;
    drawerEl.innerHTML = html;
  }

  const scope = document.getElementById(PANEL_ID);
  const refocus = focusRole
    ? scope?.querySelector<HTMLInputElement>(`[data-role="${focusRole}"]`)
    : focusAction
      ? scope?.querySelector<HTMLElement>(`[data-action="${focusAction}"]${focusName ? `[data-name="${CSS.escape(focusName)}"]` : ''}`)
      : null;
  const log = root.querySelector<HTMLElement>('[data-role="log"]');
  if (log) log.scrollTop = log.scrollHeight;
  refocus?.focus();
  if (refocus && caret !== null && 'setSelectionRange' in refocus) (refocus as HTMLInputElement).setSelectionRange(caret, caret);
}

export function openPackager(): void {
  window.dispatchEvent(new CustomEvent('rds:app-panel-open', { detail: PANEL_ID }));
  void load();
}

function closePackager(): void {
  window.dispatchEvent(new CustomEvent('rds:app-panel-close', { detail: PANEL_ID }));
}

// ---------------------------------------------------------------------------------------------
// Actions and events
// ---------------------------------------------------------------------------------------------

/** Click handlers by data-action. */
const actions: Record<string, (el: HTMLElement) => void | Promise<void>> = {
  select: (el) => {
    selectedName = el.dataset.name ?? null;
    // A click always opens the Generate view; only a live run keeps its progress on screen.
    const done = selectedName ? runs.get(selectedName) : undefined;
    if (selectedName && done && done.status !== 'running') runs.delete(selectedName);
    render();
    const p = selected();
    if (p && !inspected.has(p.rootDir)) void inspect(p.rootDir);
  },
  close: () => closePackager(),
  recheck: () => load(true),
  reinspect: () => {
    const p = selected();
    if (p) return inspect(p.rootDir);
  },
  ...drawerActions,
  'build-kind': (el) => {
    const p = selected();
    if (!p) return;
    const info = inspected.get(p.rootDir);
    const kind = el.dataset.kind;
    const c = choiceFor(p.name);
    if (kind === 'task') c.build = { kind, label: (c.build?.kind === 'task' && c.build.label) || p.defaultBuildTask || info?.tasks.find((t) => t.isBuild)?.label || info?.tasks[0]?.label || '' };
    else if (kind === 'existing' || kind === 'none') c.build = { kind };
    render();
  },
  generate: () => startGenerate(),
  cancel: async () => {
    const run = runs.get(selected()?.name ?? '');
    if (!run || !api) return;
    const rekeyTouched = run.steps.rekey.state === 'running' || run.steps.rekey.state === 'done';
    if (rekeyTouched && !window.confirm("Cancel this run? The device stays keyed with this project's signing key.")) return;
    await api.cancel(run.runId);
  },
  reveal: async (el) => {
    await api?.reveal(el.dataset.path ?? '');
  },
  'copy-path': async (el) => {
    const r = await api?.copyPath(el.dataset.path ?? '');
    if (r?.success) {
      el.textContent = 'Copied';
      window.setTimeout(() => render(), 1200);
    }
  },
  again: () => {
    const p = selected();
    if (!p) return;
    runs.delete(p.name);
    return load();
  },
  'rekey-retry': () => {
    const p = selected();
    if (!p) return;
    choiceFor(p.name).skipRekey = false;
    runs.delete(p.name);
    render();
    return startGenerate();
  },
  'toggle-log': () => {
    const p = selected();
    if (!p) return;
    const c = choiceFor(p.name);
    c.logOpen = !c.logOpen;
    render();
  },
  'copy-log': async () => {
    const run = runs.get(selected()?.name ?? '');
    if (run) await navigator.clipboard.writeText(run.log.join('\n'));
  },
  fix: (el) => {
    if (el.dataset.fix === 'edit-signing') return actions.edit(el);
    // Device passwords and the device pool are managed in PR Reviews → Test devices.
    closePackager();
    document.getElementById('titlebarPrReviewsBtn')?.click();
  }
};

function handleKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  if (handleDrawerKeydown(e)) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    const go = document.querySelector<HTMLButtonElement>('#packagerRoot .pkg-go');
    if (go && !go.disabled) {
      e.preventDefault();
      void startGenerate();
    }
    return;
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && target.closest('.pkg-rail-list')) {
    e.preventDefault();
    const items = [...document.querySelectorAll<HTMLElement>('#packagerRoot .pkg-rail-item')];
    const i = items.indexOf(target);
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }
}

export function initPackagerPanel(): void {
  const root = document.getElementById('packagerRoot');
  const drawerEl = document.getElementById('packagerDrawer');
  if (!root || !drawerEl || !api) return;
  for (const container of [root, drawerEl]) {
    container.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      const action = el?.dataset.action;
      if (el && action && actions[action] && !(el as HTMLButtonElement).disabled) void actions[action](el);
    });
  }
  root.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const p = selected();
    if (!p) return;
    const c = choiceFor(p.name);
    const role = el.dataset.role;
    if (role === 'device') c.deviceKey = el.value;
    else if (role === 'task') c.build = { kind: 'task', label: el.value };
    else if (role === 'skip-rekey') c.skipRekey = (el as HTMLInputElement).checked;
    else if (role === 'package-only') c.packageOnly = (el as HTMLInputElement).checked;
    else return;
    render();
  });
  drawerEl.addEventListener('input', handleDrawerInput);
  drawerEl.addEventListener('change', handleDrawerInput);
  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.role === 'filter') {
      filter = el.value;
      render();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (isOpen()) handleKeydown(e);
  });
  api.onUpdate((state) => {
    runs.set(state.project, state);
    if (state.status !== 'running') return void load(); // refresh history, chips and devices
    if (!isOpen()) return;
    // Re-render only the project on screen, and never under an open drawer or a focused <select>:
    // a rebuild would close the dropdown or wipe a half-typed field.
    const busyInput = document.activeElement?.tagName === 'SELECT' && !!document.activeElement.closest(`#${PANEL_ID}`);
    if (state.project === selectedName && !drawer && !busyInput) render();
    else patchRailChip(state.project);
  });
  // Keep device reachability fresh while the panel is open (a TV can be switched off at any time).
  window.setInterval(async () => {
    if (!isOpen() || !api || drawer) return;
    const res = await api.devices();
    if (!res.success || JSON.stringify(res.devices) === JSON.stringify(devices)) return;
    devices = res.devices;
    const busyInput = document.activeElement?.tagName === 'SELECT' && !!document.activeElement.closest(`#${PANEL_ID}`);
    if (!busyInput && runs.get(selectedName ?? '')?.status !== 'running') render();
  }, 10_000);
  // Tick the elapsed time of a live run without re-rendering.
  window.setInterval(() => {
    const run = runs.get(selected()?.name ?? '');
    const el = document.querySelector<HTMLElement>('#packagerRoot [data-role-elapsed]');
    if (el && run?.status === 'running') el.textContent = elapsed(run);
  }, 1000);
  for (const id of ['titlebarPackagerBtn', 'sidebarPackagerBtn', 'welcomePackagerCta']) {
    document.getElementById(id)?.addEventListener('click', () => openPackager());
  }
}

