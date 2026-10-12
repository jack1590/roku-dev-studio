/**
 * PR Reviews panel (main window).
 *
 * An app-level panel, not a device tab. Opened from the sidebar, the title bar (when the sidebar
 * is collapsed), or the welcome screen. It asks app.ts to show it via the `rds:app-panel-open`
 * event, so no device tab stays active behind it, and `rds:app-panel-close` returns to the
 * previous device tab or the welcome screen.
 *
 * Home is one flat list of open PRs from the repos chosen for the selected project, narrowed by
 * filters (Needs you / Mine / Problems / All), a repo dropdown, and search. Choosing repos
 * happens in a side drawer ("Repos"), or inline the first time, when nothing is chosen yet.
 * Repos come from every org the project's GitHub token can see. Only repo names
 * and PR metadata cross IPC; the token stays in the main process.
 */

import { PR_FILTERS, matchesFilter, matchesSearch, prState, timeAgo } from '@shared/pr-list.js';
import type { PrFilter, PullRequestItem } from '@shared/pr-list.js';

interface ProjectItem {
  id: string;
  name: string;
  repos?: string[];
  models?: Record<string, string>;
  tokens: { github: boolean; cursor?: boolean; jira: boolean; figma: boolean };
}

type FindingStatus = 'issue' | 'needs-device' | 'noted' | 'dismissed';

interface ReviewDevice {
  key: string;
  ip: string;
  name: string;
}

/** A device in the test pool, or one found by a network scan. */
interface DeviceOption extends ReviewDevice {
  model?: string;
  hasPassword: boolean;
  /** "owner/repo#n" of the review running on it (pool only). */
  busyWith?: string;
  /** Answering on the network right now (pool only). */
  online?: boolean;
  lastSeen?: number;
}

interface ReviewSummary {
  projectId: string;
  repo: string;
  number: number;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  phase?: string;
  detail?: string;
  error?: string;
  headSha?: string;
  counts?: Record<FindingStatus, number>;
  deviceRecommended?: boolean;
  finishedAt?: number;
  device?: ReviewDevice;
  lostLenses?: string[];
  deviceSkipped?: string;
}

interface ReviewFinding {
  id: string;
  title: string;
  detail: string;
  severity: 'info' | 'minor' | 'major' | 'critical';
  file?: string;
  line?: number;
  status: FindingStatus;
  deviceCheck?: string;
  confidence?: number;
  reasoning: string;
  sources: string[];
  comment?: string;
  deviceEvidence?: string;
  tests?: string[];
  ci?: { check: string; url?: string };
  userDismissed?: { at: number; reason?: string; previousStatus: FindingStatus; remembered: boolean; prNumber?: number };
}

interface DeviceRound {
  index: number;
  goal: string;
  /** Device checks run PR tests; older reviews ran UI steps (prints/steps/screenshots). */
  tests?: string[];
  result?: 'PASS' | 'FAIL';
  prints?: number;
  steps?: number;
  stepList?: string[];
  build: string;
  sideload: string;
  error?: string;
  buildLog?: string;
  console: string;
  screenshots?: string[];
  outcomes: { id: string; outcome: 'confirmed' | 'refuted' | 'inconclusive'; evidence: string }[];
}

interface RunCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  rawCents: number;
  chargedCents: number;
  costMissing: number;
  estCents?: number;
}

const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** "≈ $1.23"; "≥" when Cursor had not reported the cost of some runs yet. */
/** Cursor's own cost when it reported one; else our table's estimate ("est."); else nothing. */
const formatPrice = (u: RunCost) =>
  u.rawCents && !u.costMissing ? `≈ $${(u.rawCents / 100).toFixed(2)}` : u.estCents ? `est. $${(u.estCents / 100).toFixed(2)}` : u.rawCents ? `≥ $${(u.rawCents / 100).toFixed(2)}` : 'price not reported';

function usageLine(u: RunCost): string {
  const charged = !u.costMissing && Math.abs(u.chargedCents - u.rawCents) >= 1 ?` (charged $${(u.chargedCents / 100).toFixed(2)})` : '';
  return `${formatTokens(u.total)} tokens · ${formatPrice(u)}${charged}`;
}

interface DeviceReport {
  status: 'done' | 'blocked' | 'failed' | 'timeout' | 'cancelled';
  reason?: string;
  device?: { name: string; ip: string };
  rounds: DeviceRound[];
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  usage?: RunCost;
}

interface StoredReview {
  repo: string;
  number: number;
  title: string;
  url: string;
  device?: ReviewDevice;
  result: {
    headSha: string;
    startedAt: number;
    finishedAt: number;
    summary: string;
    reviewBody?: string;
    deviceRecommended: boolean;
    deviceReason?: string;
    findings: ReviewFinding[];
    counts: Record<FindingStatus, number>;
    agents: { role: string; model: string; status: string; error?: string; findings?: number; kept?: number; retried?: boolean; toolCalls?: number; durationMs?: number; tokens?: number; usage?: RunCost }[];
    device?: DeviceReport;
    usage?: RunCost;
    lostLenses?: string[];
    ci?: { checks: { name: string; state: string; url?: string; annotations: number }[]; infra: string[]; error?: string };
    incremental?: { sinceSha: string; carried: number; rechecked: number };
    context: { standards: string[]; wikiPages: string[]; instructions: boolean; diffNotes: string[]; files: number; ticket?: { key: string; url: string; summary: string; type?: string; status?: string; foundIn: string; figmaLinks: string[] }; ticketNote?: string };
  };
}

interface ReviewsApi {
  start: (input: { projectId: string; repo: string; number: number }) => Promise<{ success: boolean; summary?: ReviewSummary; error?: string }>;
  cancel: (input: { projectId: string; repo: string; number: number }) => Promise<{ success: boolean; error?: string }>;
  list: (projectId: string) => Promise<{ success: boolean; reviews?: ReviewSummary[] }>;
  get: (input: { projectId: string; repo: string; number: number }) => Promise<{ success: boolean; review?: StoredReview; error?: string }>;
  devices: () => Promise<{ success: boolean; devices?: DeviceOption[] }>;
  setDevicePassword: (input: { key: string; ip: string; password: string }) => Promise<{ success: boolean; error?: string }>;
  discover: () => Promise<{ success: boolean; devices?: DeviceOption[] }>;
  setPool: (devices: { key: string; ip: string; name: string; model?: string }[]) => Promise<{ success: boolean }>;
  screenshot: (input: { projectId: string; repo: string; number: number; name: string }) => Promise<{ success: boolean; dataUrl?: string }>;
  onUpdate: (callback: (summary: ReviewSummary) => void) => () => void;
  postingState: (input: { projectId: string; repo: string; number: number }) => Promise<{ success: boolean; state?: PostingState; run?: PostRun | null }>;
  saveComment: (input: { projectId: string; repo: string; number: number; id: string; text: string | null }) => Promise<{ success: boolean; state?: PostingState; error?: string }>;
  post: (input: { projectId: string; repo: string; number: number; ids: string[]; general: string | null; spaced: boolean; maxMinutes: number }) => Promise<{ success: boolean; run?: PostRun; error?: string }>;
  onPostUpdate: (callback: (update: PostRun) => void) => () => void;
  dismiss: (input: { projectId: string; repo: string; number: number; id: string; reason: string }) => Promise<{ success: boolean; review?: StoredReview; error?: string }>;
  restoreFinding: (input: { projectId: string; repo: string; number: number; id: string }) => Promise<{ success: boolean; review?: StoredReview; error?: string }>;
}

interface PostingState {
  edits: Record<string, string>;
  posted: Record<string, { at: number; url?: string }>;
}

interface PostRun {
  projectId: string;
  repo: string;
  number: number;
  state: 'running' | 'done' | 'failed';
  queue: string[];
  current?: string;
  nextAt?: number;
  posted: PostingState['posted'];
  errors: Record<string, string>;
}

interface ScanResult {
  login: string;
  orgs: string[];
  skipped: { org: string; reason: string }[];
  repos: string[];
  truncated: boolean;
}

interface PrData {
  items: PullRequestItem[];
  viewer: string;
  failed: { repo: string; reason: string }[];
  truncatedRepos: string[];
  fetchedAt: number;
}

interface ProjectsApi {
  list: () => Promise<{ success: boolean; projects?: ProjectItem[] }>;
  scanRepos: (id: string) => Promise<{ success: boolean; error?: string } & Partial<ScanResult>>;
  setRepos: (id: string, repos: string[]) => Promise<{ success: boolean; project?: ProjectItem; error?: string }>;
  listPrs: (id: string) => Promise<{ success: boolean; error?: string; pullRequests?: PullRequestItem[]; viewer?: string; failed?: PrData['failed']; truncatedRepos?: string[]; fetchedAt?: number }>;
}

const PANEL_ID = 'prReviewsPanel';
/** Most rows shown in the repo picker at once; its filter narrows the rest. */
const BROWSE_LIMIT = 50;
/** PR rows rendered at once; "Show more" adds another page. */
const PR_PAGE = 100;
const SKELETON_ROWS = 6;
/** Re-fetch while the panel is open once the data is this old. */
const REFRESH_MS = 5 * 60 * 1000;

const api = (window as unknown as { rdsProjects?: ProjectsApi }).rdsProjects;
const reviewsApi = (window as unknown as { rdsReviews?: ReviewsApi }).rdsReviews;

let projects: ProjectItem[] = [];
let selectedId: string | null = null;
/** Project ids with a scan or PR fetch in flight. Per project, so switching projects never blocks a fetch. */
const scanningIds = new Set<string>();
const loadingPrIds = new Set<string>();
let error = '';
let prError = '';

// PR list view state
let prFilter: PrFilter = 'needs-you';
let repoFilter = '';
let search = '';
let visibleLimit = PR_PAGE;

// Repo picker state
let drawerOpen = false;
/** First run: stay in the inline picker until the user clicks Done, so several repos can be added. */
let picking = false;
let reposDirty = false;
let pickerFilter = '';

/** Per project, so switching projects does not refetch. */
const scanned = new Map<string, ScanResult>();
const prData = new Map<string, PrData>();

// Reviews and devices
/** projectId → "owner/repo#n" → latest status, kept live by main-process updates. */
const reviews = new Map<string, Map<string, ReviewSummary>>();
/** The test device pool (shared by every project). Device runs take any free, ready device. */
let devices: DeviceOption[] = [];
/** Last network scan. */
let found: DeviceOption[] = [];
let devicesOpen = false;
let discovering = false;
let discoverError = '';
/** Posting for the review open in the drawer: what is chosen, edited, posted, and a running queue. */
let posting: {
  key: string;
  state: PostingState;
  run: PostRun | null;
  /** Postable comments the user unticked (all start ticked). */
  unchecked: Set<string>;
  general: boolean;
  editing: string | null;
  draft: string;
  spaced: boolean;
  maxMinutes: number;
  error: string;
} | null = null;
const GENERAL_ID = 'general';

/** The review result shown in the drawer, if any. */
/** The finding whose Dismiss form is open, and the last dismiss error. */
let dismissing: { id: string; error?: string } | null = null;
let reviewView: { repo: string; number: number; loading: boolean; data?: StoredReview; error?: string } | null = null;

const reviewKey = (repo: string, number: number) => `${repo}#${number}`;

function reviewFor(project: ProjectItem, pr: { repo: string; number: number }): ReviewSummary | undefined {
  return reviews.get(project.id)?.get(reviewKey(pr.repo, pr.number));
}

/** Why a review cannot start for this project, or null when it can. */
function reviewBlocker(project: ProjectItem): string | null {
  if (!project.tokens.cursor) return 'Add a Cursor API key in Settings → Projects to run reviews.';
  const models = project.models ?? {};
  if (!models.judge || !(models.reviewer1 || models.reviewer2 || models.reviewer3)) return 'Choose review models in Settings → Projects → AI review.';
  return null;
}

async function loadDevices(): Promise<void> {
  if (!reviewsApi) return;
  const res = await reviewsApi.devices();
  const next = res?.success ? res.devices ?? [] : [];
  // Redraw only when something about the devices changed (avoids the panel blinking on every poll).
  if (JSON.stringify(next) === JSON.stringify(devices)) return;
  devices = next;
  render();
}

/** While the Test devices panel is open, re-check reachability now and then. */
let devicePoll: number | undefined;

/** Same scan as the sidebar (SSDP, then subnet sweep), run in the main process. */
async function discoverDevices(): Promise<void> {
  if (!reviewsApi || discovering) return;
  discovering = true;
  discoverError = '';
  render();
  const res = await reviewsApi.discover();
  discovering = false;
  found = res?.success ? res.devices ?? [] : [];
  if (!res?.success) discoverError = 'The scan failed. Check the network and try again.';
  await loadDevices();
}

async function setPool(next: DeviceOption[]): Promise<void> {
  if (!reviewsApi) return;
  await reviewsApi.setPool(next.map(({ key, ip, name, model }) => ({ key, ip, name, model })));
  await loadDevices();
}

async function addToPool(key: string): Promise<void> {
  const device = found.find((d) => d.key === key);
  if (!device || devices.some((d) => d.key === key)) return;
  await setPool([...devices, device]);
  if (!device.hasPassword) openPasswordDialog(device);
}

