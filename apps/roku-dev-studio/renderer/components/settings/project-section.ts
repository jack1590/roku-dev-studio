/**
 * Projects section (Settings window).
 *
 * A project is a company or team: a name plus its own token rows (GitHub, JIRA, Figma). The
 * GitHub token decides which repos are available: its own repos plus every org it
 * belongs to. Tokens are write-only here: the input is cleared after save, and the UI only
 * learns whether a token exists.
 */

import { MODEL_SLOTS, RECOMMENDED_MODELS, REVIEW_INSTRUCTIONS_MAX, REVIEW_LIMITS, WIKI_DEFAULTS, defaultCompanyTag } from '@shared/project-config.js';
import type { ModelSlotId } from '@shared/project-config.js';

type ProjectTokenService = 'github' | 'cursor' | 'jira' | 'figma';

interface ProjectItem {
  id: string;
  name: string;
  repos?: string[];
  jiraSite?: string;
  jiraEmail?: string;
  figmaTestUrl?: string;
  models?: Partial<Record<ModelSlotId, string>>;
  reviewInstructions?: string;
  probeRounds?: number;
  deviceMinutes?: number;
  incrementalReview?: boolean;
  wikiEnabled?: boolean;
  wikiDir?: string;
  wikiTags?: string[];
  wikiCompanyTag?: string;
  builds?: Record<string, { command: string; outDir: string; install: string; rootDir?: string; testCommand?: string; testOutDir?: string; detectedFrom?: string; approvedAt?: number; envFiles?: number; envVars?: number }>;
  tokens: Record<ProjectTokenService, boolean>;
}

interface WikiPreview {
  loading?: boolean;
  error?: string;
  pagesScanned?: number;
  totalChars?: number;
  excerpts?: { slug: string; title: string; updated: string; reasons: string[]; chars: number }[];
  skipped?: { slug: string; reason: string }[];
}

interface CursorModel {
  id: string;
  label: string;
  description?: string;
}

/** Unsaved edits to the AI review section, per project, so a re-render never drops them. */
interface ReviewDraft {
  models?: Partial<Record<ModelSlotId, string>>;
  reviewInstructions?: string;
  probeRounds?: string;
  deviceMinutes?: string;
  incrementalReview?: boolean;
  suggested?: boolean;
  wikiEnabled?: boolean;
  wikiDir?: string;
  /** Raw text of the tags box, comma or space separated. */
  wikiTags?: string;
  wikiCompanyTag?: string;
}

type ExtraField = { name: 'jiraSite' | 'jiraEmail' | 'figmaTestUrl'; label: string; placeholder: string };

/** Non-secret fields that sit next to a service's token. Needed to call the service. */
const EXTRA_FIELDS: Partial<Record<ProjectTokenService, ExtraField[]>> = {
  jira: [
    { name: 'jiraSite', label: 'JIRA site URL', placeholder: 'https://acme.atlassian.net' },
    { name: 'jiraEmail', label: 'JIRA account email', placeholder: 'you@acme.com' },
  ],
  figma: [{ name: 'figmaTestUrl', label: 'Figma test file URL', placeholder: 'https://www.figma.com/design/…' }],
};

interface ListResult {
  success: boolean;
  projects?: ProjectItem[];
  tokenStorageAvailable?: boolean;
  error?: string;
}

const SERVICE_LABELS: Record<ProjectTokenService, string> = {
  github: 'GitHub token',
  cursor: 'Cursor API key',
  jira: 'JIRA API token',
  figma: 'Figma token',
};

type HintPart = string | { code: string } | { link: string; label: string };

/** How to create each token. With links that open outside the app. */
const TOKEN_HINTS: Record<ProjectTokenService, HintPart[]> = {
  github: [
    'Create a classic personal access token at ',
    { link: 'https://github.com/settings/tokens', label: 'github.com/settings/tokens' },
    ' with ',
    { code: 'repo' },
    ' and ',
    { code: 'read:org' },
    ', or paste the output of ',
    { code: 'gh auth token' },
    '. It sees your repos and every org you belong to. Fine-grained tokens cover only one owner.',
  ],
  cursor: [
    'Every AI review runs through your Cursor account. Create a key at ',
    { link: 'https://cursor.com/dashboard/integrations', label: 'cursor.com/dashboard/integrations' },
    '. Reviews send PR code to the models chosen below.',
  ],
  jira: [
    'Create an API token at ',
    { link: 'https://id.atlassian.com/manage-profile/security/api-tokens', label: 'id.atlassian.com' },
    '. Use the same account email as below. Reads tickets linked to a PR.',
  ],
  figma: [
    'Create a personal access token with only ',
    { code: 'file_content:read' },
    ' at ',
    { link: 'https://www.figma.com/developers/api#access-tokens', label: 'figma.com/developers' },
    '. Reads design files linked to a ticket.',
  ],
};

function renderHint(parts: HintPart[]): HTMLElement {
  return h(
    'span',
    { class: 'projects-hint' },
    parts.map((part) => {
      if (typeof part === 'string') return part;
      if ('code' in part) return h('code', { class: 'projects-code' }, [part.code]);
      return h('a', { href: part.link, 'data-external': part.link, class: 'projects-link' }, [part.label]);
    })
  );
}

const api = (window as any).settingsApi;

let projects: ProjectItem[] = [];
let selectedId: string | null = null;
let tokenStorageAvailable = true;
let pageError = '';
/** What the user typed in the Add form, so a failed add does not wipe it on re-render. */
let addDraft = '';
const modelCache = new Map<string, { loading: boolean; models?: CursorModel[]; error?: string }>();
const reviewDrafts = new Map<string, ReviewDraft>();
const reviewStatus = new Map<string, string>();
const wikiPreviews = new Map<string, WikiPreview>();

/** Per "projectId|repo": unsaved build fields, detection state, and the env box text. */
interface BuildDraft {
  command?: string;
  outDir?: string;
  install?: string;
  rootDir?: string;
  testCommand?: string;
  testOutDir?: string;
  /** Project folders found in the repo, for the picker. */
  roots?: string[];
  /** Test builds found in the project folder, for the picker. */
  testOptions?: { command: string; outDir: string; from: string }[];
  detectedFrom?: string;
  detecting?: boolean;
  status?: string;
  error?: string;
  envText?: string;
  envStatus?: string;
}
const buildDrafts = new Map<string, BuildDraft>();

interface RememberedDismissal { id: string; file?: string; title: string; reason?: string; at: number; prNumber?: number }
/** Remembered dismissals per project (by repo), loaded when the AI review tab opens. */
const dismissalCache = new Map<string, { loading: boolean; byRepo?: Record<string, RememberedDismissal[]> }>();

async function loadDismissals(project: ProjectItem): Promise<void> {
  dismissalCache.set(project.id, { loading: true, byRepo: dismissalCache.get(project.id)?.byRepo });
  const res = await api.reviewsDismissals(project.repos ?? []);
  dismissalCache.set(project.id, { loading: false, byRepo: res?.success ? res.dismissals : {} });
  render();
}

function renderDismissals(project: ProjectItem): HTMLElement {
  const cache = dismissalCache.get(project.id);
  if (!cache) void loadDismissals(project);
  const repos = Object.entries(cache?.byRepo ?? {}).filter(([, list]) => list.length);
  const body = !cache?.byRepo
    ? [h('p', { class: 'projects-hint' }, ['Loading…'])]
    : !repos.length
      ? [h('p', { class: 'projects-hint' }, ['Nothing dismissed yet. Use Dismiss on a finding in PR Reviews.'])]
      : repos.map(([repo, list]) =>
          h('div', { class: 'projects-dismissals' }, [
            h('h5', { class: 'projects-dismissals-repo' }, [`${repo} (${list.length})`]),
            h('ul', { class: 'projects-dismissals-list' }, list.map((d) =>
              h('li', { class: 'projects-dismissal' }, [
                h('div', {}, [
                  h('strong', {}, [d.title]),
                  h('p', { class: 'projects-hint' }, [[d.file, d.prNumber ? `#${d.prNumber}` : '', new Date(d.at).toLocaleDateString()].filter(Boolean).join(' · ') + (d.reason ? ` — ${d.reason}` : '')]),
                ]),
                h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'forget-dismissal', 'data-repo': repo, 'data-id': d.id, title: 'Raise it again on future reviews' }, ['Restore']),
              ]),
            )),
          ]),
        );
  return h('section', { class: 'projects-group' }, [
    h('div', { class: 'projects-group-head' }, [
      h('div', {}, [h('h4', { class: 'projects-group-title' }, ['Dismissed findings']), h('p', { class: 'projects-hint' }, ['Reviews stop raising these. One dismissal covers its file; two of the same kind cover the whole repo. Restore takes effect on the next review.'])]),
    ]),
    ...body,
  ]);
}
const buildKey = (projectId: string, repo: string) => `${projectId}|${repo}`;

function buildDraft(project: ProjectItem, repo: string): BuildDraft {
  return buildDrafts.get(buildKey(project.id, repo)) ?? {};
}

function patchBuildDraft(project: ProjectItem, repo: string, patch: Partial<BuildDraft>): void {
  buildDrafts.set(buildKey(project.id, repo), { ...buildDraft(project, repo), ...patch });
}