/** Native modal for one device's dev password: checked on the device, then saved. */
function openPasswordDialog(device: ReviewDevice): void {
  if (!reviewsApi) return;
  const api = reviewsApi;
  const input = h('input', { type: 'password', class: 'prr-input', placeholder: 'Dev password', autocomplete: 'off', 'aria-label': `Dev password for ${device.name}` }) as HTMLInputElement;
  const errorText = h('p', { class: 'prr-device-pass-error', role: 'alert' });
  const save = h('button', { type: 'submit', class: 'prr-btn prr-btn-primary' }, ['Save password']) as HTMLButtonElement;
  const cancel = h('button', { type: 'button', class: 'prr-btn prr-btn-ghost' }, ['Cancel']);
  const form = h('form', { class: 'prr-dialog-body' }, [
    h('h2', { class: 'prr-drawer-title' }, [`Dev password for ${device.name}`]),
    h('p', { class: 'prr-subtitle' }, [`${device.ip}. Checked on the device, then saved encrypted in the app, the same place Dev App uses. Never sent to the AI.`]),
    input,
    errorText,
    h('div', { class: 'prr-dialog-actions' }, [cancel, save]),
  ]);
  const dialog = h('dialog', { class: 'prr-dialog', 'aria-label': `Dev password for ${device.name}` }, [form]) as HTMLDialogElement;
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!input.value) {
      errorText.textContent = 'Enter the dev password.';
      return;
    }
    save.disabled = input.disabled = true;
    save.textContent = 'Checking…';
    errorText.textContent = '';
    void api.setDevicePassword({ key: device.key, ip: device.ip, password: input.value }).then((res) => {
      if (res?.success) {
        dialog.close();
        void loadDevices();
        return;
      }
      save.disabled = input.disabled = false;
      save.textContent = 'Save password';
      errorText.textContent = res?.error || 'Could not save the password.';
      input.select();
    });
  });
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}

async function loadReviews(project: ProjectItem): Promise<void> {
  if (!reviewsApi) return;
  const res = await reviewsApi.list(project.id);
  const map = new Map<string, ReviewSummary>();
  for (const summary of res?.reviews ?? []) map.set(reviewKey(summary.repo, summary.number), summary);
  reviews.set(project.id, map);
  render();
}

async function startReview(project: ProjectItem, repo: string, number: number): Promise<void> {
  if (!reviewsApi) return;
  const res = await reviewsApi.start({ projectId: project.id, repo, number });
  if (res?.success && res.summary) {
    applySummary(res.summary);
  } else {
    error = res?.error || 'Could not start the review.';
    render();
  }
}

function applySummary(summary: ReviewSummary): void {
  if (!reviews.has(summary.projectId)) reviews.set(summary.projectId, new Map());
  const previous = reviews.get(summary.projectId)!.get(reviewKey(summary.repo, summary.number));
  reviews.get(summary.projectId)!.set(reviewKey(summary.repo, summary.number), summary);
  // A device was taken or freed: refresh the pool's busy state.
  if (previous?.phase !== summary.phase && (previous?.phase === 'device' || summary.phase === 'device')) void loadDevices();
  // A finished review refreshes the open result drawer for that PR.
  if (reviewView && summary.status === 'done' && reviewView.repo === summary.repo && reviewView.number === summary.number) void openReview(summary.repo, summary.number);
  render();
}

async function openReview(repo: string, number: number): Promise<void> {
  const project = selected();
  if (!project || !reviewsApi) return;
  reviewView = { repo, number, loading: true };
  dismissing = null;
  drawerOpen = false;
  render();
  const res = await reviewsApi.get({ projectId: project.id, repo, number });
  if (!reviewView || reviewView.repo !== repo || reviewView.number !== number) return;
  reviewView = res?.success && res.review ? { repo, number, loading: false, data: res.review } : { repo, number, loading: false, error: res?.error || 'Could not load the review.' };
  const key = `${project.id}|${repo}#${number}`;
  if (res?.success && posting?.key !== key) {
    const ps = await reviewsApi.postingState({ projectId: project.id, repo, number });
    posting = { key, state: ps?.state ?? { edits: {}, posted: {} }, run: ps?.run ?? null, unchecked: new Set(), general: false, editing: null, draft: '', spaced: true, maxMinutes: 5, error: '' };
  }
  render();
  document.querySelector<HTMLElement>('#prReviewsDrawer .prr-close')?.focus();
}

function h(tag: string, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function icon(name: string): HTMLElement {
  const span = h('span', { class: 'icon icon-sm', 'aria-hidden': 'true' });
  span.innerHTML = `<svg><use href="#${name}"/></svg>`;
  return span;
}

function panel(): HTMLElement | null {
  return document.getElementById(PANEL_ID);
}

function isOpen(): boolean {
  return panel()?.classList.contains('active') ?? false;
}

function selected(): ProjectItem | undefined {
  return projects.find((p) => p.id === selectedId);
}

function chosenRepos(project: ProjectItem): string[] {
  return project.repos ?? [];
}

/** Repos that match the picker filter and are not already chosen, capped for display. */
function browseMatches(project: ProjectItem): { shown: string[]; total: number } {
  const all = scanned.get(project.id)?.repos ?? [];
  const chosen = new Set(chosenRepos(project));
  const needle = pickerFilter.trim().toLowerCase();
  const matches = all.filter((repo) => !chosen.has(repo) && repo.toLowerCase().includes(needle));
  return { shown: matches.slice(0, BROWSE_LIMIT), total: matches.length };
}

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

async function loadProjects(): Promise<void> {
  if (!api) return;
  const res = await api.list();
  projects = res?.success ? res.projects ?? [] : [];
  if (!projects.some((p) => p.id === selectedId)) selectedId = projects[0]?.id ?? null;
  const project = selected();
  picking = project ? chosenRepos(project).length === 0 : false;
  render();
  void loadDevices();
  if (project) {
    void loadReviews(project);
    await onProjectReady(project);
  }
}

/** Fetch whatever the visible view needs: the picker's scan, or the PR list. */
async function onProjectReady(project: ProjectItem): Promise<void> {
  if (!project.tokens.github) return;
  if (isPicking(project) && !scanned.has(project.id)) void scan(project);
  if (chosenRepos(project).length > 0) {
    const cached = prData.get(project.id);
    if (!cached || Date.now() - cached.fetchedAt > REFRESH_MS) await loadPrs(project);
  }
}

function isScanning(project: ProjectItem): boolean {
  return scanningIds.has(project.id);
}

function isLoadingPrs(project: ProjectItem): boolean {
  return loadingPrIds.has(project.id);
}

function isPicking(project: ProjectItem): boolean {
  return picking || chosenRepos(project).length === 0;
}

async function scan(project: ProjectItem): Promise<void> {
  if (!api) return;
  if (scanningIds.has(project.id)) return;
  scanningIds.add(project.id);
  error = '';
  render();
  const res = await api.scanRepos(project.id);
  scanningIds.delete(project.id);
  if (res?.success) {
    scanned.set(project.id, {
      login: res.login ?? '',
      orgs: res.orgs ?? [],
      skipped: res.skipped ?? [],
      repos: res.repos ?? [],
      truncated: Boolean(res.truncated),
    });
  } else {
    error = res?.error || 'Could not scan repos.';
  }
  render();
  // The filter box appears only once the scan finishes; move focus there if it is still outside the drawer.
  if (drawerOpen && !document.activeElement?.closest('#prReviewsDrawer')) focusDrawer();
}

async function loadPrs(project: ProjectItem, quiet = false): Promise<void> {
  if (!api || loadingPrIds.has(project.id)) return;
  loadingPrIds.add(project.id);
  prError = '';
  if (!quiet) render();
  const res = await api.listPrs(project.id);
  loadingPrIds.delete(project.id);
  if (res?.success) {
    prData.set(project.id, {
      items: res.pullRequests ?? [],
      viewer: res.viewer ?? '',
      failed: res.failed ?? [],
      truncatedRepos: res.truncatedRepos ?? [],
      fetchedAt: res.fetchedAt ?? Date.now(),
    });
  } else {
    prError = res?.error || 'Could not load pull requests.';
  }
  render();
}

async function saveRepos(project: ProjectItem, repos: string[]): Promise<void> {
  if (!api) return;
  const res = await api.setRepos(project.id, repos);
  if (!res?.success || !res.project) {
    error = res?.error || 'Could not save repos.';
  } else {
    error = '';
    reposDirty = true;
    const updated = res.project;
    projects = projects.map((p) => (p.id === project.id ? updated : p));
  }
  render();
}

function openSettingsProjects(): void {
  (window as unknown as { roku?: { openSettings?: (section?: string) => void } }).roku?.openSettings?.('projects');
}

function openPrUrl(url: string): void {
  // Only github.com PR links are opened; the main process also restricts schemes.
  if (!url.startsWith('https://github.com/')) return;
  void (window as unknown as { roku?: { openExternal?: (url: string) => Promise<unknown> } }).roku?.openExternal?.(url);
}

// ---------------------------------------------------------------------------------------------
// Repo picker (drawer, or inline on first run)
// ---------------------------------------------------------------------------------------------

/** "owner/name" with the owner dimmed, so the repo name is what the eye lands on. */
function repoLabel(repo: string): HTMLElement {
  const slash = repo.indexOf('/');
  return h('span', { class: 'prr-repo', title: repo }, [
    h('span', { class: 'prr-owner' }, [repo.slice(0, slash + 1)]),
    h('span', { class: 'prr-name' }, [repo.slice(slash + 1)]),
  ]);
}

function iconButton(action: string, repo: string, label: string, glyph: string): HTMLElement {
  return h('button', { type: 'button', class: `prr-icon-btn prr-icon-btn-${action}`, 'data-action': action, 'data-repo': repo, 'aria-label': label, title: label }, [glyph]);
}

function renderSkeleton(rows: number, tall = false): HTMLElement {
  return h(
    'ul',
    { class: 'prr-list', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: rows }, (_, i) => h('li', { class: `prr-row prr-skel${tall ? ' prr-skel-tall' : ''}`, style: `--w:${55 + ((i * 17) % 35)}%` }, []))
  );
}

function cardHeader(title: string, count: number | null, action?: HTMLElement): HTMLElement {
  return h('header', { class: 'prr-card-head' }, [
    h('h3', { class: 'prr-card-title' }, [title, count === null ? '' : h('span', { class: 'prr-count' }, [String(count)])]),
    action ?? h('span', {}, []),
  ]);
}

function emptyState(lines: string[], action?: HTMLElement): HTMLElement {
  return h('div', { class: 'prr-empty' }, [
    ...lines.map((line, i) => h('p', { class: i === 0 ? 'prr-empty-title' : 'prr-empty-hint' }, [line])),
    ...(action ? [action] : []),
  ]);
}

function renderScanBar(project: ProjectItem): HTMLElement {
  const result = scanned.get(project.id);
  const orgCount = result ? (result.orgs.length === 1 ? '1 org' : `${result.orgs.length} orgs`) : '';
  const chip =
    result && !isScanning(project)
      ? h('span', { class: 'prr-chip', title: result.orgs.length ? `${result.login} · ${result.orgs.join(', ')}` : result.login }, [
          `${result.repos.length}${result.truncated ? '+' : ''} repos · ${orgCount} + ${result.login}`,
        ])
      : h('span', {}, []);
  const rescan = h('button', { type: 'button', class: 'prr-btn', 'data-action': 'rescan' }, [icon('icon-refresh'), isScanning(project) ? 'Scanning…' : 'Rescan']);
  rescan.toggleAttribute('disabled', isScanning(project));
  return h('div', { class: 'prr-scanbar' }, [chip, rescan]);
}

function renderBrowse(project: ProjectItem): HTMLElement {
  const title = 'Available repos';
  if (isScanning(project) && !scanned.has(project.id)) return h('section', { class: 'prr-card' }, [cardHeader(title, null), renderSkeleton(SKELETON_ROWS)]);
  if (!scanned.has(project.id)) {
    return h('section', { class: 'prr-card' }, [
      cardHeader(title, null),
      emptyState(['Scan to list the repositories this token can read.'], h('button', { type: 'button', class: 'prr-btn prr-btn-primary', 'data-action': 'rescan' }, ['Scan repos'])),
    ]);
  }

  const { shown, total } = browseMatches(project);
  const needle = pickerFilter.trim();
  const addAll = shown.length > 1 ? h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'add-all' }, [`Add all ${shown.length}`]) : undefined;

  const input = h('input', {
    type: 'search',
    class: 'prr-input',
    placeholder: 'Filter repos — Enter adds the first match',
    'aria-label': 'Filter repos',
    'data-role': 'picker-filter',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;
  input.value = pickerFilter;

  const list =
    shown.length === 0
      ? emptyState([needle ? `No repos match “${needle}”.` : 'Every repo is already added.'])
      : h('ul', { class: 'prr-list' }, shown.map((repo) => h('li', { class: 'prr-row' }, [repoLabel(repo), iconButton('add-repo', repo, `Add ${repo}`, '+')])));
  const more = total > shown.length ? h('p', { class: 'prr-foot' }, [`Showing ${shown.length} of ${total}. Type to narrow.`]) : h('span', {}, []);

  return h('section', { class: 'prr-card' }, [cardHeader(title, total, addAll), input, list, more]);
}

function renderChosen(project: ProjectItem): HTMLElement {
  const chosen = chosenRepos(project);
  const clear = chosen.length > 1 ? h('button', { type: 'button', class: 'prr-link-btn prr-link-danger', 'data-action': 'remove-all' }, ['Remove all']) : undefined;
  const body =
    chosen.length === 0
      ? emptyState(['Nothing to review yet.', 'Add repos from the list to review their PRs.'])
      : h('ul', { class: 'prr-list' }, chosen.map((repo) => h('li', { class: 'prr-row' }, [repoLabel(repo), iconButton('remove-repo', repo, `Remove ${repo}`, '×')])));
  return h('section', { class: 'prr-card prr-card-chosen' }, [cardHeader('Repos to review', chosen.length, clear), body]);
}

function renderSkippedWarning(project: ProjectItem): HTMLElement | null {
  const skipped = scanned.get(project.id)?.skipped ?? [];
  if (!skipped.length || isScanning(project)) return null;
  return h('div', { class: 'prr-warn', role: 'status' }, [
    h('strong', {}, ['Skipped: ']),
    skipped.map((s) => `${s.org} (${s.reason})`).join(', '),
    skipped.some((x) => x.reason.includes('SSO')) ? '. Authorize the token for SSO in those orgs on GitHub, then Rescan.' : '. Check the token’s access to those orgs, then Rescan.',
  ]);
}

function renderPicker(project: ProjectItem, layout: 'grid' | 'stack'): HTMLElement[] {
  const nodes: HTMLElement[] = [renderScanBar(project)];
  if (error) nodes.push(h('div', { class: 'prr-alert', role: 'alert' }, [error]));
  const warning = renderSkippedWarning(project);
  if (warning) nodes.push(warning);
  nodes.push(h('div', { class: layout === 'grid' ? 'prr-grid' : 'prr-stack' }, [renderBrowse(project), renderChosen(project)]));
  return nodes;
}

const SEVERITY_TONE: Record<ReviewFinding['severity'], string> = { critical: 'danger', major: 'danger', minor: 'warn', info: 'muted' };

function fileUrl(repo: string, sha: string, file: string, line?: number): string {
  return `https://github.com/${repo}/blob/${sha}/${file.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`;
}

/** A GitHub-style preview of a comment the review would post, with a copy button. Nothing is posted yet. */
function renderCommentPreview(title: string, text: string, note = ''): HTMLElement {
  return h('div', { class: 'prr-comment' }, [
    h('div', { class: 'prr-comment-head' }, [
      h('span', { class: 'prr-comment-title' }, [title]),
      h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'copy-comment', 'data-text': text }, ['Copy']),
    ]),
    h('p', { class: 'prr-comment-body' }, [text]),
    ...(note ? [h('p', { class: 'prr-comment-note' }, [note])] : []),
  ]);
}

function renderFinding(repo: string, sha: string, f: ReviewFinding): HTMLElement {
  return h('article', { class: `prr-finding prr-finding-${f.status}` }, [
    h('header', { class: 'prr-finding-head' }, [
      h('span', { class: `prr-pill prr-pill-${SEVERITY_TONE[f.severity]}` }, [f.severity]),
      h('h4', { class: 'prr-finding-title' }, [f.title]),
    ]),
    ...(f.file
      ? [h('button', { type: 'button', class: 'prr-link-btn prr-finding-loc', 'data-action': 'open-pr', 'data-url': fileUrl(repo, sha, f.file, f.line), title: 'Open on GitHub at the reviewed commit' }, [`${f.file}${f.line ? `:${f.line}` : ''}`])]
      : []),
    ...(f.detail ? [h('p', { class: 'prr-finding-detail' }, [f.detail])] : []),
    ...(f.ci ? [h('div', { class: 'prr-finding-ci' }, [h('span', { class: 'prr-pill prr-pill-info' }, ['From CI']), ' ', f.ci.url ? h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'open-pr', 'data-url': f.ci.url }, [f.ci.check]) : f.ci.check, ' · a fact from the check run, not judged'])] : []),
    ...(f.deviceCheck ? [h('div', { class: 'prr-finding-device' }, [h('strong', {}, [f.deviceEvidence ? 'Device check: ' : 'Verify on a device: ']), f.deviceCheck])] : []),
    ...(f.status === 'needs-device'
      ? [h('p', { class: 'prr-finding-tests prr-muted' }, [f.tests?.length ? `PR tests that exercise it: ${f.tests.join(', ')}` : 'No test in this PR covers it: verify it manually (use Copy fix prompt), or ask the author for a test.'])]
      : []),
    ...(f.deviceEvidence ? [h('div', { class: 'prr-evidence' }, [h('span', { class: 'prr-evidence-title' }, ['Device evidence']), h('pre', { class: 'prr-pre' }, [f.deviceEvidence])])] : []),
    ...(f.comment && f.status !== 'dismissed'
      ? [
          posting && (f.status === 'issue' || f.status === 'needs-device')
            ? renderPostableComment(f.id, f.file ? `Comment on ${f.file}${f.line ? `:${f.line}` : ''}` : 'Comment (posted as a plain PR comment)', commentText(f), {
                original: f.comment,
                tickable: true,
                ticked: !posting.unchecked.has(f.id),
                note: f.status === 'needs-device' ? 'Not verified on a device yet: worded as something to check.' : '',
              })
            : renderCommentPreview(f.file ? `Comment on ${f.file}${f.line ? `:${f.line}` : ''}` : 'Comment', f.comment),
        ]
      : []),
    ...(f.reasoning ? [h('p', { class: 'prr-finding-reason' }, [h('strong', {}, ['Judge: ']), f.reasoning])] : []),
    h('div', { class: 'prr-finding-meta' }, [
      ...(f.sources.length ? [h('span', {}, [`Raised by ${f.sources.join(', ')}`])] : []),
      ...(f.confidence !== undefined ? [h('span', {}, [`Confidence ${Math.round(f.confidence * 100)}%`])] : []),
      ...(!f.ci && f.status !== 'dismissed' && dismissing?.id !== f.id
        ? [h('button', { type: 'button', class: 'prr-link-btn prr-dismiss-btn', 'data-action': 'dismiss-finding', 'data-id': f.id, title: 'Not worth raising: move it to Dismissed and stop raising it in this repo' }, ['Dismiss…'])]
        : []),
    ]),
    ...(dismissing?.id === f.id ? [renderDismissForm(f)] : []),
    ...(f.userDismissed ? [renderUserDismissed(f)] : []),
  ]);
}

function renderDismissForm(f: ReviewFinding): HTMLElement {
  return h('div', { class: 'prr-dismiss-form' }, [
    h('label', { class: 'prr-dismiss-label', for: `prr-dismiss-${f.id}` }, ['Why is it not worth raising? (optional, the reviewers see it)']),
    h('input', { type: 'text', id: `prr-dismiss-${f.id}`, class: 'prr-input', 'data-role': 'dismiss-reason', 'data-id': f.id, maxlength: '400', placeholder: 'e.g. We keep magic numbers in theme files on purpose' }),
    h('p', { class: 'prr-muted' }, ['Stops raising it on this file. Dismiss it a second time on any PR and it stops everywhere in the repo.']),
    ...(dismissing?.error ? [h('p', { class: 'prr-alert', role: 'alert' }, [dismissing.error])] : []),
    h('div', { class: 'prr-dismiss-actions' }, [
      h('button', { type: 'button', class: 'prr-btn', 'data-action': 'cancel-dismiss' }, ['Cancel']),
      h('button', { type: 'button', class: 'prr-btn prr-btn-primary', 'data-action': 'confirm-dismiss', 'data-id': f.id }, ['Dismiss']),
    ]),
  ]);
}

function renderUserDismissed(f: ReviewFinding): HTMLElement {
  const d = f.userDismissed!;
  const when = new Date(d.at).toLocaleDateString();
  const label = d.remembered ? `You dismissed this before${d.prNumber ? ` on #${d.prNumber}` : ''} (${when})` : `You dismissed this (${when})`;
  return h('div', { class: 'prr-user-dismissed' }, [
    h('span', { class: 'prr-pill prr-pill-muted' }, [label]),
    ...(d.reason ? [h('span', { class: 'prr-muted' }, [d.reason])] : []),
    h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'restore-finding', 'data-id': f.id, title: 'Raise it again: put it back and forget the dismissal for this repo' }, ['Restore']),
  ]);
}

async function dismissAction(action: 'confirm-dismiss' | 'restore-finding', id: string): Promise<void> {
  const project = selected();
  const data = reviewView?.data;
  if (!project || !data || !reviewsApi) return;
  const ref = { projectId: project.id, repo: data.repo, number: data.number, id };
  const reason = document.querySelector<HTMLInputElement>(`#prReviewsDrawer [data-role="dismiss-reason"][data-id="${id}"]`)?.value ?? '';
  const res = action === 'confirm-dismiss' ? await reviewsApi.dismiss({ ...ref, reason }) : await reviewsApi.restoreFinding(ref);
  if (!reviewView?.data || reviewView.data !== data) return;
  if (res?.success && res.review) {
    reviewView.data = res.review;
    dismissing = null;
  } else if (action === 'confirm-dismiss') dismissing = { id, error: res?.error || 'Could not dismiss.' };
  renderDrawer(project);
}

const shotCache = new Map<string, string>();

/** Screenshot <img> tags get their data URL after render, from the main process. */
function hydrateScreenshots(project: ProjectItem): void {
  if (!reviewView || !reviewsApi) return;
  const view = reviewView;
  document.querySelectorAll<HTMLImageElement>('#prReviewsDrawer img[data-shot]').forEach((img) => {
    const name = img.dataset.shot ?? '';
    const key = `${view.repo}#${view.number}/${name}`;
    const cached = shotCache.get(key);
    if (cached) {
      img.src = cached;
      return;
    }
    void reviewsApi.screenshot({ projectId: project.id, repo: view.repo, number: view.number, name }).then((res) => {
      if (res?.success && res.dataUrl) {
        shotCache.set(key, res.dataUrl);
        img.src = res.dataUrl;
      }
    });
  });
}

/** A reason in one short sentence; long tool errors fold into "Details". */
function renderReason(reason: string, settingsLink: boolean): HTMLElement {
  const cut = reason.indexOf(' (');
  const short = cut > 0 && reason.length > 120 ? `${reason.slice(0, cut)}.` : reason;
  return h('div', { class: 'prr-round-error' }, [
    h('p', {}, [short, ...(settingsLink ? [' ', h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'manage-projects' }, ['Open Settings'])] : [])]),
    ...(short !== reason ? [h('details', {}, [h('summary', { class: 'prr-link-btn' }, ['Details']), h('pre', { class: 'prr-pre' }, [reason])])] : []),
  ]);
}

function renderDeviceRun(report: DeviceReport, findings: ReviewFinding[]): HTMLElement {
  const titleOf = (id: string) => findings.find((f) => f.id === id)?.title ?? id;
  const statusText: Record<DeviceReport['status'], string> = {
    done: 'Device check finished',
    blocked: 'Device check could not start',
    failed: 'Device check failed',
    timeout: 'Device time ran out',
    cancelled: 'Device check cancelled',
  };
  const tone = report.status === 'done' ? 'success' : report.status === 'blocked' ? 'warn' : 'danger';
  const rounds = report.rounds.map((r) =>
    h('div', { class: 'prr-round' }, [
      h('div', { class: 'prr-round-head' }, [
        h('strong', {}, [`Round ${r.index}`]),
        h('span', { class: 'prr-muted' }, [r.goal]),
      ]),
      h('div', { class: 'prr-review-chips' }, [
        h('span', { class: `prr-pill prr-pill-${r.build === 'ok' ? 'success' : r.build === 'failed' ? 'danger' : 'muted'}` }, [`Build ${r.build}`]),
        h('span', { class: `prr-pill prr-pill-${r.sideload === 'ok' ? 'success' : r.sideload === 'failed' ? 'danger' : 'muted'}` }, [`Sideload ${r.sideload}`]),
        ...(r.tests
          ? [
              h('span', { class: 'prr-pill prr-pill-muted' }, [`${r.tests.length} PR test file(s)`]),
              h('span', { class: `prr-pill prr-pill-${r.result === 'PASS' ? 'success' : r.result === 'FAIL' ? 'danger' : 'muted'}` }, [r.result ? `Tests ${r.result}` : 'No test result']),
            ]
          : [h('span', { class: 'prr-pill prr-pill-muted' }, [`${r.prints ?? 0} probe print(s) · ${r.steps ?? 0} step(s)`])]),
      ]),
      ...(r.tests?.length ? [h('details', { class: 'prr-steps' }, [h('summary', {}, ['Tests run on the device']), h('ul', {}, r.tests.map((t) => h('li', {}, [t])))])] : []),
      ...(r.error ? [h('p', { class: 'prr-round-error' }, [r.error])] : []),
      ...(r.stepList?.length ? [h('details', { class: 'prr-steps' }, [h('summary', {}, ['Steps run on the device']), h('ol', {}, r.stepList.map((s) => h('li', {}, [s])))])] : []),
      ...r.outcomes.map((o) =>
        h('div', { class: `prr-outcome prr-outcome-${o.outcome}` }, [
          h('span', { class: `prr-pill prr-pill-${o.outcome === 'confirmed' ? 'danger' : o.outcome === 'refuted' ? 'success' : 'warn'}` }, [o.outcome]),
          h('span', {}, [titleOf(o.id)]),
          ...(o.evidence ? [h('pre', { class: 'prr-pre' }, [o.evidence])] : []),
        ])
      ),
      ...(r.screenshots?.length ? [h('div', { class: 'prr-shots' }, r.screenshots.map((name) => h('figure', { class: 'prr-shot' }, [h('img', { 'data-shot': name, alt: name }), h('figcaption', {}, [name])])))] : []),
      ...(r.console ? [h('details', {}, [h('summary', { class: 'prr-link-btn' }, ['Console excerpt']), h('pre', { class: 'prr-pre prr-pre-tall' }, [r.console])])] : []),
      ...(r.buildLog ? [h('details', { open: '' }, [h('summary', { class: 'prr-link-btn' }, ['Build output']), h('pre', { class: 'prr-pre prr-pre-tall' }, [r.buildLog])])] : []),
    ])
  );
  return h('section', { class: 'prr-section', id: 'prr-sec-device' }, [
    h('h3', { class: 'prr-section-title' }, ['Device check (PR tests)']),
    h('div', { class: 'prr-review-chips' }, [
      h('span', { class: `prr-pill prr-pill-${tone}` }, [statusText[report.status]]),
      ...(report.device ? [h('span', { class: 'prr-muted' }, [`${report.device.name} · ${report.device.ip}`])] : []),
      ...(report.startedAt && report.finishedAt ? [h('span', { class: 'prr-muted' }, [`${Math.round((report.finishedAt - report.startedAt) / 1000)}s`])] : []),
    ]),
    ...(report.reason ? [renderReason(report.reason, report.status === 'blocked')] : []),
    ...rounds,
    ...(report.summary ? [h('div', { class: 'prr-device-summary' }, [h('strong', {}, ['Summary']), h('p', {}, [report.summary])])] : []),
  ]);
}