async function detectBuildFor(project: ProjectItem, repo: string, root?: string): Promise<void> {
  const folder = root ?? buildValues(project, repo).rootDir;
  patchBuildDraft(project, repo, { detecting: true, error: '', status: '', rootDir: folder });
  render();
  const res = await api.projectsBuildDetect(project.id, repo, folder);
  const roots = Array.isArray(res?.roots) ? (res.roots as string[]) : undefined;
  if (res?.success) {
    const d = res.detected;
    const options = (d.testOptions ?? []) as { command: string; outDir: string; from: string }[];
    patchBuildDraft(project, repo, {
      detecting: false,
      roots,
      rootDir: d.root ?? folder,
      command: d.command,
      outDir: d.outDir,
      install: d.install,
      testCommand: d.testCommand ?? '',
      testOutDir: d.testOutDir ?? '',
      testOptions: options,
      detectedFrom: `${d.detectedFrom} on ${d.branch}`,
      status: options.length > 1 ? `Found ${options.length} test builds. Pick one, check it, then approve.` : d.testCommand ? 'Detected. Check the commands, then approve.' : 'No test build found in this folder. Enter it, or leave it empty: device checks then never run for this repo.',
    });
  } else {
    patchBuildDraft(project, repo, { detecting: false, roots, testOptions: [], error: res?.error || 'Could not detect the build.' });
  }
  render();
}

function buildValues(project: ProjectItem, repo: string): { command: string; outDir: string; install: string; rootDir: string; testCommand: string; testOutDir: string; detectedFrom?: string } {
  const saved = project.builds?.[repo];
  const draft = buildDraft(project, repo);
  return {
    command: draft.command ?? saved?.command ?? '',
    outDir: draft.outDir ?? saved?.outDir ?? 'dist',
    install: draft.install ?? saved?.install ?? '',
    rootDir: draft.rootDir ?? saved?.rootDir ?? '',
    testCommand: draft.testCommand ?? saved?.testCommand ?? '',
    testOutDir: draft.testOutDir ?? saved?.testOutDir ?? '',
    detectedFrom: draft.detectedFrom ?? saved?.detectedFrom,
  };
}

async function approveBuild(project: ProjectItem, repo: string): Promise<void> {
  const values = buildValues(project, repo);
  const res = await api.projectsBuildSave({ id: project.id, repo, ...values });
  if (!res?.success) {
    patchBuildDraft(project, repo, { error: res?.error || 'Could not save.', status: '' });
    render();
    return;
  }
  patchBuildDraft(project, repo, { command: undefined, outDir: undefined, install: undefined, rootDir: undefined, testCommand: undefined, testOutDir: undefined, error: '', status: 'Approved. Device checks will use these commands.' });
  await refresh();
}

async function saveBuildEnv(project: ProjectItem, repo: string): Promise<void> {
  const text = buildDraft(project, repo).envText ?? '';
  if (!text.trim()) {
    patchBuildDraft(project, repo, { envStatus: 'Paste the .env content first.' });
    render();
    return;
  }
  const res = await api.projectsBuildEnvSave(project.id, repo, text);
  if (!res?.success) {
    patchBuildDraft(project, repo, { envStatus: res?.error || 'Could not save.' });
    render();
    return;
  }
  const removed = res.removed?.length ? ` ${res.removed.join(', ')} removed: they come from the test device.` : '';
  // Clear the box: the values are now encrypted and are not shown again.
  patchBuildDraft(project, repo, { envText: '', envStatus: `Saved ${res.vars} values in ${res.files.length} file(s): ${res.files.join(', ')}.${removed}` });
  await refresh();
}

async function clearBuildEnv(project: ProjectItem, repo: string): Promise<void> {
  if (!window.confirm(`Delete the saved build env for ${repo}?`)) return;
  const res = await api.projectsBuildEnvClear(project.id, repo);
  patchBuildDraft(project, repo, { envStatus: res?.success ? 'Deleted.' : res?.error || 'Could not delete.' });
  await refresh();
}

/** Repo whose build is open in Device testing, per project. UI state only. */
const selectedBuildRepo = new Map<string, string>();

function buildState(project: ProjectItem, repo: string): { approved: boolean; envVars: number; envFiles: number; ready: boolean } {
  const saved = project.builds?.[repo];
  const approved = !!saved?.approvedAt;
  return { approved: approved && !!saved?.testCommand, envVars: saved?.envVars ?? 0, envFiles: saved?.envFiles ?? 0, ready: approved && !!saved?.testCommand };
}

function renderBuildEditor(project: ProjectItem, repo: string): HTMLElement {
  const saved = project.builds?.[repo];
  const draft = buildDraft(project, repo);
  const values = buildValues(project, repo);
  // Approval counts only once a test build is part of it (older approvals covered the app build only).
  const approved = !!saved?.approvedAt && !!saved?.testCommand;
  const changed = approved && (values.install !== saved!.install || values.rootDir !== (saved!.rootDir ?? '') || values.testCommand !== (saved!.testCommand ?? '') || values.testOutDir !== (saved!.testOutDir ?? ''));
  const field = (role: string, label: string, value: string, placeholder: string, hint: string) => {
    const input = h('input', { type: 'text', class: 'projects-text-input projects-mono', 'data-role': role, 'data-repo': repo, 'data-focus-key': `${role}:${repo}`, 'aria-label': `${label} for ${repo}`, placeholder, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    input.value = value;
    return h('label', { class: 'projects-field' }, [h('span', { class: 'projects-field-label' }, [label]), input, h('span', { class: 'projects-hint' }, [hint])]);
  };
  const envBox = h('textarea', {
    class: 'projects-textarea',
    rows: '6',
    spellcheck: 'false',
    'data-role': 'env-text',
    'data-repo': repo,
    'data-focus-key': `env-text:${repo}`,
    'aria-label': `Build env for ${repo}`,
    placeholder: saved?.envVars ? 'Saved values are hidden. Paste the full content again to replace them.' : 'APP_ENV=STG\nGITHUB_TOKEN=…\n\n# file: .env.STG\nAPI_URL=…',
  }) as HTMLTextAreaElement;
  envBox.value = draft.envText ?? '';
  const detect = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'detect-build', 'data-repo': repo }, [draft.detecting ? 'Detecting…' : 'Detect from repo']);
  detect.toggleAttribute('disabled', !!draft.detecting || !project.tokens.github);
  const buildStatus = approved ? (changed ? 'Edited, not approved yet' : 'Approved') : 'Not approved';

  return h('div', { class: 'projects-build-editor', role: 'region', 'aria-label': `Build for ${repo}` }, [
    h('div', { class: 'projects-build-step' }, [
      h('div', { class: 'projects-build-step-head' }, [
        h('span', { class: `projects-step-num${approved && !changed ? ' projects-step-num-done' : ''}` }, [approved && !changed ? '✓' : '1']),
        h('div', {}, [h('strong', {}, ['Test build']), h('span', { class: 'projects-hint' }, [`${buildStatus}. ${values.detectedFrom ? `Detected from ${values.detectedFrom}.` : 'Detect it from the repo, or type the commands.'}`])]),
        detect,
      ]),
      (() => {
        // Project folder: a picker once detection has listed the repo's Roku projects, else a text field.
        const roots = draft.roots ?? [];
        if (roots.length > 1 || (roots.length === 1 && roots[0] !== values.rootDir)) {
          const sel = h('select', { class: 'settings-select', 'data-role': 'build-root', 'data-repo': repo, 'aria-label': `Project folder for ${repo}` }, [
            ...roots.map((r) => h('option', { value: r }, [r || '(repo root)'])),
            ...(roots.includes(values.rootDir) ? [] : [h('option', { value: values.rootDir }, [values.rootDir || '(repo root)'])]),
          ]) as HTMLSelectElement;
          sel.value = values.rootDir;
          return h('label', { class: 'projects-field' }, [h('span', { class: 'projects-field-label' }, ['Project folder']), sel, h('span', { class: 'projects-hint' }, ['Folders of the repo that hold a Roku project. Picking one detects its builds; commands run there.'])]);
        }
        return field('build-root', 'Project folder', values.rootDir, '(repo root)', 'Leave empty when the Roku project is at the repo root. Detect lists the project folders it finds.');
      })(),
      ...((draft.testOptions?.length ?? 0) > 1
        ? [
            (() => {
              const opts = draft.testOptions!;
              const sel = h('select', { class: 'settings-select', 'data-role': 'build-test-option', 'data-repo': repo, 'aria-label': `Test build for ${repo}` },
                opts.map((o, i) => h('option', { value: String(i) }, [`${o.command}${o.outDir ? ` → ${o.outDir}` : ''}  ·  ${o.from}`]))) as HTMLSelectElement;
              const current = opts.findIndex((o) => o.command === values.testCommand);
              sel.value = String(current >= 0 ? current : 0);
              return h('label', { class: 'projects-field' }, [h('span', { class: 'projects-field-label' }, [`Test build (${opts.length} found)`]), sel, h('span', { class: 'projects-hint' }, ['Pick the test channel device checks should build. It fills in the two fields below.'])]);
            })(),
          ]
        : []),
      field('build-test-command', 'Test build command', values.testCommand, 'npm run test:build', 'Builds the unit-test channel. Runs in an isolated copy of the PR with only the PR’s own test files; nothing is written.'),
      h('div', { class: 'projects-build-pair' }, [
        field('build-test-outdir', 'Test output folder', values.testOutDir, 'out/tests-staging', 'Zipped and sideloaded. Must contain the manifest.'),
        field('build-install', 'Install command', values.install, 'npm ci', 'Runs once per lockfile; cached.'),
      ]),
      h('p', { class: 'projects-warn' }, ['Device checks for this repo stay blocked until you approve: these commands run on your machine with the PR’s code, including package install scripts. Approve only if you trust this repo’s build.']),
      h('div', { class: 'projects-review-actions' }, [
        h('span', { class: 'projects-token-status', 'aria-live': 'polite' }, [draft.error || draft.status || '']),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'approve-build', 'data-repo': repo }, [approved && !changed ? 'Approved ✓' : 'Save and approve']),
      ]),
    ]),
    h('div', { class: 'projects-build-step' }, [
      h('div', { class: 'projects-build-step-head' }, [
        h('span', { class: `projects-step-num${saved?.envVars ? ' projects-step-num-done' : ''}` }, [saved?.envVars ? '✓' : '2']),
        h('div', {}, [
          h('strong', {}, ['Environment']),
          h('span', { class: 'projects-hint' }, [saved?.envVars ? `${saved.envVars} values in ${saved.envFiles} file(s) saved for this repo. Paste again to replace.` : 'Optional. Only if this repo’s build needs a .env.']),
        ]),
      ]),
      envBox,
      h('span', { class: 'projects-hint' }, ['Start another file with a line like "# file: .env.STG". Saved encrypted for this repo only, never shown again, never sent to the AI. ROKU_IP and ROKU_DEV_PASSWORD come from the test device.']),
      h('div', { class: 'projects-review-actions' }, [
        h('span', { class: 'projects-token-status', 'aria-live': 'polite' }, [draft.envStatus ?? '']),
        ...(saved?.envVars ? [h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'clear-env', 'data-repo': repo }, ['Delete env'])] : []),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'save-env', 'data-repo': repo }, [saved?.envVars ? 'Replace env' : 'Save env']),
      ]),
    ]),
  ]);
}