/**
 * The review as Markdown, to paste into another tool. "prompt" is written for an AI agent (Claude
 * Code, Cursor…) to verify and fix; "report" is for a person or a ticket. Findings only: no console
 * output, env or secrets.
 */
function reviewMarkdown(kind: 'prompt' | 'report', data: StoredReview): string {
  const r = data.result;
  const loc = (f: ReviewFinding) => (f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '(no file)');
  const block = (f: ReviewFinding) =>
    [
      `### ${f.title}`,
      `- **Severity:** ${f.severity} · **Where:** ${loc(f)}${f.ci ? ` · **From CI:** ${f.ci.check}${f.ci.url ? ` (${f.ci.url})` : ''}` : ''}`,
      f.detail ? `- **Problem:** ${f.detail}` : '',
      kind === 'prompt' && f.reasoning ? `- **Why it was kept:** ${f.reasoning}` : '',
      f.deviceCheck ? `- **How to verify on a device:** ${f.deviceCheck}` : '',
      f.status === 'needs-device' ? `- **PR tests that exercise it:** ${f.tests?.length ? f.tests.join(', ') : 'none in this PR'}` : '',
      f.deviceEvidence ? `- **Device evidence:**\n\n\`\`\`\n${f.deviceEvidence}\n\`\`\`` : '',
      f.comment ? `- **Suggested review comment:** ${f.comment.replace(/\n+/g, ' ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  const group = (status: FindingStatus, title: string) => {
    const items = r.findings.filter((f) => f.status === status);
    return items.length ? `## ${title} (${items.length})\n\n${items.map(block).join('\n\n')}` : '';
  };
  const ciLine = r.ci
    ? r.ci.error
      ? `CI: could not be read (${r.ci.error}).`
      : `CI on ${r.headSha.slice(0, 7)}: ${r.ci.checks.map((c) => `${c.name} ${c.state}${c.annotations ? ` (${c.annotations} annotations)` : ''}`).join(', ') || 'no checks'}${r.ci.infra.length ? `. Failed without code annotations (likely infrastructure, not evidence): ${r.ci.infra.join(', ')}` : ''}.`
    : '';
  const t = r.context.ticket;
  const ticketLine = t ? `- **Ticket:** ${t.key} (${t.url})${t.status ? `, ${t.status}` : ''}: ${t.summary}` : `- **Ticket:** none found${r.context.ticketNote ? ` (${r.context.ticketNote})` : ''}`;
  const head = `# PR #${data.number}: ${data.title}\n\n- **Repo:** ${data.repo}\n- **PR:** ${data.url}\n- **Reviewed commit:** ${r.headSha}\n${ticketLine}${ciLine ? `\n- ${ciLine}` : ''}\n\n${r.summary}`;
  const findings = [group('issue', 'Issues to fix'), group('needs-device', 'Needs a device check'), group('noted', 'Also noted')].filter(Boolean).join('\n\n');
  if (kind === 'report') {
    return [head, findings || '_No findings to act on._', r.reviewBody ? `## Overall review comment\n\n${r.reviewBody}` : ''].filter(Boolean).join('\n\n') + '\n';
  }
  return [
    head,
    `## Your task\n\nCheck out the PR at the reviewed commit (\`gh pr checkout ${data.number}\` in ${data.repo}, then \`git checkout ${r.headSha}\`).\n\n1. Verify each finding below in the code before changing anything. Drop any that the code disproves, and say why.\n2. For each "Needs a device check" finding, run its check on a Roku (with Roku tools such as a Roku MCP server if you have them, or the PR tests listed). Report confirmed or refuted with the evidence.\n3. Fix only what you confirmed, with the smallest change. Follow the repo's own rules (AGENTS.md, CONTRIBUTING.md, lint config). Findings marked From CI are facts from the check run.\n4. Run the repo's build and tests. Do not commit or push unless asked.\n5. Finish with a short list: each finding, verified or not, fixed or not, and how.`,
    findings || '_No findings to act on._',
  ].join('\n\n') + '\n';
}

function copyText(text: string, button: HTMLElement, label: string): void {
  void (window as unknown as { roku?: { copyToClipboard?: (t: string) => Promise<unknown> } }).roku?.copyToClipboard?.(text);
  button.textContent = 'Copied';
  window.setTimeout(() => (button.textContent = label), 1500);
}

function saveMarkdown(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = h('a', { href: url, download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Suggestion for the top comment, from what the review found. */
function recommendation(result: StoredReview['result']): { label: string; tone: string } {
  const issues = result.findings.filter((f) => f.status === 'issue');
  if (issues.some((f) => f.ci || f.severity === 'major' || f.severity === 'critical')) return { label: 'Wait for approval', tone: 'danger' };
  // A question in the overall comment means the author has something to answer first.
  if (issues.length || result.counts['needs-device'] > 0 || /\?/.test(result.reviewBody ?? '')) return { label: 'Approve with questions', tone: 'warn' };
  return { label: 'Approve', tone: 'success' };
}

/** Comments that can be posted: verified issues and needs-device findings that have comment text. */
function postableFindings(result: StoredReview['result']): ReviewFinding[] {
  return result.findings.filter((f) => (f.status === 'issue' || f.status === 'needs-device') && !!f.comment);
}

function generalText(result: StoredReview['result']): string {
  if (posting?.state.edits[GENERAL_ID]) return posting.state.edits[GENERAL_ID];
  return result.reviewBody?.trim() || result.summary;
}

function commentText(f: ReviewFinding): string {
  return posting?.state.edits[f.id] ?? f.comment ?? '';
}

/** One comment: tick to post, edit before posting, locked once posted. */
function renderPostableComment(id: string, title: string, text: string, opts: { original?: string; note?: string; tickable: boolean; ticked: boolean }): HTMLElement {
  const ps = posting;
  const posted = ps?.state.posted[id];
  const run = ps?.run;
  const status = posted ? 'posted' : run?.current === id ? 'posting' : run?.state === 'running' && run.queue.includes(id) ? 'queued' : run?.errors[id] ? 'failed' : '';
  const editing = ps?.editing === id && !posted;
  const edited = !!ps?.state.edits[id];
  const checkbox = h('input', { type: 'checkbox', class: 'prr-post-check', 'data-action': id === GENERAL_ID ? 'toggle-general' : 'toggle-post', 'data-id': id, 'aria-label': `Post: ${title}` }) as HTMLInputElement;
  checkbox.checked = opts.ticked;
  checkbox.disabled = run?.state === 'running';
  const body = editing
    ? h('div', { class: 'prr-comment-edit' }, [
        (() => {
          const ta = h('textarea', { class: 'prr-textarea', rows: '5', 'data-role': `comment-draft`, 'aria-label': `Edit ${title}` }) as HTMLTextAreaElement;
          ta.value = ps!.draft;
          return ta;
        })(),
        h('div', { class: 'prr-comment-edit-actions' }, [
          ...(edited && opts.original !== undefined ? [h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'restore-comment', 'data-id': id }, ['Restore original'])] : []),
          h('button', { type: 'button', class: 'prr-btn', 'data-action': 'cancel-edit-comment' }, ['Cancel']),
          h('button', { type: 'button', class: 'prr-btn prr-btn-primary', 'data-action': 'save-edit-comment', 'data-id': id }, ['Save']),
        ]),
      ])
    : h('p', { class: 'prr-comment-body' }, [text]);
  return h('div', { class: `prr-comment prr-postable${opts.ticked && !posted ? ' prr-postable-on' : ''}${posted ? ' prr-postable-done' : ''}`, 'data-comment-id': id }, [
    h('div', { class: 'prr-comment-head' }, [
      h('label', { class: 'prr-post-label' }, [
        ...(posted || !opts.tickable || isOwnPr() ? [] : [checkbox]),
        h('span', { class: 'prr-comment-title' }, [title]),
        ...(edited && !posted ? [h('span', { class: 'prr-pill prr-pill-info prr-tag' }, ['Edited'])] : []),
      ]),
      h('div', { class: 'prr-comment-tools' }, [
        ...(status === 'posted' ? [posted?.url ? h('button', { type: 'button', class: 'prr-pill prr-pill-success prr-pill-jump', 'data-action': 'open-pr', 'data-url': posted.url, title: 'Open on GitHub' }, ['Posted ✓']) : h('span', { class: 'prr-pill prr-pill-success' }, ['Posted ✓'])] : []),
        ...(status === 'posting' ? [h('span', { class: 'prr-pill prr-pill-info' }, [h('span', { class: 'prr-spinner', 'aria-hidden': 'true' }), 'Posting…'])] : []),
        ...(status === 'queued' ? [h('span', { class: 'prr-pill prr-pill-muted' }, ['Queued'])] : []),
        ...(status === 'failed' ? [h('span', { class: 'prr-pill prr-pill-danger', title: run?.errors[id] ?? '' }, ['Not posted'])] : []),
        ...(!posted && !editing && run?.state !== 'running' ? [h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'edit-comment', 'data-id': id }, ['Edit'])] : []),
        h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'copy-comment', 'data-text': text }, ['Copy']),
      ]),
    ]),
    body,
    ...(opts.note ? [h('p', { class: 'prr-comment-note' }, [opts.note])] : []),
    ...(status === 'failed' ? [h('p', { class: 'prr-comment-note prr-comment-error' }, [run!.errors[id]])] : []),
  ]);
}

function selectedPostIds(result: StoredReview['result']): string[] {
  return postableFindings(result).filter((f) => !posting?.unchecked.has(f.id) && !posting?.state.posted[f.id]).map((f) => f.id);
}

/** Bottom bar of the review drawer: what will be posted, how, and progress. */
/** The review open in the drawer is for a PR opened by the GitHub token's owner. */
function isOwnPr(): boolean {
  const project = selected();
  if (!project || !reviewView) return false;
  const data = prData.get(project.id);
  const pr = data?.items.find((p) => p.repo === reviewView!.repo && p.number === reviewView!.number);
  return !!pr && !!data?.viewer && pr.author.toLowerCase() === data.viewer.toLowerCase();
}

function renderPostBar(result: StoredReview['result']): HTMLElement {
  const ps = posting!;
  if (isOwnPr()) {
    return h('div', { class: 'prr-postbar prr-postbar-own', role: 'status' }, [
      h('div', { class: 'prr-postbar-text' }, [
        h('strong', {}, ['This is your own PR']),
        h('span', { class: 'prr-muted' }, ['Comments are not posted on PRs opened by the GitHub token’s owner. Use Copy fix prompt to work on the findings.']),
      ]),
      h('button', { type: 'button', class: 'prr-btn prr-btn-primary', 'data-action': 'export-prompt' }, ['Copy fix prompt']),
    ]);
  }
  const run = ps.run;
  const all = postableFindings(result);
  const ids = selectedPostIds(result);
  const general = ps.general && !ps.state.posted[GENERAL_ID];
  const count = ids.length + (general ? 1 : 0);
  const postedCount = Object.keys(ps.state.posted).length;
  if (run?.state === 'running') {
    const left = run.queue.length + (run.current ? 1 : 0);
    return h('div', { class: 'prr-postbar prr-postbar-running', role: 'status' }, [
      h('div', { class: 'prr-postbar-text' }, [
        h('strong', {}, [run.current && !run.nextAt ? h('span', { class: 'prr-inline' }, [h('span', { class: 'prr-spinner', 'aria-hidden': 'true' }), ' Posting a comment…']) : `${Object.keys(run.posted).length} posted · waiting for the next comment`]),
        h('span', { class: 'prr-muted' }, [`${left} left`, ...(run.nextAt ? [' · next in ', h('span', { 'data-countdown': String(run.nextAt) }, [countdown(run.nextAt)])] : [])]),
      ]),
      h('span', { class: 'prr-muted prr-postbar-hint' }, ['Keep the app open: closing it drops the rest.']),
    ]);
  }
  const spaced = h('input', { type: 'checkbox', id: 'prrPostSpaced', 'data-role': 'post-spaced' }) as HTMLInputElement;
  spaced.checked = ps.spaced;
  const max = h('input', { type: 'number', class: 'prr-input prr-post-max', min: '1', max: '60', step: '1', 'data-role': 'post-max', 'aria-label': 'Maximum minutes between comments' }) as HTMLInputElement;
  max.value = String(ps.maxMinutes);
  max.disabled = !ps.spaced;
  const post = h('button', { type: 'button', class: 'prr-btn prr-btn-primary', 'data-action': 'post-comments' }, [count ? `Post ${count} comment${count === 1 ? '' : 's'}` : 'Post comments']);
  post.toggleAttribute('disabled', !count);
  const left = all.filter((f) => !ps.state.posted[f.id]);
  return h('div', { class: 'prr-postbar' }, [
    h('div', { class: 'prr-postbar-text' }, [
      h('strong', {}, [`${ids.length} of ${left.length} comment${left.length === 1 ? '' : 's'} selected`]),
      h('span', { class: 'prr-muted' }, [
        general ? 'General comment on top' : 'General comment off',
        ...(postedCount ? [` · ${postedCount} already posted`] : []),
        ...(run?.state === 'failed' ? [' · some were not posted, see the comments'] : run?.state === 'done' ? [' · last run finished'] : []),
      ]),
      ...(left.length > 1 ? [h('span', { class: 'prr-postbar-select' }, [
        h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'select-all-posts' }, ['All']),
        h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'select-no-posts' }, ['None']),
      ])] : []),
    ]),
    h('div', { class: 'prr-postbar-controls' }, [
      h('label', { class: 'prr-post-spaced', for: 'prrPostSpaced' }, [spaced, h('span', {}, ['One by one, random gap up to'])]),
      max,
      h('span', { class: 'prr-muted' }, ['min']),
      post,
    ]),
    ...(ps.error ? [h('p', { class: 'prr-comment-error', role: 'alert' }, [ps.error])] : []),
  ]);
}