function renderBuildSection(project: ProjectItem): HTMLElement {
  const repos = project.repos ?? [];
  const head = (extra: string) =>
    h('div', { class: 'projects-group-head' }, [
      h('div', {}, [h('h4', { class: 'projects-group-title' }, ['Test builds']), h('p', { class: 'projects-hint' }, [`A device check runs only the PR’s own unit tests on a test device, and only when a finding needs proof and a PR test covers it. Each repo has its own test build and env.${extra}`])]),
    ]);
  if (!repos.length) return h('section', { class: 'projects-group' }, [head(''), h('p', { class: 'projects-hint' }, ['Choose repos in PR Reviews first.'])]);

  const stored = selectedBuildRepo.get(project.id);
  const current = stored && repos.includes(stored) ? stored : repos.find((r) => !buildState(project, r).ready) ?? repos[0];
  const readyCount = repos.filter((r) => buildState(project, r).ready).length;

  const list = h(
    'div',
    { class: 'projects-repo-list', role: 'listbox', 'aria-label': 'Repos' },
    repos.map((repo) => {
      const st = buildState(project, repo);
      const [owner, name] = repo.split('/');
      return h('button', { type: 'button', role: 'option', 'aria-selected': String(repo === current), class: `projects-repo-item${repo === current ? ' active' : ''}`, 'data-action': 'select-build-repo', 'data-repo': repo }, [
        h('span', { class: `projects-status-dot${st.approved ? ' projects-status-dot-ok' : ' projects-status-dot-warn'}`, 'aria-hidden': 'true' }, []),
        h('span', { class: 'projects-repo-name' }, [h('strong', {}, [name ?? repo]), h('span', { class: 'projects-hint' }, [owner ?? ''])]),
        h('span', { class: 'projects-repo-tags' }, [
          h('span', { class: `projects-pill${st.approved ? ' projects-pill-on' : ''}` }, [st.approved ? 'Tests ✓' : 'Test build needed']),
          h('span', { class: `projects-pill${st.envVars ? ' projects-pill-on' : ''}` }, [st.envVars ? `Env ${st.envVars}` : 'No env']),
        ]),
      ]);
    })
  );

  return h('section', { class: 'projects-group' }, [
    head(` ${readyCount} of ${repos.length} ready.`),
    h('div', { class: 'projects-builds' }, [list, renderBuildEditor(project, current)]),
  ]);
}

interface WikiTagItem {
  tag: string;
  count: number;
  group: 'company' | 'project' | 'topic';
}
/** Tags found in a wiki folder, keyed by the folder as typed (e.g. "~/wiki"). */
const wikiTagCache = new Map<string, { loading: boolean; tags?: WikiTagItem[]; error?: string }>();
const wikiTagSearch = new Map<string, string>();

function parseTagList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

async function loadWikiTags(dir: string): Promise<void> {
  wikiTagCache.set(dir, { loading: true });
  const res = await api.projectsWikiTags(dir);
  wikiTagCache.set(dir, res?.success ? { loading: false, tags: res.tags } : { loading: false, error: res?.error || 'Could not read wiki tags.' });
  render();
}

function toggleWikiTag(project: ProjectItem, tag: string): void {
  const current = parseTagList(wikiValues(project).wikiTags);
  const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
  reviewDrafts.set(project.id, { ...(reviewDrafts.get(project.id) ?? {}), wikiTags: next.join(', ') });
  reviewStatus.delete(project.id);
  render();
}

function renderTagChip(tag: string, label: string, selectedChip: boolean): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: `projects-chip${selectedChip ? ' projects-chip-on' : ''}`,
      'data-action': 'toggle-wiki-tag',
      'data-tag': tag,
      'aria-pressed': String(selectedChip),
      title: selectedChip ? `Remove ${tag}` : `Add ${tag}`,
    },
    [label]
  );
}

function renderTagPicker(project: ProjectItem, known: WikiTagItem[], chosen: string[], companyTag: string, loading: boolean, error?: string): HTMLElement {
  const search = (wikiTagSearch.get(project.id) ?? '').trim().toLowerCase();
  const counts = new Map(known.map((t) => [t.tag, t.count]));
  const selectedRow = chosen.length
    ? h('div', { class: 'projects-chips' }, chosen.map((t) => renderTagChip(t, `${t}${counts.has(t) ? ` · ${counts.get(t)}` : ' · not in wiki'} ×`, true)))
    : h('p', { class: 'projects-hint' }, ['No extra tags. Tags rank pages within this company first. Pick another company, or a tag on pages with no company, to include those pages too.']);

  const searchInput = h('input', {
    type: 'search',
    class: 'projects-text-input',
    placeholder: 'Search tags',
    'aria-label': 'Search wiki tags',
    'data-role': 'wiki-tag-search',
    'data-focus-key': 'wiki-tag-search',
    spellcheck: 'false',
    autocomplete: 'off',
  }) as HTMLInputElement;
  searchInput.value = wikiTagSearch.get(project.id) ?? '';

  const groups: { id: WikiTagItem['group']; title: string }[] = [
    { id: 'project', title: 'Project tags' },
    { id: 'topic', title: 'Topics' },
    { id: 'company', title: 'Other companies' },
  ];
  const sections = groups
    .map((group) => {
      const available = known.filter((t) => t.group === group.id && t.tag !== companyTag && !chosen.includes(t.tag) && (!search || t.tag.includes(search)));
      if (!available.length) return null;
      return h('div', { class: 'projects-tag-group' }, [
        h('span', { class: 'projects-tag-group-title' }, [group.title]),
        h('div', { class: 'projects-chips' }, available.map((t) => renderTagChip(t.tag, `${t.tag} · ${t.count}`, false))),
      ]);
    })
    .filter((x): x is HTMLElement => x !== null);

  let body: HTMLElement[];
  if (loading) body = [h('p', { class: 'projects-hint' }, ['Reading tags from the wiki…'])];
  else if (error) body = [h('div', { class: 'projects-callout projects-callout-error', role: 'alert' }, [h('p', {}, [error]), h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'reload-wiki-tags' }, ['Try again'])])];
  else body = sections.length ? sections : [h('p', { class: 'projects-hint' }, [search ? `No tag matches “${search}”.` : 'Every tag is already selected.'])];

  return h('div', { class: 'projects-tagpicker' }, [
    h('div', { class: 'projects-tagpicker-head' }, [
      h('span', { class: 'projects-field-label' }, ['Extra tags']),
      h('button', { type: 'button', class: 'projects-link-btn', 'data-action': 'reload-wiki-tags', title: 'Read the tags from the wiki again' }, ['Reload tags']),
    ]),
    selectedRow,
    searchInput,
    ...body,
  ]);
}