function countdown(at: number): string {
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderGeneralComment(result: StoredReview['result']): HTMLElement {
  const rec = recommendation(result);
  const text = generalText(result);
  return h('section', { class: 'prr-section prr-general' }, [
    h('div', { class: 'prr-general-head' }, [
      h('h3', { class: 'prr-section-title' }, ['General comment']),
      h('span', { class: `prr-pill prr-pill-${rec.tone}`, title: 'For you, from the findings. Not posted.' }, [`Suggested action: ${rec.label}`]),
    ]),
    renderPostableComment(GENERAL_ID, 'Post as the top comment', text, {
      original: result.reviewBody?.trim() || result.summary,
      tickable: true,
      ticked: !!posting?.general,
      note: 'Posted first, as a plain PR comment. The suggested action is for you and is not posted; nothing approves or requests changes.',
    }),
  ]);
}

function renderReviewDrawer(project: ProjectItem, view: NonNullable<typeof reviewView>): HTMLElement {
  const close = h('button', { type: 'button', class: 'prr-icon-btn prr-close', 'data-action': 'close-drawer', 'aria-label': 'Close', title: 'Close (Esc)' }, ['×']);
  const shell = (title: string, subtitle: string, body: HTMLElement[], extra: HTMLElement[] = []) =>
    h('aside', { class: 'prr-drawer prr-drawer-wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      h('header', { class: 'prr-drawer-head' }, [h('div', {}, [h('h2', { class: 'prr-drawer-title' }, [title]), h('p', { class: 'prr-subtitle' }, [subtitle])]), h('div', { class: 'prr-header-actions' }, [...extra, close])]),
      h('div', { class: 'prr-drawer-body' }, body),
    ]);
  if (view.loading) return shell(`#${view.number}`, view.repo, [renderSkeleton(4)]);
  if (!view.data) return shell(`#${view.number}`, view.repo, [h('div', { class: 'prr-alert', role: 'alert' }, [view.error ?? 'No review found.'])]);

  const { result } = view.data;
  const prNow = prData.get(project.id)?.items.find((p) => p.repo === view.repo && p.number === view.number);
  const outdated = !!prNow && prNow.headSha !== result.headSha;
  const groups: { status: FindingStatus; title: string; hint: string }[] = [
    { status: 'issue', title: 'Issues to fix', hint: 'Verified in the code by the judge.' },
    { status: 'needs-device', title: 'Needs a device check', hint: 'Plausible, but only a device run can settle it. Not counted and never posted as fact until verified.' },
    { status: 'noted', title: 'Also noted', hint: 'Real but minor, or below the confidence floor.' },
    { status: 'dismissed', title: 'Dismissed', hint: 'Ruled out by the judge, or dismissed by you. Never posted or counted.' },
  ];
  const sections = groups.map((g) => {
    const items = result.findings.filter((f) => f.status === g.status);
    if (!items.length) return null;
    const body = [h('p', { class: 'prr-section-hint' }, [g.hint]), ...items.map((f) => renderFinding(view.repo, result.headSha, f))];
    if (g.status === 'dismissed') {
      const details = h('details', { class: 'prr-section', id: `prr-sec-${g.status}` }, [h('summary', { class: 'prr-section-title' }, [`${g.title} (${items.length})`]), ...body]);
      return details;
    }
    return h('section', { class: 'prr-section', id: `prr-sec-${g.status}` }, [h('h3', { class: 'prr-section-title' }, [`${g.title} (${items.length})`]), ...body]);
  });

  const needsDevice = result.counts['needs-device'] > 0;
  const deviceNote =
    !result.device && (needsDevice || result.deviceRecommended)
      ? h('div', { class: 'prr-warn', role: 'status' }, [
          h('strong', {}, [needsDevice ? `${result.counts['needs-device']} finding(s) need a device check. ` : 'The judge recommends a device run. ']),
          result.deviceReason ? `${result.deviceReason} ` : '',
          'Test it on a device before merging: use Copy fix prompt to hand the checks to a tool that can drive a Roku. A device check runs automatically only when a test in this PR covers the finding.',
        ])
      : result.device && needsDevice
        ? h('div', { class: 'prr-warn', role: 'status' }, [h('strong', {}, [`${result.counts['needs-device']} finding(s) still need a device check. `]), 'The PR tests did not settle them; they are not counted or posted as fact. Test them on a device (Copy fix prompt).'])
        : null;
  const deviceSection = result.device ? renderDeviceRun(result.device, result.findings) : null;

  const ctx = result.context;
  const checked = h('section', { class: 'prr-section prr-checked' }, [
    h('h3', { class: 'prr-section-title' }, ['What this review was checked against']),
    h('ul', { class: 'prr-checked-list' }, [
      h('li', {}, [
        ctx.ticket
          ? h('span', {}, ['Ticket ', h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'open-pr', 'data-url': ctx.ticket.url }, [ctx.ticket.key]), ` (${[ctx.ticket.type, ctx.ticket.status].filter(Boolean).join(', ')}, found in the ${ctx.ticket.foundIn}): ${ctx.ticket.summary}`])
          : `No ticket: correctness-only review${ctx.ticketNote ? ` (${ctx.ticketNote})` : ''}`,
      ]),
      ...(ctx.ticket?.figmaLinks.length ? [h('li', { class: 'prr-muted' }, [`Linked designs (not reviewed yet): ${ctx.ticket.figmaLinks.length}`])] : []),
      h('li', {}, [`${ctx.files} changed file(s)`]),
      h('li', {}, [ctx.standards.length ? `Repo standards: ${ctx.standards.join(', ')}` : 'No repo standards files found']),
      h('li', {}, [ctx.wikiPages.length ? `Wiki: ${ctx.wikiPages.join(', ')}` : 'No wiki pages matched']),
      h('li', {}, [ctx.instructions ? 'Team instructions from the project settings' : 'No team instructions']),
      ...ctx.diffNotes.map((n) => h('li', { class: 'prr-muted' }, [n])),
    ]),
    h('table', { class: 'prr-agents' }, [
      h('thead', {}, [h('tr', {}, ['Role', 'Model', 'Result', 'Time', 'Tokens', 'Price'].map((c) => h('th', {}, [c])))]),
      h(
        'tbody',
        {},
        result.agents.map((a) =>
          h('tr', {}, [
            h('td', {}, [a.role]),
            h('td', {}, [a.model || '—']),
            h('td', { title: a.error ?? '' }, [a.status === 'finished' ? (a.findings !== undefined ? `${a.findings} finding(s)${a.kept !== undefined ? `, ${a.kept} kept` : ''}${a.retried ? ' (after a retry)' : ''}` : 'done') : a.status === 'skipped' ? 'not set' : `failed${a.error ? `: ${a.error.slice(0, 80)}` : ''}`]),
            h('td', {}, [a.durationMs ? `${Math.round(a.durationMs / 1000)}s` : '—']),
            h('td', { title: a.toolCalls !== undefined ? `${a.toolCalls} tool calls` : '' }, [a.usage ? formatTokens(a.usage.total) : '—']),
            h('td', {}, [a.usage ? formatPrice(a.usage) : '—']),
          ])
        ).concat(
          result.device?.usage
            ? [h('tr', {}, [h('td', {}, ['device run']), h('td', {}, ['judge']), h('td', {}, [`${result.device.rounds.length} round(s)`]), h('td', {}, ['—']), h('td', {}, [formatTokens(result.device.usage.total)]), h('td', {}, [formatPrice(result.device.usage)])])]
            : []
        )
      ),
    ]),
  ]);

  const counts = result.counts;
  const lost = result.lostLenses?.length
    ? h('div', { class: 'prr-warn', role: 'status' }, [
        h('strong', {}, ['Incomplete review. ']),
        `Lost: ${result.agents.filter((a) => result.lostLenses!.includes(a.role)).map((a) => `${a.role} (${(a.error ?? 'failed').slice(0, 120)})`).join('; ')}. Findings from these lenses are missing, so "no issues" here does not mean the PR is clean. Re-review once the cause is fixed.`,
      ])
    : null;
  const ticketChip = ctx.ticket
    ? h('button', { type: 'button', class: 'prr-pill prr-pill-info prr-pill-jump', 'data-action': 'open-pr', 'data-url': ctx.ticket.url, title: `${ctx.ticket.summary} (checked against this ticket)` }, [`${ctx.ticket.key}${ctx.ticket.status ? ` · ${ctx.ticket.status}` : ''}`])
    : h('span', { class: 'prr-pill prr-pill-muted', title: ctx.ticketNote ?? '' }, ['No ticket · correctness only']);
  const summaryCard = h('section', { class: 'prr-review-summary' }, [
    h('div', { class: 'prr-ticket-row' }, [ticketChip]),
    h('p', {}, [result.summary]),
    h(
      'div',
      { class: 'prr-review-chips' },
      ([
        ['issue', 'danger', `${counts.issue} to fix`],
        ['needs-device', 'warn', `${counts['needs-device']} need device`],
        ['noted', 'muted', `${counts.noted} noted`],
        ['dismissed', 'muted', `${counts.dismissed} dismissed`],
      ] as [FindingStatus, string, string][]).map(([status, tone, text]) =>
        counts[status]
          ? h('button', { type: 'button', class: `prr-pill prr-pill-${tone} prr-pill-jump`, 'data-action': 'jump-section', 'data-target': `prr-sec-${status}`, title: 'Jump to these findings' }, [text])
          : h('span', { class: `prr-pill prr-pill-${tone} prr-pill-zero` }, [text])
      )
    ),
    h('p', { class: 'prr-muted prr-review-meta' }, [
      `Reviewed ${timeAgo(new Date(result.finishedAt).toISOString())} at ${result.headSha.slice(0, 7)} · took ${Math.round((result.finishedAt - result.startedAt) / 1000)}s`,
      ...(result.incremental ? [` · only the new commits since ${result.incremental.sinceSha.slice(0, 7)} (${result.incremental.rechecked} earlier finding(s) re-checked, ${result.incremental.carried} carried over)`] : []),
      ...(result.usage ? [h('span', { title: `Input ${formatTokens(result.usage.input)} · output ${formatTokens(result.usage.output)} · cache read ${formatTokens(result.usage.cacheRead)} · cache write ${formatTokens(result.usage.cacheWrite)}. Price is Cursor's list price for these tokens; "charged" is what your plan actually billed.` }, [` · ${usageLine(result.usage)}`])] : []),
    ]),
    ...(outdated ? [h('div', { class: 'prr-note' }, ['New commits were pushed after this review. ', h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'start-review', 'data-repo': view.repo, 'data-number': String(view.number) }, ['Review the new commits'])])] : []),
  ]);

  const openPr = h('button', { type: 'button', class: 'prr-btn prr-btn-ghost', 'data-action': 'open-pr', 'data-url': view.data.url }, [icon('icon-external-link'), 'Open PR']);
  const exportMenu = h('div', { class: 'prr-export' }, [
    h('button', { type: 'button', class: 'prr-btn prr-btn-primary', 'data-action': 'export-prompt', title: 'Markdown for Claude Code, Cursor or another agent: verify and fix the findings' }, ['Copy fix prompt']),
    h('button', { type: 'button', class: 'prr-btn', 'data-action': 'export-report', title: 'Markdown report for a person or a ticket' }, ['Copy report']),
    h('button', { type: 'button', class: 'prr-btn prr-btn-ghost', 'data-action': 'export-save', title: 'Save the report as a .md file' }, ['Save .md']),
  ]);
  const ciCard = result.ci
    ? h('section', { class: 'prr-section prr-ci', id: 'prr-sec-ci' }, [
        h('h3', { class: 'prr-section-title' }, ['CI checks']),
        result.ci.error
          ? h('p', { class: 'prr-muted' }, [`Could not read CI: ${result.ci.error}`])
          : result.ci.checks.length
            ? h(
                'ul',
                { class: 'prr-ci-list' },
                result.ci.checks.map((c) => {
                  const infra = result.ci!.infra.includes(c.name);
                  const tone = c.state === 'success' ? 'success' : c.state === 'failure' ? (infra ? 'warn' : 'danger') : c.state === 'pending' ? 'info' : 'muted';
                  const label = c.state === 'failure' ? (infra ? 'Failed (infrastructure)' : `Failed · ${c.annotations} annotation(s)`) : c.state === 'success' ? 'Passed' : c.state === 'pending' ? 'Running' : c.state;
                  return h('li', { class: 'prr-ci-item' }, [
                    h('span', { class: `prr-pill prr-pill-${tone}` }, [label]),
                    c.url ? h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'open-pr', 'data-url': c.url }, [c.name]) : h('span', {}, [c.name]),
                  ]);
                })
              )
            : h('p', { class: 'prr-muted' }, ['No CI checks on this commit.']),
        ...(result.ci.infra.length ? [h('p', { class: 'prr-section-hint' }, ['Failed without code annotations, so likely infrastructure (device not reached, timeout). Not counted and not treated as evidence about the code.'])] : []),
      ])
    : null;
  const empty = result.findings.length ? [] : [h('div', { class: 'prr-card' }, [emptyState(['No findings.', 'All three reviewers and the judge found nothing worth acting on.'])])];
  // Overall comment last: issues first, then how the device run settled things, then what would be posted.
  const commentSection = !result.findings.some((f) => f.comment) && result.findings.some((f) => f.status !== 'dismissed')
      ? h('p', { class: 'prr-muted' }, ['This review predates comment previews. Re-review to get them.'])
      : null;
  return shell(`#${view.number} ${view.data.title}`, view.repo, [
    ...(lost ? [lost] : []),
    summaryCard,
    ...(posting ? [renderGeneralComment(result)] : []),
    ...(ciCard ? [ciCard] : []),
    ...(deviceNote ? [deviceNote] : []),
    ...empty,
    ...sections.filter((x): x is HTMLElement => x !== null),
    ...(deviceSection ? [deviceSection] : []),
    ...(commentSection ? [commentSection] : []),
    checked,
    ...(posting ? [renderPostBar(result)] : []),
  ], [exportMenu, openPr]);
}