/** Current wiki values for a project: unsaved edits first, then saved values, then defaults. */
function wikiValues(project: ProjectItem): { wikiEnabled: boolean; wikiDir: string; wikiTags: string; wikiCompanyTag: string } {
  const draft = reviewDrafts.get(project.id) ?? {};
  return {
    wikiEnabled: draft.wikiEnabled ?? project.wikiEnabled ?? WIKI_DEFAULTS.enabled,
    wikiDir: draft.wikiDir ?? project.wikiDir ?? WIKI_DEFAULTS.dir,
    wikiTags: draft.wikiTags ?? (project.wikiTags ?? WIKI_DEFAULTS.tags).join(', '),
    wikiCompanyTag: draft.wikiCompanyTag ?? project.wikiCompanyTag ?? '',
  };
}

async function previewWiki(project: ProjectItem): Promise<void> {
  wikiPreviews.set(project.id, { loading: true });
  render();
  // Company-wide view: during a review, the PR's own repo pages rank first within this same set.
  const res = await api.projectsWikiPreview({ id: project.id, repo: '', ...wikiValues(project) });
  wikiPreviews.set(project.id, res?.success ? res : { error: res?.error || 'Could not read the wiki.' });
  render();
}

/** Family fallback when none of the recommended ids exist, newest version first. */
const SLOT_FALLBACK: Partial<Record<ModelSlotId, RegExp>> = {
  reviewer1: /^gpt-\d/i,
  reviewer2: /composer|gemini.*pro/i,
  reviewer3: /sonnet/i,
  judge: /opus/i,
  fixer: /opus/i,
};

function recommendedModel(slot: ModelSlotId, models: CursorModel[]): string | undefined {
  const ids = new Set(models.map((m) => m.id));
  const exact = RECOMMENDED_MODELS[slot].find((id) => ids.has(id));
  if (exact) return exact;
  const pattern = SLOT_FALLBACK[slot];
  if (!pattern) return undefined;
  return models.filter((m) => pattern.test(m.id)).sort((x, y) => y.id.localeCompare(x.id, undefined, { numeric: true }))[0]?.id;
}

function suggestModels(models: CursorModel[]): Partial<Record<ModelSlotId, string>> {
  const picks: Partial<Record<ModelSlotId, string>> = {};
  for (const slot of MODEL_SLOTS) {
    const id = recommendedModel(slot.id, models);
    if (id) picks[slot.id] = id;
  }
  return picks;
}

async function loadModels(project: ProjectItem): Promise<void> {
  modelCache.set(project.id, { loading: true });
  const res = await api.projectsListModels(project.id);
  const entry = res?.success ? { loading: false, models: res.models as CursorModel[] } : { loading: false, error: res?.error || 'Could not load models.' };
  modelCache.set(project.id, entry);
  // Nothing saved yet: pre-fill suggestions so the user only has to review and save.
  if (entry.models && !Object.keys(project.models ?? {}).length && !reviewDrafts.get(project.id)?.models) {
    reviewDrafts.set(project.id, { ...reviewDrafts.get(project.id), models: suggestModels(entry.models), suggested: true });
  }
  render();
}

async function saveReview(project: ProjectItem): Promise<void> {
  const draft = reviewDrafts.get(project.id) ?? {};
  const res = await api.projectsSetReview({
    id: project.id,
    models: { ...(project.models ?? {}), ...(draft.models ?? {}) },
    reviewInstructions: draft.reviewInstructions ?? project.reviewInstructions ?? '',
    ...wikiValues(project),
    probeRounds: Number(draft.probeRounds ?? project.probeRounds ?? REVIEW_LIMITS.probeRounds.default),
    deviceMinutes: Number(draft.deviceMinutes ?? project.deviceMinutes ?? REVIEW_LIMITS.deviceMinutes.default),
    incrementalReview: draft.incrementalReview ?? project.incrementalReview ?? true,
  });
  if (!res?.success) {
    reviewStatus.set(project.id, res?.error || 'Could not save.');
    render();
    return;
  }
  reviewDrafts.delete(project.id);
  reviewStatus.set(project.id, 'Saved.');
  await refresh();
}

function h(tag: string, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

function displayName(project: ProjectItem): string {
  return project.name;
}

function selected(): ProjectItem | undefined {
  return projects.find((p) => p.id === selectedId);
}

async function refresh(): Promise<void> {
  if (!api?.projectsList) return;
  try {
    const res = (await api.projectsList()) as ListResult;
    if (!res.success) throw new Error(res.error || 'Could not load projects.');
    projects = res.projects ?? [];
    tokenStorageAvailable = res.tokenStorageAvailable !== false;
    if (!projects.some((p) => p.id === selectedId)) selectedId = projects[0]?.id ?? null;
    pageError = '';
  } catch (err) {
    pageError = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function addProject(form: HTMLElement): Promise<void> {
  addDraft = (form.querySelector('[name="name"]') as HTMLInputElement | null)?.value ?? '';
  const res = await api.projectsAdd({ name: addDraft });
  if (!res?.success) {
    pageError = res?.error || 'Could not add project.';
    render();
    focusAddInput();
    return;
  }
  // Close the form and show the saved project.
  const root = document.getElementById('projectsRoot');
  if (root) root.dataset.adding = 'false';
  addDraft = '';
  selectedId = res.project.id;
  pageError = '';
  await refresh();
}

function focusAddInput(): void {
  const input = document.querySelector<HTMLInputElement>('#projectsRoot [data-role="add-form"] [name="name"]');
  input?.focus();
  input?.select();
}

async function updateProject(project: ProjectItem, form: HTMLElement): Promise<void> {
  const read = (name: string) => (form.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? '';
  const res = await api.projectsUpdate({ id: project.id, name: read('name') });
  if (!res?.success) {
    pageError = res?.error || 'Could not save project.';
    render();
    return;
  }
  const root = document.getElementById('projectsRoot');
  if (root) root.dataset.editing = '';
  pageError = '';
  selectedId = res.project.id;
  await refresh();
}

async function removeSelected(project: ProjectItem): Promise<void> {
  const ok = window.confirm(
    `Remove "${displayName(project)}" from Roku Dev Studio?\n\nIts saved tokens will be deleted. Nothing on GitHub is affected.`
  );
  if (!ok) return;
  const res = await api.projectsRemove(project.id);
  if (!res?.success) pageError = res?.error || 'Could not remove project.';
  await refresh();
}

function renderAddForm(): HTMLElement {
  const field = (label: string, name: string, placeholder: string) =>
    h('label', { class: 'projects-field' }, [
      h('span', { class: 'projects-field-label' }, [label]),
      h('input', { type: 'text', name, placeholder, value: addDraft, autocomplete: 'off', spellcheck: 'false', class: 'projects-text-input' }),
    ]);
  return h('form', { class: 'projects-add-form', 'data-role': 'add-form' }, [
    field('Project name', 'name', 'e.g. Acme'),
    h('p', { class: 'projects-hint' }, [
      'Name the company or team. After adding it, save a GitHub token: its repos and every org it belongs to become available in PR Reviews.',
    ]),
    h('div', { class: 'projects-add-actions' }, [
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'cancel-add' }, ['Cancel']),
      h('button', { type: 'submit', class: 'btn btn-primary btn-sm', 'data-action': 'confirm-add' }, ['Add project']),
    ]),
  ]);
}

function renderEditForm(project: ProjectItem): HTMLElement {
  const field = (label: string, name: string, value: string, placeholder: string) =>
    h('label', { class: 'projects-field' }, [
      h('span', { class: 'projects-field-label' }, [label]),
      h('input', { type: 'text', name, value, placeholder, autocomplete: 'off', spellcheck: 'false', class: 'projects-text-input' }),
    ]);
  return h('form', { class: 'projects-add-form', 'data-role': 'edit-form' }, [
    field('Project name', 'name', project.name, 'e.g. Acme'),
    h('p', { class: 'projects-hint' }, ['Saved tokens and repos stay with this project when you rename it.']),
    h('div', { class: 'projects-add-actions' }, [
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'cancel-edit' }, ['Cancel']),
      h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, ['Save changes']),
    ]),
  ]);
}

/** Where the user is in a project's settings, kept across re-renders. UI state only. */
type ProjectTab = 'connections' | 'review' | 'knowledge' | 'device';
const projectTabs = new Map<string, ProjectTab>();
/** Token rows opened to add or replace a token ("<projectId>:<service>"). */
const openTokenRows = new Set<string>();

const REQUIRED_SERVICES: ProjectTokenService[] = ['github', 'cursor'];
const OPTIONAL_SERVICES: ProjectTokenService[] = ['jira', 'figma'];

function renderTokenRow(project: ProjectItem, service: ProjectTokenService): HTMLElement {
  const has = project.tokens[service];
  const required = REQUIRED_SERVICES.includes(service);
  const key = `${project.id}:${service}`;
  // A missing required token is open from the start; everything else opens on demand.
  const open = openTokenRows.has(key) || (required && !has);
  const extras = (EXTRA_FIELDS[service] ?? []).map((f) =>
    h('label', { class: 'projects-field' }, [
      h('span', { class: 'projects-field-label' }, [f.label]),
      h('input', {
        type: 'text',
        name: f.name,
        value: project[f.name] ?? '',
        placeholder: f.placeholder,
        autocomplete: 'off',
        spellcheck: 'false',
        class: 'projects-text-input',
      }),
    ])
  );
  // Non-secret details shown on the closed row, so the user can see what is configured.
  const details = (EXTRA_FIELDS[service] ?? []).map((f) => project[f.name]).filter(Boolean).join(' · ');

  const input = h('input', {
    type: 'password',
    class: 'projects-token-input',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: has ? 'Paste the new token' : 'Paste token',
    'aria-label': SERVICE_LABELS[service],
    'data-service': service,
  }) as HTMLInputElement;
  input.disabled = !tokenStorageAvailable;

  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'save-token', 'data-service': service }, [has ? 'Save' : `Save ${SERVICE_LABELS[service]}`]);
  save.toggleAttribute('disabled', !tokenStorageAvailable);
  const toggle = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'toggle-token-row', 'data-service': service, 'aria-expanded': String(open) }, [open ? 'Cancel' : has ? 'Replace' : 'Add']);
  const test = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'test-service', 'data-service': service }, ['Test']);
  const clear = h('button', { type: 'button', class: 'btn btn-ghost btn-sm projects-btn-quiet', 'data-action': 'clear-token', 'data-service': service, title: `Remove the saved ${SERVICE_LABELS[service]}` }, ['Remove']);
  const headActions = [...(has ? [test] : []), ...(open && required && !has ? [] : [toggle]), ...(has && !open ? [clear] : [])];

  return h('div', { class: `projects-token-row${open ? ' projects-token-row-open' : ''}`, 'data-service': service }, [
    h('div', { class: 'projects-token-head' }, [
      h('span', { class: `projects-status-dot${has ? ' projects-status-dot-ok' : required ? ' projects-status-dot-warn' : ''}`, 'aria-hidden': 'true' }, []),
      h('div', { class: 'projects-token-title' }, [
        h('strong', {}, [SERVICE_LABELS[service]]),
        h('span', { class: 'projects-hint' }, [has ? `Saved in keychain${details ? ` · ${details}` : ''}` : required ? 'Required' : 'Optional · not set']),
      ]),
      h('div', { class: 'projects-token-actions' }, headActions),
    ]),
    ...(open
      ? [
          h('div', { class: 'projects-token-body' }, [
            renderHint(TOKEN_HINTS[service]),
            ...extras,
            h('div', { class: 'projects-inline' }, [input, save]),
          ]),
        ]
      : []),
    h('span', { class: 'projects-token-status', 'aria-live': 'polite', 'data-status-for': service }, []),
  ]);
}

function renderWikiBlock(project: ProjectItem): HTMLElement {
  const values = wikiValues(project);
  const toggle = h('input', { type: 'checkbox', class: 'projects-checkbox', 'data-role': 'wiki-enabled', id: `wikiEnabled-${project.id}` }) as HTMLInputElement;
  toggle.checked = values.wikiEnabled;

  const dir = h('input', { type: 'text', class: 'projects-text-input', 'data-role': 'wiki-dir', 'data-focus-key': 'wiki-dir', 'aria-label': 'Wiki folder', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  dir.value = values.wikiDir;
  const companyDefault = defaultCompanyTag(project.name);
  const tagCache = wikiTagCache.get(values.wikiDir);
  if (values.wikiEnabled && !tagCache) void loadWikiTags(values.wikiDir);
  const known = tagCache?.tags ?? [];
  const countOf = (tag: string) => known.find((t) => t.tag === tag)?.count;
  const companies = known.filter((t) => t.group === 'company' && t.tag !== companyDefault);
  const defaultCount = countOf(companyDefault);
  const company = h('select', { class: 'settings-select', 'data-role': 'wiki-company', 'aria-label': 'Company tag' }, [
    h('option', { value: '' }, [`${companyDefault} (default${defaultCount ? ` · ${defaultCount} pages` : ' · no pages yet'})`]),
    ...(values.wikiCompanyTag && values.wikiCompanyTag !== companyDefault && !companies.some((t) => t.tag === values.wikiCompanyTag) ? [h('option', { value: values.wikiCompanyTag }, [`${values.wikiCompanyTag} (saved)`])] : []),
    ...companies.map((t) => h('option', { value: t.tag }, [`${t.tag} · ${t.count} pages`])),
  ]) as HTMLSelectElement;
  company.value = values.wikiCompanyTag === companyDefault ? '' : values.wikiCompanyTag;
  const activeCompany = values.wikiCompanyTag || companyDefault;
  const picker = renderTagPicker(project, known, parseTagList(values.wikiTags), activeCompany, !!tagCache?.loading, tagCache?.error);

  const previewBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'wiki-preview' }, ['Preview pages']);
  previewBtn.toggleAttribute('disabled', !values.wikiEnabled);

  const preview = wikiPreviews.get(project.id);
  let result: HTMLElement = h('span', {}, []);
  if (preview?.loading) result = h('p', { class: 'projects-hint' }, ['Reading the wiki…']);
  else if (preview?.error) result = h('div', { class: 'projects-callout projects-callout-error', role: 'alert' }, [h('p', {}, [preview.error])]);
  else if (preview?.excerpts) {
    const items = preview.excerpts.map((e) =>
      h('li', { class: 'projects-wiki-item' }, [
        h('strong', {}, [e.title]),
        h('span', { class: 'projects-hint' }, [`${e.reasons.join(' · ')}${e.updated ? ` · updated ${e.updated}` : ''} · ${e.chars} chars`]),
      ])
    );
    result = h('div', { class: 'projects-wiki-preview' }, [
      h('p', { class: 'projects-hint' }, [
        preview.excerpts.length
          ? `${preview.excerpts.length} of ${preview.pagesScanned} pages would be used (${preview.totalChars} characters, ${(preview as { companyTag?: string }).companyTag ?? ''}). In a review, the PR's own repo pages rank first.`
          : `No page matches yet (${preview.pagesScanned} pages scanned). Tag pages with the company tag, or pick tags above.`,
      ]),
      ...(items.length ? [h('ul', { class: 'projects-wiki-list' }, items)] : []),
      ...(preview.skipped?.length ? [h('p', { class: 'projects-hint' }, [`Skipped: ${preview.skipped.map((s) => `${s.slug} (${s.reason})`).join(', ')}`])] : []),
    ]);
  }

  return h('div', { class: 'projects-wiki' }, [
    h('span', { class: 'projects-field-label' }, ['Team knowledge (LLM Wiki)']),
    h('label', { class: 'projects-check-row', for: `wikiEnabled-${project.id}` }, [toggle, h('span', {}, ['Use my wiki in reviews of this project'])]),
    h('p', { class: 'projects-hint' }, ['Relevant pages are added to the review prompt as excerpts; the AI never gets the folder itself. Only this company’s pages are used: the repo’s own pages (project-<repo>) first, then the rest of the company. Pages that look like they contain a credential are skipped.']),
    h('label', { class: 'projects-field' }, [h('span', { class: 'projects-field-label' }, ['Wiki folder']), h('div', { class: 'projects-inline' }, [dir, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'pick-wiki-dir' }, ['Browse…'])])]),
    h('label', { class: 'projects-field' }, [
      h('span', { class: 'projects-field-label' }, ['Company tag']),
      company,
      h('span', { class: 'projects-hint' }, ['Groups wiki pages from all of this company’s repos and GitHub orgs.']),
    ]),
    picker,
    h('div', { class: 'projects-field' }, [
      h('span', { class: 'projects-field-label' }, ['Pages a review of this project would get']),
      h('div', {}, [previewBtn]),
    ]),
    result,
  ]);
}

function numberField(project: ProjectItem, key: 'probeRounds' | 'deviceMinutes', label: string, help: string): HTMLElement {
  const draft = reviewDrafts.get(project.id) ?? {};
  const limit = REVIEW_LIMITS[key];
  const input = h('input', {
    type: 'number',
    class: 'projects-text-input projects-number',
    min: String(limit.min),
    max: String(limit.max),
    step: '1',
    'data-role': key,
    'data-focus-key': key,
    'aria-label': label,
  }) as HTMLInputElement;
  input.value = String(draft[key] ?? project[key] ?? limit.default);
  return h('label', { class: 'projects-field projects-limit' }, [h('span', { class: 'projects-field-label' }, [label]), input, h('span', { class: 'projects-hint' }, [help])]);
}

/** Tabs with unsaved review-setting edits. All of them are saved together by one Save. */
function unsavedTabs(project: ProjectItem): ProjectTab[] {
  const d = reviewDrafts.get(project.id);
  if (!d) return [];
  const tabs: ProjectTab[] = [];
  if (d.models !== undefined || d.reviewInstructions !== undefined || d.incrementalReview !== undefined) tabs.push('review');
  if (d.wikiEnabled !== undefined || d.wikiDir !== undefined || d.wikiTags !== undefined || d.wikiCompanyTag !== undefined) tabs.push('knowledge');
  if (d.probeRounds !== undefined || d.deviceMinutes !== undefined) tabs.push('device');
  return tabs;
}