/** What a container shows: markup plus form values (set as properties, so not in the markup). */
function viewSignature(el: HTMLElement): string {
  const values = Array.from(el.querySelectorAll<HTMLInputElement>('input, textarea, select')).map((i) => (i.type === 'checkbox' || i.type === 'radio' ? String(i.checked) : i.value));
  return el.innerHTML + JSON.stringify(values);
}

/** Replace a container's content only when it would look different: live updates that change nothing do not blink. */
function swap(container: HTMLElement, nodes: Node[]): boolean {
  const next = document.createElement('div');
  next.append(...nodes);
  const sig = viewSignature(next);
  if (container.dataset.view === sig) return false;
  container.dataset.view = sig;
  container.replaceChildren(...Array.from(next.childNodes));
  return true;
}

function renderDrawer(project: ProjectItem | undefined): void {
  const layer = document.getElementById('prReviewsDrawer');
  if (!layer) return;
  // Re-rendering the same drawer (live updates) keeps its scroll position and the focused control.
  const body = layer.querySelector<HTMLElement>('.prr-drawer-body');
  const label = layer.querySelector('[role=dialog]')?.getAttribute('aria-label') ?? '';
  const scrollTop = body?.scrollTop ?? 0;
  const active = document.activeElement as HTMLElement | null;
  const focused = active && layer.contains(active) ? { action: active.getAttribute('data-action'), id: active.getAttribute('data-id'), role: active.getAttribute('data-role') } : null;
  const restore = () => {
    if (layer.querySelector('[role=dialog]')?.getAttribute('aria-label') !== label) return;
    const next = layer.querySelector<HTMLElement>('.prr-drawer-body');
    if (next) next.scrollTop = scrollTop;
    if (focused?.role) layer.querySelector<HTMLElement>(`[data-role="${focused.role}"]`)?.focus({ preventScroll: true });
    else if (focused?.action) layer.querySelector<HTMLElement>(`[data-action="${focused.action}"]${focused.id ? `[data-id="${focused.id}"]` : ''}`)?.focus({ preventScroll: true });
  };
  if (project && reviewView) {
    layer.hidden = false;
    if (swap(layer, [h('div', { class: 'prr-backdrop', 'data-action': 'close-drawer' }), renderReviewDrawer(project, reviewView)])) {
      hydrateScreenshots(project);
      restore();
    }
    return;
  }
  if (devicesOpen) {
    layer.hidden = false;
    if (swap(layer, [h('div', { class: 'prr-backdrop', 'data-action': 'close-drawer' }), renderDevicesDrawer()])) restore();
    return;
  }
  const open = drawerOpen && !!project && !isPicking(project);
  layer.hidden = !open;
  if (!open || !project) {
    swap(layer, []);
    return;
  }
  swap(layer, [
    h('div', { class: 'prr-backdrop', 'data-action': 'close-drawer' }),
    h('aside', { class: 'prr-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Repos for ${project.name}` }, [
      h('header', { class: 'prr-drawer-head' }, [
        h('div', {}, [h('h2', { class: 'prr-drawer-title' }, ['Repos to review']), h('p', { class: 'prr-subtitle' }, [project.name])]),
        h('button', { type: 'button', class: 'prr-icon-btn prr-close', 'data-action': 'close-drawer', 'aria-label': 'Close', title: 'Close (Esc)' }, ['×']),
      ]),
      h('div', { class: 'prr-drawer-body' }, renderPicker(project, 'stack')),
    ]),
  ]);
}

// ---------------------------------------------------------------------------------------------
// PR list
// ---------------------------------------------------------------------------------------------

/** The AI review chip and buttons for one PR row. */
function renderReviewControls(project: ProjectItem, pr: PullRequestItem): { chip: HTMLElement | null; buttons: HTMLElement[] } {
  const summary = reviewFor(project, pr);
  const blocker = reviewBlocker(project);
  const ids = { 'data-repo': pr.repo, 'data-number': String(pr.number) };
  const btn = (action: string, label: string, primary = false) => h('button', { type: 'button', class: `prr-btn${primary ? ' prr-btn-primary' : ''}`, 'data-action': action, ...ids }, [label]);
  const chip = (tone: string, text: string, title = '') => h('span', { class: `prr-pill prr-pill-${tone} prr-review-chip`, ...(title ? { title } : {}) }, [h('span', { class: 'prr-pill-dot', 'aria-hidden': 'true' }), text]);

  if (!summary || summary.status === 'cancelled') {
    const review = btn('start-review', 'Review', true);
    if (blocker) {
      review.setAttribute('disabled', '');
      review.setAttribute('title', blocker);
    }
    return { chip: summary?.status === 'cancelled' ? chip('muted', 'Review cancelled') : null, buttons: [review] };
  }
  if (summary.status === 'queued') return { chip: chip('info', 'Queued for review'), buttons: [btn('cancel-review', 'Cancel')] };
  if (summary.status === 'running') {
    const phase =
      summary.phase === 'waiting-device' ? 'Waiting for device' : summary.phase === 'device' ? 'Testing on device' : summary.phase === 'judging' ? 'Judging' : summary.phase === 'reviewing' ? 'Reviewing' : 'Preparing';
    return { chip: h('span', { class: 'prr-pill prr-pill-info prr-review-chip', title: summary.detail ?? '' }, [h('span', { class: 'prr-spinner', 'aria-hidden': 'true' }), `${phase}…`]), buttons: [btn('cancel-review', 'Cancel')] };
  }
  if (summary.status === 'failed') {
    const retry = btn('start-review', 'Retry');
    if (blocker) retry.setAttribute('disabled', '');
    return { chip: chip('danger', 'Review failed', summary.error ?? ''), buttons: [retry] };
  }
  const counts = summary.counts ?? { issue: 0, 'needs-device': 0, noted: 0, dismissed: 0 };
  const outdated = !!summary.headSha && !!pr.headSha && summary.headSha !== pr.headSha;
  const label =
    counts.issue > 0
      ? chip('danger', `${counts.issue} issue${counts.issue === 1 ? '' : 's'} to fix`)
      : counts['needs-device'] > 0
        ? chip('warn', `${counts['needs-device']} need${counts['needs-device'] === 1 ? 's' : ''} a device check${summary.deviceSkipped === 'no device' ? ' · no device' : ''}`, summary.deviceSkipped === 'no device' ? 'The device check was skipped: no test device was reachable.' : '')
        : summary.lostLenses?.length
          ? chip('warn', 'Incomplete review', `Lost: ${summary.lostLenses.join(', ')}. Re-review to cover them.`)
          : chip('success', 'Looks good');
  const rereview = btn('start-review', outdated ? 'Review new commits' : 'Re-review', outdated);
  if (blocker) rereview.setAttribute('disabled', '');
  const incomplete = summary.lostLenses?.length && (counts.issue > 0 || counts['needs-device'] > 0) ? [chip('warn', 'Incomplete', `Lost: ${summary.lostLenses.join(', ')}. Re-review to cover them.`)] : [];
  const wrap = h('span', { class: 'prr-review-chips' }, [label, ...incomplete, ...(outdated ? [chip('muted', 'Outdated', 'New commits since this review')] : [])]);
  if (summary.finishedAt) label.setAttribute('title', `Reviewed ${timeAgo(new Date(summary.finishedAt).toISOString())}${label.getAttribute('title') ? `. ${label.getAttribute('title')}` : ''}`);
  return { chip: wrap, buttons: [btn('view-review', 'View review'), rereview] };
}

function renderPrRow(pr: PullRequestItem): HTMLElement {
  const state = prState(pr);
  const project = selected();
  const controls = project ? renderReviewControls(project, pr) : { chip: null, buttons: [] };
  const open = h('button', { type: 'button', class: 'prr-icon-btn', 'data-action': 'open-pr', 'data-url': pr.url, 'aria-label': `Open #${pr.number} on GitHub`, title: 'Open on GitHub' }, [icon('icon-external-link')]);
  return h('li', { class: 'prr-pr' }, [
    h('div', { class: 'prr-pr-main' }, [
      h('div', { class: 'prr-pr-title' }, [
        h('span', { class: 'prr-pr-num' }, [`#${pr.number}`]),
        h('button', { type: 'button', class: 'prr-pr-link', 'data-action': 'open-pr', 'data-url': pr.url, title: pr.title }, [pr.title]),
      ]),
      h('div', { class: 'prr-pr-state' }, [
        h('span', { class: `prr-pill prr-pill-${state.tone}`, title: state.hint }, [h('span', { class: 'prr-pill-dot', 'aria-hidden': 'true' }), state.label]),
        ...(controls.chip ? [controls.chip] : []),
      ]),
      h('div', { class: 'prr-pr-meta' }, [
        // The repo is only worth a chip when the list mixes several.
        ...(project && chosenRepos(project).length > 1 ? [h('span', { class: 'prr-chip-code prr-chip-repo', title: pr.repo }, [pr.repo.split('/')[1] ?? pr.repo])] : []),
        h('span', { class: 'prr-chip-code', title: `${pr.head} → ${pr.base}` }, [pr.head, h('span', { class: 'prr-arrow', 'aria-hidden': 'true' }, ['→']), pr.base]),
        h('span', { class: 'prr-diff' }, [h('span', { class: 'prr-add' }, [`+${pr.additions}`]), ' ', h('span', { class: 'prr-del' }, [`−${pr.deletions}`])]),
        h('span', { class: 'prr-muted' }, [`by ${pr.author}`]),
        h('span', { class: 'prr-muted', title: new Date(pr.updatedAt).toLocaleString() }, [`updated ${timeAgo(pr.updatedAt)}`]),
      ]),
    ]),
    h('div', { class: 'prr-pr-actions' }, [...controls.buttons, open]),
  ]);
}

function renderFilterBar(project: ProjectItem, data: PrData): HTMLElement {
  const inRepo = data.items.filter((pr) => !repoFilter || pr.repo === repoFilter);
  const seg = h(
    'div',
    { class: 'prr-seg', role: 'group', 'aria-label': 'Filter pull requests' },
    PR_FILTERS.map((f) => {
      const count = inRepo.filter((pr) => matchesFilter(pr, f.id, data.viewer)).length;
      return h('button', { type: 'button', class: `prr-seg-btn${f.id === prFilter ? ' active' : ''}`, 'data-action': 'set-filter', 'data-filter': f.id, 'aria-pressed': String(f.id === prFilter) }, [
        f.label,
        h('span', { class: 'prr-seg-count' }, [String(count)]),
      ]);
    })
  );

  const repoSelect = h(
    'select',
    { class: 'prr-select prr-repo-select', 'aria-label': 'Repository', 'data-role': 'repo-filter' },
    [
      h('option', { value: '' }, ['All repositories']),
      ...chosenRepos(project).map((repo) => {
        const option = h('option', { value: repo }, [repo]);
        if (repo === repoFilter) option.setAttribute('selected', '');
        return option;
      }),
    ]
  );
  const searchInput = h('input', { type: 'search', class: 'prr-input prr-search', placeholder: 'Search pull requests…', 'aria-label': 'Search pull requests', 'data-role': 'pr-search', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  searchInput.value = search;
  return h('div', { class: 'prr-filterbar' }, [seg, h('div', { class: 'prr-filterbar-end' }, [repoSelect, searchInput])]);
}

function renderPrNotices(data: PrData): HTMLElement[] {
  const notices: HTMLElement[] = [];
  if (data.failed.length) {
    notices.push(h('div', { class: 'prr-warn', role: 'status' }, [h('strong', {}, ['Could not read: ']), data.failed.map((f) => `${f.repo} (${f.reason})`).join(', '), '.']));
  }
  if (data.truncatedRepos.length) {
    notices.push(h('div', { class: 'prr-note', role: 'status' }, [`Showing the 50 most recently updated PRs for: ${data.truncatedRepos.join(', ')}.`]));
  }
  return notices;
}

function renderPrList(project: ProjectItem): HTMLElement[] {
  const data = prData.get(project.id);
  if (!data) {
    if (prError) return [h('div', { class: 'prr-alert', role: 'alert' }, [prError])];
    return [renderSkeleton(SKELETON_ROWS, true)];
  }
  const nodes: HTMLElement[] = [renderFilterBar(project, data), ...renderPrNotices(data)];
  if (prError) nodes.push(h('div', { class: 'prr-alert', role: 'alert' }, [`Could not refresh: ${prError}`]));

  const matches = data.items.filter((pr) => (!repoFilter || pr.repo === repoFilter) && matchesFilter(pr, prFilter, data.viewer) && matchesSearch(pr, search));
  if (data.items.length === 0) {
    nodes.push(h('div', { class: 'prr-card' }, [emptyState(['No open pull requests.', 'None of the chosen repos has an open PR right now.'])]));
    return nodes;
  }
  if (matches.length === 0) {
    const showAll = prFilter !== 'all' || repoFilter || search ? h('button', { type: 'button', class: 'prr-btn', 'data-action': 'clear-filters' }, ['Show all pull requests']) : undefined;
    const message = prFilter === 'needs-you' && !search && !repoFilter ? ['Nothing needs you right now.', 'No review is requested from you and none of your PRs has a problem.'] : ['No pull requests match.', 'Try another filter or search.'];
    nodes.push(h('div', { class: 'prr-card' }, [emptyState(message, showAll)]));
    return nodes;
  }
  const shown = matches.slice(0, visibleLimit);
  nodes.push(h('ul', { class: 'prr-pr-list' }, shown.map(renderPrRow)));
  if (matches.length > shown.length) {
    nodes.push(h('button', { type: 'button', class: 'prr-btn prr-more', 'data-action': 'show-more' }, [`Show more (${matches.length - shown.length} left)`]));
  }
  return nodes;
}

// ---------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------

function renderHeader(): HTMLElement {
  return h('header', { class: 'prr-header' }, [
    h('div', { class: 'prr-header-title' }, [
      h('div', { class: 'feature-icon-wrapper indigo prr-header-icon' }, [icon('icon-git-pull-request')]),
      h('div', {}, [
        h('h2', { class: 'prr-title' }, ['PR Reviews']),
        h('p', { class: 'prr-subtitle' }, ['Open pull requests from the repos you chose, across every org your GitHub token can see.']),
      ]),
    ]),
    h('div', { class: 'prr-header-actions' }, [
      h('button', { type: 'button', class: 'prr-btn prr-btn-ghost', 'data-action': 'manage-projects' }, [icon('icon-settings'), 'Manage projects']),
      h('button', { type: 'button', class: 'prr-icon-btn prr-close', 'data-action': 'close-panel', 'aria-label': 'Close PR Reviews', title: 'Close' }, ['×']),
    ]),
  ]);
}

/** Toolbar button for the device pool: how many devices are ready, busy, or need a password. */
function renderDeviceField(): HTMLElement {
  const busyCount = devices.filter((d) => d.busyWith).length;
  const offline = devices.filter((d) => !d.busyWith && d.online === false).length;
  const ready = devices.filter((d) => !d.busyWith && d.online !== false && d.hasPassword).length;
  const needsPassword = devices.filter((d) => !d.busyWith && d.online !== false && !d.hasPassword).length;
  const tone = ready || busyCount ? (offline || needsPassword ? 'warn' : 'success') : 'warn';
  const parts = [`${ready} ready`, ...(busyCount ? [`${busyCount} busy`] : []), ...(offline ? [`${offline} offline`] : []), ...(needsPassword ? [`${needsPassword} need password`] : [])];
  const text = !devices.length ? 'None yet' : parts.join(' · ');
  const button = h('button', { type: 'button', class: 'prr-btn', 'data-action': 'open-devices', 'aria-haspopup': 'dialog', title: 'Device runs use any free device in this list, one review per device at a time.' }, [
    h('span', { class: `prr-pill-dot prr-dot-${tone}`, 'aria-hidden': 'true' }),
    text,
  ]);
  return h('div', { class: 'prr-field' }, [h('span', { class: 'prr-field-label' }, ['Test devices']), button]);
}

function renderDeviceRow(d: DeviceOption, inPool: boolean): HTMLElement {
  const status = inPool
    ? d.busyWith
      ? h('span', { class: 'prr-pill prr-pill-info' }, [`Testing ${d.busyWith}`])
      : d.online === false
        ? h('span', { class: 'prr-pill prr-pill-muted', title: d.lastSeen ? `Last seen ${timeAgo(new Date(d.lastSeen).toISOString())}` : 'Not reachable on the network' }, ['Offline'])
        : d.hasPassword
          ? h('span', { class: 'prr-pill prr-pill-success' }, ['Ready'])
          : h('span', { class: 'prr-pill prr-pill-warn' }, ['Needs password'])
    : null;
  const ids = { 'data-key': d.key };
  const actions = inPool
    ? [
        h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'device-password', ...ids }, [d.hasPassword ? 'Change password' : 'Set password']),
        h('button', { type: 'button', class: 'prr-icon-btn', 'data-action': 'remove-device', ...ids, 'aria-label': `Remove ${d.name}`, title: 'Remove from pool' }, ['×']),
      ]
    : [h('button', { type: 'button', class: 'prr-icon-btn', 'data-action': 'add-device', ...ids, 'aria-label': `Add ${d.name}`, title: 'Add to pool' }, ['+'])];
  return h('li', { class: 'prr-row prr-device-row' }, [
    h('div', { class: 'prr-device-info' }, [
      h('strong', {}, [d.name]),
      h('span', { class: 'prr-muted' }, [[d.ip, d.model, inPool && d.online === false ? (d.lastSeen ? `last seen ${timeAgo(new Date(d.lastSeen).toISOString())}` : 'not reachable') : ''].filter(Boolean).join(' · ')]),
    ]),
    h('div', { class: 'prr-device-actions' }, [...(status ? [status] : []), ...actions]),
  ]);
}

function renderDevicesDrawer(): HTMLElement {
  const inPool = new Set(devices.map((d) => d.key));
  const others = found.filter((d) => !inPool.has(d.key));
  const scan = h('button', { type: 'button', class: 'prr-btn', 'data-action': 'discover-devices' }, [icon('icon-refresh'), discovering ? 'Scanning…' : 'Scan network']);
  scan.toggleAttribute('disabled', discovering);
  const poolCard = h('section', { class: 'prr-card' }, [
    h('h3', { class: 'prr-section-title' }, [`Test devices (${devices.length})`]),
    devices.length ? h('ul', { class: 'prr-list' }, devices.map((d) => renderDeviceRow(d, true))) : emptyState(['No test devices yet.', 'Scan the network and add the Rokus reviews may deploy to.']),
  ]);
  const foundCard = h('section', { class: 'prr-card' }, [
    h('div', { class: 'prr-device-found-head' }, [h('h3', { class: 'prr-section-title' }, ['On the network']), scan]),
    ...(discoverError ? [h('p', { class: 'prr-device-pass-error', role: 'alert' }, [discoverError])] : []),
    discovering && !others.length
      ? h('p', { class: 'prr-muted' }, ['Looking for Rokus (SSDP and subnet sweep)…'])
      : others.length
        ? h('ul', { class: 'prr-list' }, others.map((d) => renderDeviceRow(d, false)))
        : h('p', { class: 'prr-muted' }, [found.length ? 'Every device found is already in the pool.' : 'Nothing found yet. Make sure the Roku is on and on this network, then scan.']),
  ]);
  return h('aside', { class: 'prr-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Test devices' }, [
    h('header', { class: 'prr-drawer-head' }, [
      h('div', {}, [
        h('h2', { class: 'prr-drawer-title' }, ['Test devices']),
        h('p', { class: 'prr-subtitle' }, ['Reviews that need a device take any free, ready device here, so each device runs one review at a time in parallel. Shared by all projects. The PR build stays installed afterwards.']),
      ]),
      h('button', { type: 'button', class: 'prr-icon-btn prr-close', 'data-action': 'close-drawer', 'aria-label': 'Close', title: 'Close (Esc)' }, ['×']),
    ]),
    h('div', { class: 'prr-drawer-body' }, [poolCard, foundCard]),
  ]);
}

function renderToolbar(project: ProjectItem): HTMLElement {
  const select = h(
    'select',
    { class: 'prr-select', 'aria-label': 'Project', 'data-role': 'project-select' },
    projects.map((p) => {
      const option = h('option', { value: p.id }, [p.name]);
      if (p.id === selectedId) option.setAttribute('selected', '');
      return option;
    })
  );
  const data = prData.get(project.id);
  const refresh = h('button', { type: 'button', class: 'prr-btn', 'data-action': 'refresh', title: 'Refresh pull requests' }, [icon('icon-refresh'), isLoadingPrs(project) ? 'Refreshing…' : 'Refresh']);
  refresh.toggleAttribute('disabled', isLoadingPrs(project) || chosenRepos(project).length === 0 || !project.tokens.github);
  const repos = h('button', { type: 'button', class: 'prr-btn', 'data-action': 'open-drawer', 'aria-haspopup': 'dialog' }, [icon('icon-list'), `Repos (${chosenRepos(project).length})`]);
  repos.toggleAttribute('disabled', !project.tokens.github);
  const projectField = h('label', { class: 'prr-field' }, [h('span', { class: 'prr-field-label' }, ['Project']), select]);
  // While choosing repos for the first time there is nothing to refresh or open yet.
  if (isPicking(project)) return h('div', { class: 'prr-toolbar' }, [projectField]);
  return h('div', { class: 'prr-toolbar' }, [
    h('div', { class: 'prr-toolbar-start' }, [projectField, renderDeviceField()]),
    h('div', { class: 'prr-toolbar-end' }, [data ? h('span', { class: 'prr-muted prr-updated', 'aria-live': 'polite', 'data-ago': String(data.fetchedAt) }, [`Updated ${timeAgo(new Date(data.fetchedAt).toISOString())}`]) : h('span', {}, []), refresh, repos]),
  ]);
}