const TAB_LABELS: Record<ProjectTab, string> = { connections: 'Connections', review: 'AI review', knowledge: 'Team knowledge', device: 'Device testing' };

/** Bottom bar of the settings tabs, always visible: Save / Discard light up once something changed. */
function renderSaveBar(project: ProjectItem): HTMLElement {
  const unsaved = unsavedTabs(project);
  const status = reviewStatus.get(project.id) ?? '';
  const dirty = unsaved.length > 0;
  const text = dirty
    ? status && status !== 'Saved.'
      ? status
      : `Unsaved changes in ${unsaved.map((t) => TAB_LABELS[t]).join(', ')}`
    : status === 'Saved.'
      ? 'Changes saved.'
      : status || 'No unsaved changes. Edit any field, then save here.';
  const discard = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'discard-review' }, ['Discard']);
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'save-review' }, ['Save changes']);
  discard.toggleAttribute('disabled', !dirty);
  save.toggleAttribute('disabled', !dirty);
  return h('div', { class: `projects-savebar${dirty ? ' projects-savebar-dirty' : ''}`, role: 'region', 'aria-label': 'Save changes' }, [
    h('span', { class: 'projects-savebar-text', 'aria-live': 'polite' }, [
      ...(dirty ? [h('span', { class: 'projects-tab-dot', 'aria-hidden': 'true' }, [])] : status === 'Saved.' ? [h('span', { class: 'projects-savebar-ok', 'aria-hidden': 'true' }, ['✓'])] : []),
      text,
    ]),
    h('div', { class: 'projects-savebar-actions' }, [discard, save]),
  ]);
}

function renderReviewTab(project: ProjectItem): HTMLElement {
  const draft = reviewDrafts.get(project.id) ?? {};
  const cache = modelCache.get(project.id);
  if (project.tokens.cursor && !cache) void loadModels(project);
  const models = cache?.models ?? [];
  const chosen = { ...(project.models ?? {}), ...(draft.models ?? {}) };

  const modelCard = (slot: (typeof MODEL_SLOTS)[number]) => {
    const value = chosen[slot.id] ?? '';
    const known = models.some((m) => m.id === value);
    const select = h('select', { class: 'settings-select projects-model-select', 'data-slot': slot.id, 'aria-label': `${slot.label} model` }, [
      h('option', { value: '' }, [slot.id === 'builder' ? 'Same as fix writer' : 'Not set']),
      ...(value && !known ? [h('option', { value }, [`${value} (saved)`])] : []),
      ...models.map((m) => h('option', { value: m.id, ...(m.description ? { title: m.description } : {}) }, [m.label])),
    ]) as HTMLSelectElement;
    select.value = value;
    select.disabled = !project.tokens.cursor || !!cache?.loading;
    const recommended = recommendedModel(slot.id, models);
    const recommendedLabel = recommended ? models.find((m) => m.id === recommended)?.label ?? recommended : null;
    const note =
      slot.id === 'builder'
        ? 'Recommended: same as fix writer'
        : recommendedLabel
          ? value === recommended
            ? 'Recommended ✓'
            : `Recommended: ${recommendedLabel}`
          : '';
    return h('div', { class: 'projects-model-card' }, [
      h('div', { class: 'projects-model-title' }, [h('strong', {}, [slot.label]), h('span', { class: `projects-model-note${value === recommended && recommended ? ' projects-model-note-ok' : ''}` }, [note])]),
      h('span', { class: 'projects-hint projects-model-help' }, [slot.help]),
      select,
    ]);
  };
  const reviewSlots = MODEL_SLOTS.filter((slot) => slot.id !== 'fixer' && slot.id !== 'builder');
  const laterSlots = MODEL_SLOTS.filter((slot) => slot.id === 'fixer' || slot.id === 'builder');
  const useRecommended = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'use-recommended-models' }, ['Use recommended models']);
  useRecommended.toggleAttribute('disabled', !models.length);

  let modelNotice: HTMLElement | null = null;
  if (!project.tokens.cursor)
    modelNotice = h('div', { class: 'projects-callout' }, [
      h('p', {}, ['Add a Cursor API key to choose models.']),
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'select-project-tab', 'data-tab': 'connections' }, ['Go to Connections']),
    ]);
  else if (cache?.loading) modelNotice = h('p', { class: 'projects-hint' }, ['Loading models from Cursor…']);
  else if (cache?.error) {
    modelNotice = h('div', { class: 'projects-callout projects-callout-error', role: 'alert' }, [
      h('p', {}, [cache.error]),
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'reload-models' }, ['Try again']),
    ]);
  } else if (draft.suggested) modelNotice = h('p', { class: 'projects-hint' }, ['Recommended models are filled in. Change any of them, then Save changes.']);

  const instructions = draft.reviewInstructions ?? project.reviewInstructions ?? '';
  const textarea = h('textarea', {
    class: 'projects-textarea',
    rows: '9',
    maxlength: String(REVIEW_INSTRUCTIONS_MAX),
    spellcheck: 'false',
    'data-role': 'review-instructions',
    'data-focus-key': 'review-instructions',
    'aria-label': 'Review instructions',
    placeholder: 'e.g.\nCOMMENT STYLE\n- Pointed, specific, file:line when possible.\n- Prefer one concrete ask over a laundry list.\n- When device logs prove a race, include a short trimmed log excerpt.',
  }) as HTMLTextAreaElement;
  textarea.value = instructions;

  const incremental = h('input', { type: 'checkbox', class: 'projects-checkbox', 'data-role': 'incremental-review', id: `incrementalReview-${project.id}` }) as HTMLInputElement;
  incremental.checked = draft.incrementalReview ?? project.incrementalReview ?? true;

  return h('div', { class: 'projects-tabpanel', role: 'tabpanel' }, [
    h('section', { class: 'projects-group' }, [
      h('div', { class: 'projects-group-head' }, [
        h('div', {}, [h('h4', { class: 'projects-group-title' }, ['Models']), h('p', { class: 'projects-hint' }, ['Three reviewers read the PR in parallel, one lens each. The judge keeps what the code proves and sends the rest to a device check.'])]),
        useRecommended,
      ]),
      ...(modelNotice ? [modelNotice] : []),
      h('div', { class: 'projects-model-grid' }, reviewSlots.map(modelCard)),
      h('details', { class: 'projects-later' }, [
        h('summary', {}, ['Later phases: fix writer and builder']),
        h('div', { class: 'projects-model-grid' }, laterSlots.map(modelCard)),
      ]),
    ]),
    h('section', { class: 'projects-group' }, [
      h('div', { class: 'projects-group-head' }, [
        h('div', {}, [h('h4', { class: 'projects-group-title' }, ['Review instructions']), h('p', { class: 'projects-hint' }, ['Comment style and team rules, added to every review of this project. Never credentials.'])]),
      ]),
      textarea,
      h('span', { class: 'projects-hint projects-counter', 'data-role': 'instructions-counter' }, [`Added to every review of this project. Rules only, never credentials. ${instructions.length}/${REVIEW_INSTRUCTIONS_MAX}`]),
    ]),
    h('section', { class: 'projects-group' }, [
      h('label', { class: 'projects-check-row', for: `incrementalReview-${project.id}` }, [incremental, h('span', {}, ['Re-review only what changed'])]),
      h('p', { class: 'projects-hint' }, ['After new commits, only those commits are reviewed and still-open findings carry over. Re-reviewing with no new commits always reviews the whole PR.']),
    ]),
    renderDismissals(project),
    renderSaveBar(project),
  ]);
}

function renderKnowledgeTab(project: ProjectItem): HTMLElement {
  return h('div', { class: 'projects-tabpanel', role: 'tabpanel' }, [renderWikiBlock(project), renderSaveBar(project)]);
}

function renderDeviceTab(project: ProjectItem): HTMLElement {
  return h('div', { class: 'projects-tabpanel', role: 'tabpanel' }, [
    renderBuildSection(project),
    h('section', { class: 'projects-group' }, [
      h('div', { class: 'projects-group-head' }, [
        h('div', {}, [h('h4', { class: 'projects-group-title' }, ['Limits']), h('p', { class: 'projects-hint' }, ['How long a device check may hold a test device. Test devices are chosen in PR Reviews → Test devices. Saved with the bar below.'])]),
      ]),
      h('div', { class: 'projects-limits' }, [
        numberField(project, 'deviceMinutes', 'Device time per review (minutes)', 'Test build, run and result; then the device goes to the next review.'),
      ]),
    ]),
    renderSaveBar(project),
  ]);
}

/** Setup checklist: what this project still needs before reviews (and device checks) work. */
function setupSteps(project: ProjectItem): { label: string; done: boolean; tab: ProjectTab; optional?: boolean }[] {
  const m = project.models ?? {};
  const repos = project.repos ?? [];
  const approved = repos.filter((r) => project.builds?.[r]?.approvedAt && project.builds?.[r]?.testCommand).length;
  return [
    { label: 'GitHub token', done: project.tokens.github, tab: 'connections' },
    { label: 'Cursor API key', done: !!project.tokens.cursor, tab: 'connections' },
    { label: 'Review models', done: !!m.judge && !!(m.reviewer1 || m.reviewer2 || m.reviewer3), tab: 'review' },
    { label: repos.length ? `Test builds ${approved}/${repos.length}` : 'Test builds', done: repos.length > 0 && approved === repos.length, tab: 'device', optional: true },
  ];
}

/** After an edit: update the save bar and tab dots in place (a full render would steal focus mid-typing). */
function refreshUnsavedUi(project: ProjectItem): void {
  const root = document.getElementById('projectsRoot');
  const bar = root?.querySelector('.projects-savebar');
  if (bar) bar.replaceWith(renderSaveBar(project));
  const unsaved = unsavedTabs(project);
  root?.querySelectorAll<HTMLElement>('.projects-tab').forEach((tab) => {
    const t = tab.getAttribute('data-tab') as ProjectTab;
    const dot = tab.querySelector('.projects-tab-dot');
    if (unsaved.includes(t) && !dot) {
      tab.querySelector('.projects-tab-warn')?.remove();
      tab.append(h('span', { class: 'projects-tab-dot', title: 'Unsaved changes' }, []));
    } else if (!unsaved.includes(t)) dot?.remove();
  });
}

function defaultTab(project: ProjectItem): ProjectTab {
  return setupSteps(project).find((s) => !s.done && !s.optional)?.tab ?? 'review';
}

function renderDetail(project: ProjectItem, editing: boolean): HTMLElement {
  if (editing) {
    return h('section', { class: 'projects-detail' }, [renderEditForm(project)]);
  }
  const tab = projectTabs.get(project.id) ?? defaultTab(project);
  const steps = setupSteps(project);
  const ready = steps.every((s) => s.done || s.optional);
  const unsaved = unsavedTabs(project);
  const repoCount = project.repos?.length ?? 0;

  const checklist = h('div', { class: `projects-setup${ready ? ' projects-setup-ready' : ''}` }, [
    h('span', { class: 'projects-setup-title' }, [ready ? 'Ready for reviews' : 'Finish setup']),
    h(
      'div',
      { class: 'projects-setup-steps' },
      steps.map((step) =>
        h('button', { type: 'button', class: `projects-step${step.done ? ' projects-step-done' : ''}`, 'data-action': 'select-project-tab', 'data-tab': step.tab, title: step.done ? 'Done' : step.optional ? 'Optional: needed for device checks' : 'Needed for reviews' }, [
          h('span', { class: 'projects-step-mark', 'aria-hidden': 'true' }, [step.done ? '✓' : step.optional ? '○' : '!']),
          step.label,
          ...(step.optional && !step.done ? [h('span', { class: 'projects-step-optional' }, ['optional'])] : []),
        ])
      )
    ),
  ]);

  const tabs: ProjectTab[] = ['connections', 'review', 'knowledge', 'device'];
  const tabBar = h(
    'div',
    { class: 'projects-tabs', role: 'tablist', 'aria-label': 'Project settings' },
    tabs.map((t) => {
      const warn = steps.some((s) => s.tab === t && !s.done && !s.optional);
      return h('button', { type: 'button', role: 'tab', class: `projects-tab${t === tab ? ' active' : ''}`, 'aria-selected': String(t === tab), 'data-action': 'select-project-tab', 'data-tab': t }, [
        TAB_LABELS[t],
        ...(unsaved.includes(t) ? [h('span', { class: 'projects-tab-dot', title: 'Unsaved changes' }, [])] : warn ? [h('span', { class: 'projects-tab-warn', title: 'Needs setup' }, ['!'])] : []),
      ]);
    })
  );

  const panel =
    tab === 'connections'
      ? h('div', { class: 'projects-tabpanel', role: 'tabpanel' }, [
          h('section', { class: 'projects-group' }, [
            h('div', { class: 'projects-group-head' }, [
              h('div', {}, [h('h4', { class: 'projects-group-title' }, ['Required']), h('p', { class: 'projects-hint' }, ['Encrypted with the OS keychain, never shown again. GitHub decides which repos you can review; Cursor runs the AI reviews.'])]),
            ]),
            h('div', { class: 'projects-token-list' }, REQUIRED_SERVICES.map((s) => renderTokenRow(project, s))),
          ]),
          h('section', { class: 'projects-group' }, [
            h('div', { class: 'projects-group-head' }, [
              h('div', {}, [h('h4', { class: 'projects-group-title' }, ['Optional']), h('p', { class: 'projects-hint' }, ['Ticket and design context for reviews.'])]),
            ]),
            h('div', { class: 'projects-token-list' }, OPTIONAL_SERVICES.map((s) => renderTokenRow(project, s))),
          ]),
          h('section', { class: 'projects-danger' }, [
            h('div', {}, [h('strong', {}, ['Remove project']), h('p', { class: 'projects-hint' }, ['Deletes its tokens, secrets and settings from this machine.'])]),
            h('button', { type: 'button', class: 'btn btn-danger btn-sm', 'data-action': 'remove-project' }, ['Remove project']),
          ]),
        ])
      : tab === 'review'
        ? renderReviewTab(project)
        : tab === 'knowledge'
          ? renderKnowledgeTab(project)
          : renderDeviceTab(project);

  return h('section', { class: 'projects-detail' }, [
    h('header', { class: 'projects-detail-head projects-detail-title' }, [
      h('div', {}, [h('h3', {}, [displayName(project)]), h('span', { class: 'projects-hint' }, [`${repoCount} ${repoCount === 1 ? 'repo' : 'repos'} chosen in PR Reviews`])]),
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'open-edit' }, ['Rename']),
    ]),
    checklist,
    tabBar,
    panel,
  ]);
}

function renderList(): HTMLElement {
  return h(
    'ul',
    { class: 'projects-list', role: 'listbox', 'aria-label': 'Projects' },
    projects.map((project) => {
      const isSelected = project.id === selectedId;
      return h('li', {}, [
        h(
          'button',
          {
            type: 'button',
            class: isSelected ? 'projects-list-item active' : 'projects-list-item',
            role: 'option',
            'aria-selected': String(isSelected),
            'data-action': 'select-project',
            'data-id': project.id,
          },
          [h('span', { class: 'projects-dot projects-dot-ok', 'aria-hidden': 'true' }, []), h('span', { class: 'projects-list-name' }, [displayName(project)])]
        ),
      ]);
    })
  );
}