function render(): void {
  const root = document.getElementById('prReviewsRoot');
  if (!root) return;
  // Keep the focused text box (and caret) across a re-render.
  const active = document.activeElement as HTMLInputElement | null;
  const focusRole = active?.getAttribute?.('data-role') ?? null;
  const caret = focusRole && 'selectionStart' in (active ?? {}) ? active?.selectionStart ?? null : null;
  // Keep the list where it was and focus on the row that was clicked (its button may change, e.g. Review → Cancel).
  const scroller = root.closest<HTMLElement>('.prr-scroll');
  const scrollTop = scroller?.scrollTop ?? 0;
  const inRoot = !!active && root.contains(active);
  const focusAction = inRoot ? active!.getAttribute('data-action') : null;
  const focusRepo = inRoot ? active!.getAttribute('data-repo') : null;
  const focusNumber = inRoot ? active!.getAttribute('data-number') : null;

  const project = selected();
  const children: Node[] = [renderHeader()];

  if (!api) {
    children.push(emptyState(['PR Reviews is unavailable in this window.']));
  } else if (projects.length === 0 || !project) {
    children.push(
      h('div', { class: 'prr-card prr-onboarding' }, [
        emptyState(
          ['No projects yet.', 'Add a project and its GitHub token in Settings → Projects, then come back to choose repos.'],
          h('button', { type: 'button', class: 'prr-btn prr-btn-primary', 'data-action': 'manage-projects' }, ['Add a project'])
        ),
      ])
    );
  } else {
    children.push(renderToolbar(project));
    if (!isPicking(project)) {
      const blocker = reviewBlocker(project);
      if (blocker && project.tokens.github) children.push(h('div', { class: 'prr-note', role: 'status' }, [blocker, ' ', h('button', { type: 'button', class: 'prr-link-btn', 'data-action': 'manage-projects' }, ['Open Settings'])]));
    }
    if (!project.tokens.github) {
      children.push(
        h('div', { class: 'prr-card' }, [
          emptyState(['This project has no GitHub token yet.', 'The token decides which repos and PRs you can see. Add it in Settings → Projects.'], h('button', { type: 'button', class: 'prr-btn prr-btn-primary', 'data-action': 'manage-projects' }, ['Open Projects'])),
        ])
      );
    } else if (isPicking(project)) {
      children.push(h('p', { class: 'prr-step' }, ['Choose the repos whose pull requests you want to see. You can change them later from Repos.']));
      children.push(...renderPicker(project, 'grid'));
      const count = chosenRepos(project).length;
      const done = h('button', { type: 'button', class: 'prr-btn prr-btn-primary', 'data-action': 'finish-picking' }, [`Show pull requests (${count})`]);
      done.toggleAttribute('disabled', count === 0);
      children.push(h('div', { class: 'prr-done' }, [done]));
    } else {
      children.push(...renderPrList(project));
    }
  }
  swap(root, children);
  renderDrawer(project);
  if (scroller) scroller.scrollTop = scrollTop;

  if (!focusRole && focusAction) {
    const same = `[data-action="${focusAction}"]${focusRepo ? `[data-repo="${focusRepo}"]` : ''}${focusNumber ? `[data-number="${focusNumber}"]` : ''}`;
    const row = focusRepo && focusNumber ? `[data-repo="${focusRepo}"][data-number="${focusNumber}"]` : '';
    const target = root.querySelector<HTMLElement>(same) ?? (row ? root.querySelector<HTMLElement>(`button${row}`) : null);
    target?.focus({ preventScroll: true });
  }

  if (focusRole) {
    const input = document.querySelector<HTMLInputElement>(`#${PANEL_ID} [data-role="${focusRole}"]`);
    input?.focus();
    if (input && caret !== null) input.setSelectionRange(caret, caret);
  }
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export function openPrReviews(): void {
  window.dispatchEvent(new CustomEvent('rds:app-panel-open', { detail: PANEL_ID }));
  void loadProjects();
}

function closePrReviews(): void {
  closeDrawer(false);
  window.dispatchEvent(new CustomEvent('rds:app-panel-close', { detail: PANEL_ID }));
}

/** Move focus into the drawer: the repo filter once it exists, else the close button. */
function focusDrawer(): void {
  const drawer = document.getElementById('prReviewsDrawer');
  if (!drawer || drawer.hidden) return;
  (drawer.querySelector<HTMLElement>('[data-role="picker-filter"]') ?? drawer.querySelector<HTMLElement>('.prr-close'))?.focus();
}

function openDrawer(): void {
  const project = selected();
  if (!project) return;
  drawerOpen = true;
  devicesOpen = false;
  pickerFilter = '';
  render();
  focusDrawer();
  if (!scanned.has(project.id)) void scan(project);
}

function openDevices(): void {
  window.clearInterval(devicePoll);
  devicePoll = window.setInterval(() => void loadDevices(), 30_000);
  devicesOpen = true;
  drawerOpen = false;
  render();
  document.querySelector<HTMLElement>('#prReviewsDrawer .prr-close')?.focus();
  void loadDevices();
  if (!found.length) void discoverDevices();
}

function closeDrawer(restoreFocus = true): void {
  if (reviewView) {
    reviewView = null;
    render();
    return;
  }
  if (devicesOpen) {
    window.clearInterval(devicePoll);
    devicesOpen = false;
    render();
    if (restoreFocus) document.querySelector<HTMLElement>('#prReviewsRoot [data-action="open-devices"]')?.focus();
    return;
  }
  if (!drawerOpen) return;
  drawerOpen = false;
  const project = selected();
  render();
  if (restoreFocus) document.querySelector<HTMLElement>('#prReviewsRoot [data-action="open-drawer"]')?.focus();
  if (reposDirty && project) {
    reposDirty = false;
    prData.delete(project.id);
    visibleLimit = PR_PAGE;
    repoFilter = '';
    void loadPrs(project);
  }
}

function finishPicking(): void {
  const project = selected();
  if (!project || chosenRepos(project).length === 0) return;
  picking = false;
  reposDirty = false;
  pickerFilter = '';
  prData.delete(project.id);
  render();
  void loadPrs(project);
}

function selectProject(id: string): void {
  selectedId = id;
  const project = selected();
  pickerFilter = '';
  repoFilter = '';
  search = '';
  visibleLimit = PR_PAGE;
  error = '';
  prError = '';
  drawerOpen = false;
  reposDirty = false;
  picking = project ? chosenRepos(project).length === 0 : false;
  reviewView = null;
  render();
  if (project) {
    void loadReviews(project);
    void onProjectReady(project);
  }
}

function handleClick(event: Event): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.getAttribute('data-action');
  const project = selected();
  const repo = target.getAttribute('data-repo') ?? '';

  const number = Number(target.getAttribute('data-number'));
  if (action === 'close-panel') closePrReviews();
  else if (action === 'manage-projects') openSettingsProjects();
  else if (action === 'start-review' && project && repo && number) void startReview(project, repo, number);
  else if (action === 'cancel-review' && project && repo && number) void reviewsApi?.cancel({ projectId: project.id, repo, number });
  else if (action === 'view-review' && repo && number) void openReview(repo, number);
  else if (action === 'copy-comment') {
    const text = target.getAttribute('data-text') ?? '';
    void (window as unknown as { roku?: { copyToClipboard?: (t: string) => Promise<unknown> } }).roku?.copyToClipboard?.(text);
    target.textContent = 'Copied';
    window.setTimeout(() => (target.textContent = 'Copy'), 1500);
  }
  else if (action === 'dismiss-finding' && project) {
    dismissing = { id: target.getAttribute('data-id') ?? '' };
    renderDrawer(project);
    document.querySelector<HTMLInputElement>('#prReviewsDrawer [data-role="dismiss-reason"]')?.focus();
  }
  else if (action === 'cancel-dismiss' && project) {
    dismissing = null;
    renderDrawer(project);
  }
  else if (action === 'confirm-dismiss' || action === 'restore-finding') void dismissAction(action, target.getAttribute('data-id') ?? '');
  else if (posting && reviewView?.data && handlePostingAction(action, target, reviewView.data)) return;
  else if ((action === 'export-prompt' || action === 'export-report' || action === 'export-save') && reviewView?.data) {
    const data = reviewView.data;
    if (action === 'export-prompt') copyText(reviewMarkdown('prompt', data), target, 'Copy fix prompt');
    else if (action === 'export-report') copyText(reviewMarkdown('report', data), target, 'Copy report');
    else saveMarkdown(reviewMarkdown('report', data), `review-${data.repo.split('/')[1] ?? 'pr'}-${data.number}.md`);
  } else if (action === 'jump-section') document.getElementById(target.getAttribute('data-target') ?? '')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else if (action === 'open-devices') openDevices();
  else if (action === 'discover-devices') void discoverDevices();
  else if (action === 'add-device') void addToPool(target.getAttribute('data-key') ?? '');
  else if (action === 'remove-device') {
    const key = target.getAttribute('data-key');
    void setPool(devices.filter((d) => d.key !== key));
  } else if (action === 'device-password') {
    const device = devices.find((d) => d.key === target.getAttribute('data-key'));
    if (device) openPasswordDialog(device);
  }
  else if (action === 'open-drawer') openDrawer();
  else if (action === 'close-drawer') closeDrawer();
  else if (action === 'finish-picking') finishPicking();
  else if (action === 'open-pr') openPrUrl(target.getAttribute('data-url') ?? '');
  else if (action === 'set-filter') {
    prFilter = (target.getAttribute('data-filter') as PrFilter) ?? 'all';
    visibleLimit = PR_PAGE;
    render();
  } else if (action === 'clear-filters') {
    prFilter = 'all';
    repoFilter = '';
    search = '';
    visibleLimit = PR_PAGE;
    render();
  } else if (action === 'show-more') {
    visibleLimit += PR_PAGE;
    render();
  } else if (action === 'refresh' && project) void loadPrs(project);
  else if (action === 'rescan' && project) {
    scanned.delete(project.id);
    void scan(project);
  } else if (action === 'add-repo' && project) void saveRepos(project, [...chosenRepos(project), repo]);
  else if (action === 'add-all' && project) void saveRepos(project, [...chosenRepos(project), ...browseMatches(project).shown]);
  else if (action === 'remove-repo' && project) void saveRepos(project, chosenRepos(project).filter((r) => r !== repo));
  else if (action === 'remove-all' && project && window.confirm(`Stop reviewing all ${chosenRepos(project).length} repos in ${project.name}?`)) void saveRepos(project, []);
}

/** After ticking or unticking: update the comments' state and the post bar in place, no redraw. */
function refreshPostSelection(data: StoredReview): void {
  const ps = posting;
  const drawer = document.getElementById('prReviewsDrawer');
  if (!ps || !drawer) return;
  drawer.querySelectorAll<HTMLElement>('[data-comment-id]').forEach((card) => {
    const id = card.getAttribute('data-comment-id') ?? '';
    if (ps.state.posted[id]) return;
    const on = id === GENERAL_ID ? ps.general : !ps.unchecked.has(id);
    card.classList.toggle('prr-postable-on', on);
    const box = card.querySelector<HTMLInputElement>('.prr-post-check');
    if (box) box.checked = on;
  });
  drawer.querySelector('.prr-postbar')?.replaceWith(renderPostBar(data.result));
}

/** Clicks inside the posting UI. Returns true when handled. */
function handlePostingAction(action: string | null, target: HTMLElement, data: StoredReview): boolean {
  const ps = posting!;
  const project = selected();
  if (!project || !reviewsApi) return false;
  const id = target.getAttribute('data-id') ?? '';
  const ref = { projectId: project.id, repo: data.repo, number: data.number };
  const rerender = () => renderDrawer(project);
  switch (action) {
    case 'toggle-post':
      if (ps.unchecked.has(id)) ps.unchecked.delete(id);
      else ps.unchecked.add(id);
      refreshPostSelection(data);
      return true;
    case 'toggle-general':
      ps.general = !ps.general;
      refreshPostSelection(data);
      return true;
    case 'select-all-posts':
      ps.unchecked.clear();
      refreshPostSelection(data);
      return true;
    case 'select-no-posts':
      for (const f of postableFindings(data.result)) ps.unchecked.add(f.id);
      refreshPostSelection(data);
      return true;
    case 'edit-comment': {
      const f = data.result.findings.find((x) => x.id === id);
      ps.editing = id;
      ps.draft = id === GENERAL_ID ? generalText(data.result) : f ? commentText(f) : '';
      rerender();
      document.querySelector<HTMLTextAreaElement>('#prReviewsDrawer [data-role="comment-draft"]')?.focus();
      return true;
    }
    case 'cancel-edit-comment':
      ps.editing = null;
      rerender();
      return true;
    case 'save-edit-comment':
    case 'restore-comment':
      void reviewsApi.saveComment({ ...ref, id, text: action === 'restore-comment' ? null : ps.draft }).then((res) => {
        if (res?.success && res.state) ps.state = res.state;
        ps.error = res?.success ? '' : res?.error || 'Could not save.';
        ps.editing = null;
        rerender();
      });
      return true;
    case 'post-comments': {
      const ids = selectedPostIds(data.result);
      const general = ps.general && !ps.state.posted[GENERAL_ID] ? generalText(data.result) : null;
      ps.error = '';
      void reviewsApi.post({ ...ref, ids, general, spaced: ps.spaced, maxMinutes: ps.maxMinutes }).then((res) => {
        if (res?.success && res.run) ps.run = res.run;
        else ps.error = res?.error || 'Could not post.';
        rerender();
      });
      return true;
    }
    default:
      return false;
  }
}

function handleChange(event: Event): void {
  const target = event.target as HTMLSelectElement;
  const role = target.getAttribute('data-role');
  if (role === 'post-spaced' && posting) {
    posting.spaced = (target as unknown as HTMLInputElement).checked;
    const max = document.querySelector<HTMLInputElement>('#prReviewsDrawer [data-role="post-max"]');
    if (max) max.disabled = !posting.spaced;
    return;
  }
  if (role === 'project-select') selectProject(target.value);
  else if (role === 'repo-filter') {
    repoFilter = target.value;
    visibleLimit = PR_PAGE;
    render();
  }
}

function handleInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  const role = target.getAttribute('data-role');
  if (role === 'comment-draft' && posting) {
    posting.draft = target.value;
    return;
  }
  if (role === 'post-max' && posting) {
    posting.maxMinutes = Math.max(1, Math.min(60, Math.round(Number(target.value) || 5)));
    return;
  }
  if (role === 'pr-search') {
    search = target.value;
    visibleLimit = PR_PAGE;
    render();
  } else if (role === 'picker-filter') {
    pickerFilter = target.value;
    render();
  }
}

function handleKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (target.getAttribute('data-role') === 'dismiss-reason' && event.key === 'Enter') {
    event.preventDefault();
    void dismissAction('confirm-dismiss', target.getAttribute('data-id') ?? '');
    return;
  }
  if (target.getAttribute('data-role') !== 'picker-filter' || event.key !== 'Enter') return;
  event.preventDefault();
  const project = selected();
  const first = project ? browseMatches(project).shown[0] : undefined;
  if (project && first) void saveRepos(project, [...chosenRepos(project), first]);
}

export function initPrReviewsPanel(): void {
  const root = document.getElementById('prReviewsRoot');
  const drawer = document.getElementById('prReviewsDrawer');
  if (!root || !drawer) return;
  for (const container of [root, drawer]) {
    container.addEventListener('click', handleClick);
    container.addEventListener('change', handleChange);
    container.addEventListener('input', handleInput);
    container.addEventListener('keydown', (event) => handleKeydown(event as KeyboardEvent));
  }
  document.addEventListener('keydown', (event) => {
    // The password dialog handles its own Escape.
    if (event.key === 'Escape' && (drawerOpen || devicesOpen || reviewView) && isOpen() && !document.querySelector('dialog.prr-dialog[open]')) closeDrawer();
  });
  reviewsApi?.onUpdate((summary) => applySummary(summary));
  reviewsApi?.onPostUpdate((update) => {
    if (!posting || posting.key !== `${update.projectId}|${update.repo}#${update.number}`) return;
    posting.run = update;
    posting.state.posted = update.posted;
    const project = selected();
    // Do not yank a comment being edited out from under the cursor.
    if (project && !posting.editing) renderDrawer(project);
  });
  // Countdown to the next comment, without re-rendering.
  window.setInterval(() => {
    document.querySelectorAll<HTMLElement>('#prReviewsDrawer [data-countdown]').forEach((el) => (el.textContent = countdown(Number(el.dataset.countdown))));
  }, 1000);
  for (const id of ['sidebarPrReviewsBtn', 'titlebarPrReviewsBtn', 'welcomePrReviewsCta']) {
    document.getElementById(id)?.addEventListener('click', () => openPrReviews());
  }
  // Coming back from Settings (new project or token) should show the change without reopening.
  window.addEventListener('focus', () => {
    if (isOpen()) void loadProjects();
  });
  // While open: keep the "Updated … ago" label honest and refresh stale data.
  window.setInterval(() => {
    if (!isOpen() || drawerOpen) return;
    const project = selected();
    const cached = project ? prData.get(project.id) : undefined;
    if (project && cached && !isPicking(project) && Date.now() - cached.fetchedAt > REFRESH_MS) void loadPrs(project, true);
    // Only the label ages: update its text in place instead of redrawing the list.
    else document.querySelectorAll<HTMLElement>(`#${PANEL_ID} [data-ago]`).forEach((el) => (el.textContent = `Updated ${timeAgo(new Date(Number(el.dataset.ago)).toISOString())}`));
  }, 60 * 1000);
  render();
}