function render(): void {
  const root = document.getElementById('projectsRoot');
  if (!root) return;
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusKey = active?.getAttribute?.('data-focus-key') ?? null;
  const selection = focusKey && active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  try {
    renderInto(root);
  } finally {
    if (focusKey) {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-focus-key="${focusKey}"]`);
      el?.focus();
      if (el && selection && selection[0] !== null && el.type !== 'number') el.setSelectionRange(selection[0], selection[1]);
    }
  }
}

function renderInto(root: HTMLElement): void {
  const adding = root.dataset.adding === 'true';

  const topBar = h('div', { class: 'projects-topbar' }, [
    h('strong', {}, ['Projects']),
    h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'open-add' }, ['Add project']),
  ]);
  const children: Node[] = [topBar];

  if (!tokenStorageAvailable) {
    children.push(
      h('div', { class: 'projects-callout projects-callout-error', role: 'alert' }, [
        h('p', {}, ['The OS keychain is unavailable, so tokens cannot be saved on this machine.']),
      ])
    );
  }
  if (pageError) {
    children.push(h('div', { class: 'projects-callout projects-callout-error', role: 'alert' }, [pageError]));
  }

  if (adding) {
    children.push(renderAddForm());
  } else if (projects.length === 0) {
    children.push(h('p', { class: 'projects-empty' }, ['No projects yet. Add one for each company or team whose PRs you review.']));
  } else {
    const project = selected();
    const editing = project !== undefined && root.dataset.editing === project.id;
    children.push(h('div', { class: 'projects-layout' }, [renderList(), project ? renderDetail(project, editing) : h('div', {}, [])]));
  }

  root.replaceChildren(...children);
}

/** Save one row: its non-secret fields and, if typed, its token. */
async function saveRow(project: ProjectItem, service: ProjectTokenService, row: HTMLElement, status: HTMLElement): Promise<void> {
  const settings: Record<string, string> = { id: project.id };
  for (const field of EXTRA_FIELDS[service] ?? []) {
    const value = (row.querySelector(`input[name="${field.name}"]`) as HTMLInputElement | null)?.value.trim() ?? '';
    if (value) settings[field.name] = value;
  }
  if (Object.keys(settings).length > 1) {
    const res = await api.projectsSetSettings(settings);
    if (!res?.success) {
      status.textContent = res?.error || 'Could not save settings.';
      return;
    }
  }
  const input = row.querySelector<HTMLInputElement>('input[data-service]');
  const value = input?.value ?? '';
  if (value.trim()) {
    const res = await api.projectsSetToken(project.id, service, value);
    // Clear the field whatever happened, so the secret does not stay in the DOM.
    if (input) input.value = '';
    if (!res?.success) {
      status.textContent = res?.error || 'Could not save token.';
      return;
    }
  }
  await refresh();
}

async function testService(project: ProjectItem, service: ProjectTokenService, status: HTMLElement): Promise<void> {
  status.textContent = 'Testing…';
  const res = await api.projectsTest(project.id, service);
  status.textContent = res?.success ? res.detail : res?.error || 'Test failed.';
}

async function clearToken(project: ProjectItem, service: ProjectTokenService): Promise<void> {
  const res = await api.projectsClearToken(project.id, service);
  if (!res?.success) pageError = res?.error || 'Could not clear token.';
  await refresh();
}

function wireEvents(): void {
  const root = document.getElementById('projectsRoot');
  if (!root) return;

  root.addEventListener('submit', (event) => {
    const form = event.target as HTMLElement;
    const role = form.getAttribute('data-role');
    if (role !== 'add-form' && role !== 'edit-form') return;
    event.preventDefault();
    if (role === 'add-form') void addProject(form);
    else if (selected()) void updateProject(selected()!, form);
  });

  root.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    const slot = target.getAttribute('data-slot') as ModelSlotId | null;
    const role = target.getAttribute('data-role');
    const project = selected();
    if (!project) return;
    if (role === 'build-root' && target.tagName === 'SELECT') {
      void detectBuildFor(project, target.getAttribute('data-repo') ?? '', target.value);
      return;
    }
    if (role === 'build-test-option') {
      const repo = target.getAttribute('data-repo') ?? '';
      const o = buildDraft(project, repo).testOptions?.[Number(target.value)];
      if (o) patchBuildDraft(project, repo, { testCommand: o.command, testOutDir: o.outDir, status: '', error: '' });
      render();
      return;
    }
    if (role === 'incremental-review') {
      reviewDrafts.set(project.id, { ...(reviewDrafts.get(project.id) ?? {}), incrementalReview: (target as unknown as HTMLInputElement).checked });
      reviewStatus.delete(project.id);
      render();
      return;
    }
    if (role === 'wiki-enabled') {
      reviewDrafts.set(project.id, { ...(reviewDrafts.get(project.id) ?? {}), wikiEnabled: (target as unknown as HTMLInputElement).checked });
      reviewStatus.delete(project.id);
      render();
      return;
    }
    if (role === 'wiki-company') {
      reviewDrafts.set(project.id, { ...(reviewDrafts.get(project.id) ?? {}), wikiCompanyTag: target.value });
      reviewStatus.delete(project.id);
      render();
      return;
    }
    if (!slot) return;
    const draft = reviewDrafts.get(project.id) ?? {};
    reviewDrafts.set(project.id, { ...draft, models: { ...(project.models ?? {}), ...(draft.models ?? {}), [slot]: target.value } });
    reviewStatus.delete(project.id);
    refreshUnsavedUi(project);
  });

  root.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    const role = target.getAttribute('data-role');
    const project = selected();
    if (!project || !role) return;
    const draft = reviewDrafts.get(project.id) ?? {};
    if (role === 'review-instructions') {
      reviewDrafts.set(project.id, { ...draft, reviewInstructions: target.value });
      const counter = root.querySelector('[data-role="instructions-counter"]');
      if (counter) counter.textContent = `Added to every review of this project. Rules only, never credentials. ${target.value.length}/${REVIEW_INSTRUCTIONS_MAX}`;
    } else if (role === 'probeRounds' || role === 'deviceMinutes') {
      reviewDrafts.set(project.id, { ...draft, [role]: target.value });
    } else if (role === 'wiki-dir') {
      reviewDrafts.set(project.id, { ...draft, wikiDir: target.value });
    } else if (role === 'wiki-tags') {
      reviewDrafts.set(project.id, { ...draft, wikiTags: target.value });
    } else if (role === 'build-command' || role === 'build-outdir' || role === 'build-install' || role === 'build-test-command' || role === 'build-test-outdir' || role === 'env-text' || (role === 'build-root' && target.tagName === 'INPUT')) {
      const repo = target.getAttribute('data-repo') ?? '';
      const fields: Record<string, keyof BuildDraft> = { 'build-root': 'rootDir', 'build-command': 'command', 'build-outdir': 'outDir', 'build-install': 'install', 'build-test-command': 'testCommand', 'build-test-outdir': 'testOutDir', 'env-text': 'envText' };
      const field = fields[role];
      patchBuildDraft(project, repo, { [field]: target.value, status: '', error: '' });
      return;
    } else if (role === 'wiki-tag-search') {
      wikiTagSearch.set(project.id, target.value);
      render();
      return;
    } else {
      return;
    }
    reviewStatus.delete(project.id);
    refreshUnsavedUi(project);
  });

  root.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>('[data-external]');
    if (link) {
      event.preventDefault();
      void api.openExternal(link.getAttribute('data-external'));
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.getAttribute('data-action');
    const project = selected();
    const service = target.getAttribute('data-service') as ProjectTokenService | null;

    if (action === 'open-add') {
      root.dataset.adding = 'true';
      pageError = '';
      render();
      focusAddInput();
    } else if (action === 'open-edit' && project) {
      root.dataset.editing = project.id;
      pageError = '';
      render();
    } else if (action === 'cancel-edit') {
      root.dataset.editing = '';
      render();
    } else if (action === 'cancel-add') {
      root.dataset.adding = 'false';
      addDraft = '';
      pageError = '';
      render();
    } else if (action === 'select-project') {
      selectedId = target.getAttribute('data-id');
      pageError = '';
      render();
    } else if (action === 'remove-project' && project) {
      void removeSelected(project);
    } else if (action === 'clear-token' && project && service) {
      void clearToken(project, service);
    } else if (action === 'save-token' && project && service) {
      const row = target.closest<HTMLElement>('.projects-token-row');
      const status = row?.querySelector<HTMLElement>('.projects-token-status');
      if (row && status)
        void saveRow(project, service, row, status).then(() => {
          // Close the row once the token is saved; keep it open (with the error) otherwise.
          if (selected()?.tokens[service]) {
            openTokenRows.delete(`${project.id}:${service}`);
            render();
          }
        });
    } else if (action === 'toggle-token-row' && project && service) {
      const key = `${project.id}:${service}`;
      if (openTokenRows.has(key)) openTokenRows.delete(key);
      else openTokenRows.add(key);
      render();
      if (openTokenRows.has(key)) root.querySelector<HTMLInputElement>(`.projects-token-row[data-service="${service}"] input[data-service]`)?.focus();
    } else if (action === 'select-build-repo' && project) {
      selectedBuildRepo.set(project.id, target.getAttribute('data-repo') ?? '');
      render();
    } else if (action === 'select-project-tab' && project) {
      projectTabs.set(project.id, (target.getAttribute('data-tab') as ProjectTab) ?? 'connections');
      render();
    } else if (action === 'discard-review' && project) {
      reviewDrafts.delete(project.id);
      reviewStatus.delete(project.id);
      render();
    } else if (action === 'forget-dismissal' && project) {
      void api.reviewsForgetDismissal(target.getAttribute('data-repo') ?? '', target.getAttribute('data-id') ?? '').then(() => loadDismissals(project));
    } else if (action === 'detect-build' && project) {
      void detectBuildFor(project, target.getAttribute('data-repo') ?? '');
    } else if (action === 'approve-build' && project) {
      void approveBuild(project, target.getAttribute('data-repo') ?? '');
    } else if (action === 'save-env' && project) {
      void saveBuildEnv(project, target.getAttribute('data-repo') ?? '');
    } else if (action === 'clear-env' && project) {
      void clearBuildEnv(project, target.getAttribute('data-repo') ?? '');
    } else if (action === 'toggle-wiki-tag' && project) {
      toggleWikiTag(project, target.getAttribute('data-tag') ?? '');
    } else if (action === 'reload-wiki-tags' && project) {
      const dir = wikiValues(project).wikiDir;
      wikiTagCache.delete(dir);
      void loadWikiTags(dir);
    } else if (action === 'wiki-preview' && project) {
      void previewWiki(project);
    } else if (action === 'pick-wiki-dir' && project) {
      void (async () => {
        const res = await api.pickFolder();
        if (!res?.success || !res.folderPath) return;
        reviewDrafts.set(project.id, { ...(reviewDrafts.get(project.id) ?? {}), wikiDir: res.folderPath });
        reviewStatus.delete(project.id);
        render();
      })();
    } else if (action === 'use-recommended-models' && project) {
      const models = modelCache.get(project.id)?.models ?? [];
      reviewDrafts.set(project.id, { ...(reviewDrafts.get(project.id) ?? {}), models: suggestModels(models), suggested: true });
      reviewStatus.delete(project.id);
      render();
    } else if (action === 'save-review' && project) {
      void saveReview(project);
    } else if (action === 'reload-models' && project) {
      modelCache.delete(project.id);
      void loadModels(project);
    } else if (action === 'test-service' && project && service) {
      const status = target.closest('.projects-token-row')?.querySelector<HTMLElement>('.projects-token-status');
      if (status) void testService(project, service, status);
    }
  });
}

export function initProjectSection(): void {
  const root = document.getElementById('projectsRoot');
  if (!root || !api?.projectsList) return;
  wireEvents();
  // Reload each time the tab opens.
  document.getElementById('nav-projects')?.addEventListener('click', () => void refresh());
  void refresh();
}
