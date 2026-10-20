/**
 * Settings → Projects and the PR Reviews panel: the project registry and per-project tokens.
 *
 * Repo discovery: the GitHub token's own repos plus the repos of every org it
 * belongs to, merged into one list. Orgs the token cannot read are reported, not hidden.
 *
 * The registry lives at `<userData>/projects.json`. Tokens go to `project-token-store`.
 * Only booleans and repo names come back over IPC. Tokens never do.
 */

import type { App, IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/ipc/channels';
import {
  PROJECT_TOKEN_SERVICES,
  parseFigmaTestUrl,
  parseJiraEmail,
  parseJiraSite,
  parseProjectInput,
  parseRepoList,
  parseReviewSettings,
  parseWikiSettings,
  parseBuildConfig,
  parseEnvBulk,
  containsSecret,
  defaultCompanyTag,
  projectIdFor,
  type ProjectRecord,
  type ProjectTokenService,
} from '../../shared/project-config';
import type { ChecksState, PullRequestItem, ReviewDecision } from '../../shared/pr-list';
import { detectBuild, projectFolders, listCursorModels, listWikiTags, readWiki, selectWikiContext } from 'roku-dev-studio-review';
import * as tokenStore from '../project-token-store';

const fs = require('fs');
const path = require('path');

const REGISTRY_FILE = 'projects.json';
const REGISTRY_VERSION = 1;

export interface ProjectListItem extends ProjectRecord {
  tokens: Record<ProjectTokenService, boolean>;
}

let registryPath: string | null = null;

function readRegistry(): ProjectRecord[] {
  if (!registryPath || !fs.existsSync(registryPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as { projects?: Partial<ProjectRecord>[] };
    if (!Array.isArray(parsed.projects)) return [];
    // Projects saved before multi-org support have only `org`; it becomes the name.
    return parsed.projects
      .filter((p) => p && typeof p.id === 'string' && (typeof p.name === 'string' || typeof p.org === 'string'))
      .map((p) => ({ ...p, name: p.name || p.org || p.id }) as ProjectRecord);
  } catch {
    return [];
  }
}

function writeRegistry(projects: ProjectRecord[]): void {
  if (!registryPath) throw new Error('project registry not initialized');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ version: REGISTRY_VERSION, projects }, null, 2), 'utf-8');
}

function toListItem(project: ProjectRecord): ProjectListItem {
  const tokens = {} as Record<ProjectTokenService, boolean>;
  for (const service of PROJECT_TOKEN_SERVICES) tokens[service] = tokenStore.hasToken(project.id, service);
  return { ...project, tokens };
}

/** For other main-process modules (the review service). */
export function getProjectRecord(id: string): ProjectRecord | undefined {
  return findProject(id);
}

export { resolveHomePath };

function findProject(id: unknown): ProjectRecord | undefined {
  if (typeof id !== 'string') return undefined;
  return readRegistry().find((p) => p.id === id);
}

function isTokenService(value: unknown): value is ProjectTokenService {
  return typeof value === 'string' && (PROJECT_TOKEN_SERVICES as readonly string[]).includes(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function githubErrorMessage(status: number): string {
  if (status === 401) return 'GitHub rejected the token.';
  if (status === 403) return 'GitHub refused the request (missing scope or rate limit).';
  return `GitHub returned HTTP ${status}.`;
}

function githubGet(token: string, pathAndQuery: string): Promise<Response> {
  // The token is only used in this header. It is not logged and not returned.
  return fetch(`https://api.github.com${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
}

const SCAN_PAGE_SIZE = 100;
/** Per owner. 10 pages = 1000 repos, after which the owner is marked truncated. */
const SCAN_MAX_PAGES = 10;

class GitHubStatusError extends Error {
  constructor(readonly status: number, readonly ssoRequired: boolean) {
    super(githubErrorMessage(status));
  }
}

/** All pages of a repo listing. Archived and disabled repos are dropped: they take no new PRs. */
async function listRepoPages(token: string, basePath: string): Promise<{ names: string[]; truncated: boolean }> {
  const names: string[] = [];
  for (let page = 1; page <= SCAN_MAX_PAGES; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const res = await githubGet(token, `${basePath}${sep}per_page=${SCAN_PAGE_SIZE}&page=${page}`);
    if (!res.ok) throw new GitHubStatusError(res.status, Boolean(res.headers.get('x-github-sso')));
    const batch = (await res.json()) as { full_name?: unknown; archived?: unknown; disabled?: unknown }[];
    for (const repo of batch) {
      if (typeof repo.full_name === 'string' && !repo.archived && !repo.disabled) names.push(repo.full_name);
    }
    if (batch.length < SCAN_PAGE_SIZE) return { names, truncated: false };
  }
  return { names, truncated: true };
}

export interface RepoScan {
  login: string;
  orgs: string[];
  skipped: { org: string; reason: string }[];
  repos: string[];
  truncated: boolean;
}

/** Discovery: the account's own repos plus every org it belongs to. */
async function scanAccessibleRepos(token: string): Promise<RepoScan> {
  const userRes = await githubGet(token, '/user');
  if (!userRes.ok) throw new GitHubStatusError(userRes.status, false);
  const login = String(((await userRes.json()) as { login?: unknown }).login ?? '');

  const orgsRes = await githubGet(token, '/user/orgs?per_page=100');
  if (!orgsRes.ok) throw new GitHubStatusError(orgsRes.status, false);
  const orgs = ((await orgsRes.json()) as { login?: unknown }[]).map((o) => String(o.login ?? '')).filter(Boolean);

  const owners = [{ owner: login, path: '/user/repos?affiliation=owner&sort=full_name' }, ...orgs.map((org) => ({ owner: org, path: `/orgs/${encodeURIComponent(org)}/repos?sort=full_name` }))];
  const results = await Promise.allSettled(owners.map((o) => listRepoPages(token, o.path)));

  const repos = new Set<string>();
  const skipped: RepoScan['skipped'] = [];
  const scannedOrgs: string[] = [];
  let truncated = false;
  results.forEach((result, i) => {
    const { owner } = owners[i];
    if (result.status === 'fulfilled') {
      result.value.names.forEach((name) => repos.add(name));
      truncated ||= result.value.truncated;
      if (i > 0) scannedOrgs.push(owner);
    } else {
      const err = result.reason;
      const reason = err instanceof GitHubStatusError ? (err.ssoRequired ? 'SSO not authorized for this token' : err.message) : errorMessage(err);
      skipped.push({ org: owner, reason });
    }
  });
  return { login, orgs: scannedOrgs, skipped, repos: [...repos].sort((a, b) => a.localeCompare(b)), truncated };
}

/** Repos per GraphQL request. Each repo adds a block of up to PR_PAGE_SIZE PRs to one query. */
const PR_REPOS_PER_QUERY = 15;
const PR_PAGE_SIZE = 50;

const PR_FIELDS = `
  number title url isDraft headRefName headRefOid baseRefName additions deletions updatedAt mergeable reviewDecision
  author { login }
  labels(first: 10) { nodes { name color } }
  reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

interface RawPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  updatedAt: string;
  mergeable: string;
  reviewDecision: string | null;
  author: { login: string } | null;
  labels?: { nodes: { name: string; color: string }[] };
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string } | null }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface PrScan {
  viewer: string;
  pullRequests: PullRequestItem[];
  failed: { repo: string; reason: string }[];
  /** Repos with more open PRs than PR_PAGE_SIZE; only the most recently updated are listed. */
  truncatedRepos: string[];
}

function toChecks(state: string | undefined): ChecksState {
  if (state === 'SUCCESS') return 'success';
  if (state === 'FAILURE' || state === 'ERROR') return 'failure';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  return 'none';
}

function toDecision(value: string | null): ReviewDecision {
  if (value === 'APPROVED') return 'approved';
  if (value === 'CHANGES_REQUESTED') return 'changes_requested';
  if (value === 'REVIEW_REQUIRED') return 'review_required';
  return 'none';
}

async function githubGraphql(token: string, query: string, variables: Record<string, string>): Promise<{ data?: Record<string, any>; errors?: { path?: string[]; type?: string; message?: string }[] }> {
  // The token is only used in this header. It is not logged and not returned.
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new GitHubStatusError(res.status, Boolean(res.headers.get('x-github-sso')));
  return (await res.json()) as { data?: Record<string, any>; errors?: { path?: string[]; type?: string; message?: string }[] };
}

async function scanPullRequests(token: string, repos: string[]): Promise<PrScan> {
  const chunks: string[][] = [];
  for (let i = 0; i < repos.length; i += PR_REPOS_PER_QUERY) chunks.push(repos.slice(i, i + PR_REPOS_PER_QUERY));

  const scan: PrScan = { viewer: '', pullRequests: [], failed: [], truncatedRepos: [] };
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      // Owner and name go in as variables, never into the query text.
      const variables: Record<string, string> = {};
      const declarations: string[] = [];
      const blocks = chunk.map((repo, i) => {
        const [owner, name] = repo.split('/');
        variables[`o${i}`] = owner;
        variables[`n${i}`] = name;
        declarations.push(`$o${i}: String!`, `$n${i}: String!`);
        return `r${i}: repository(owner: $o${i}, name: $n${i}) { nameWithOwner pullRequests(states: OPEN, first: ${PR_PAGE_SIZE}, orderBy: {field: UPDATED_AT, direction: DESC}) { totalCount nodes { ${PR_FIELDS} } } }`;
      });
      const query = `query(${declarations.join(', ')}) { viewer { login } ${blocks.join('\n')} }`;
      return { chunk, response: await githubGraphql(token, query, variables) };
    })
  );

  for (const { chunk, response } of results) {
    scan.viewer ||= String(response.data?.viewer?.login ?? '');
    chunk.forEach((repo, i) => {
      const block = response.data?.[`r${i}`] as { pullRequests: { totalCount: number; nodes: RawPr[] } } | null | undefined;
      if (!block) {
        const error = response.errors?.find((e) => e.path?.[0] === `r${i}`);
        scan.failed.push({ repo, reason: error?.type === 'NOT_FOUND' ? 'not found or no access' : error?.message || 'could not be read' });
        return;
      }
      if (block.pullRequests.totalCount > block.pullRequests.nodes.length) scan.truncatedRepos.push(repo);
      for (const pr of block.pullRequests.nodes) {
        const requested = pr.reviewRequests.nodes.some((n) => n.requestedReviewer?.__typename === 'User' && n.requestedReviewer.login?.toLowerCase() === scan.viewer.toLowerCase());
        scan.pullRequests.push({
          repo,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          author: pr.author?.login ?? 'ghost',
          draft: pr.isDraft,
          head: pr.headRefName,
          base: pr.baseRefName,
          additions: pr.additions,
          deletions: pr.deletions,
          updatedAt: pr.updatedAt,
          conflicts: pr.mergeable === 'CONFLICTING',
          checks: toChecks(pr.commits.nodes[0]?.commit.statusCheckRollup?.state),
          decision: toDecision(pr.reviewDecision),
          reviewRequested: requested,
          headSha: pr.headRefOid,
          labels: (pr.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color })),
        });
      }
    });
  }
  scan.pullRequests.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return scan;
}

/** "~/wiki" → "/Users/me/wiki". Other paths are returned as given. */
function resolveHomePath(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(require('os').homedir(), p.slice(2)) : p;
}

function setupProjectHandlers(app: App): void {
  const { ipcMain } = require('electron') as typeof import('electron');
  registryPath = path.join(app.getPath('userData'), REGISTRY_FILE);
  tokenStore.init(app);

  ipcMain.handle(IPC.ProjectsList, async () => ({
    success: true,
    projects: readRegistry().map(toListItem),
    tokenStorageAvailable: tokenStore.isEncryptionAvailable(),
  }));

  ipcMain.handle(IPC.ProjectsAdd, async (_event: IpcMainInvokeEvent, payload?: unknown) => {
    const parsed = parseProjectInput(payload);
    if (!parsed.ok) return { success: false, error: parsed.error };
    const projects = readRegistry();
    const id = projectIdFor(parsed.name);
    if (projects.some((p) => p.id === id || p.name.toLowerCase() === parsed.name.toLowerCase())) {
      return { success: false, error: 'A project with that name already exists.' };
    }
    const record: ProjectRecord = { id, name: parsed.name };
    try {
      writeRegistry([...projects, record]);
      return { success: true, project: toListItem(record) };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsUpdate, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; name?: unknown }) => {
    const projects = readRegistry();
    const current = projects.find((p) => p.id === payload?.id);
    if (!current) return { success: false, error: 'Project not found.' };
    const parsed = parseProjectInput({ name: payload?.name });
    if (!parsed.ok) return { success: false, error: parsed.error };
    if (projects.some((p) => p.id !== current.id && p.name.toLowerCase() === parsed.name.toLowerCase())) {
      return { success: false, error: 'A project with that name already exists.' };
    }
    // The id (and so the saved tokens and repos) stays the same when the name changes.
    const next: ProjectRecord = { ...current, name: parsed.name };
    try {
      writeRegistry(projects.map((p) => (p.id === current.id ? next : p)));
      return { success: true, project: toListItem(next) };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsRemove, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown }) => {
    const project = findProject(payload?.id);
    if (!project) return { success: false, error: 'Project not found.' };
    try {
      writeRegistry(readRegistry().filter((p) => p.id !== project.id));
      tokenStore.clearProject(project.id, PROJECT_TOKEN_SERVICES);
      return { success: true };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsScanRepos, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown }) => {
    const project = findProject(payload?.id);
    if (!project) return { success: false, error: 'Project not found.' };
    const token = tokenStore.getToken(project.id, 'github');
    if (!token) return { success: false, error: 'Save a GitHub token in Projects first.' };
    try {
      return { success: true, ...(await scanAccessibleRepos(token)) };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsListPrs, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown }) => {
    const project = findProject(payload?.id);
    if (!project) return { success: false, error: 'Project not found.' };
    const repos = project.repos ?? [];
    if (repos.length === 0) return { success: true, viewer: '', pullRequests: [], failed: [], truncatedRepos: [], fetchedAt: Date.now() };
    const token = tokenStore.getToken(project.id, 'github');
    if (!token) return { success: false, error: 'Save a GitHub token in Projects first.' };
    try {
      return { success: true, ...(await scanPullRequests(token, repos)), fetchedAt: Date.now() };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsSetRepos, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; repos?: unknown }) => {
    const projects = readRegistry();
    const project = projects.find((p) => p.id === payload?.id);
    if (!project) return { success: false, error: 'Project not found.' };
    const parsed = parseRepoList(payload?.repos);
    if (!parsed.ok) return { success: false, error: parsed.error };
    const next: ProjectRecord = { ...project, repos: parsed.repos };
    try {
      writeRegistry(projects.map((p) => (p.id === project.id ? next : p)));
      return { success: true, project: toListItem(next) };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsSetReview, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown } & Record<string, unknown>) => {
    const projects = readRegistry();
    const project = projects.find((p) => p.id === payload?.id);
    if (!project) return { success: false, error: 'Project not found.' };
    const parsed = parseReviewSettings(payload);
    if (!parsed.ok) return { success: false, error: parsed.error };
    const next: ProjectRecord = { ...project, ...parsed.settings };
    try {
      writeRegistry(projects.map((p) => (p.id === project.id ? next : p)));
      return { success: true, project: toListItem(next) };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsWikiPreview, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; repo?: unknown } & Record<string, unknown>) => {
    const project = findProject(payload?.id);
    if (!project) return { success: false, error: 'Project not found.' };
    const wiki = parseWikiSettings(payload ?? {});
    if (!wiki.ok) return { success: false, error: wiki.error };
    if (!wiki.wikiEnabled) return { success: false, error: 'The wiki is turned off for this project.' };
    const repo = typeof payload?.repo === 'string' ? payload.repo : '';
    const dir = resolveHomePath(wiki.wikiDir);
    if (!fs.existsSync(dir)) return { success: false, error: `Wiki folder not found: ${wiki.wikiDir}` };
    try {
      const pages = await readWiki(dir);
      // Tags only here; a real review also matches keywords from the PR's changed files.
      const companyTag = wiki.wikiCompanyTag || defaultCompanyTag(project.name);
      const selection = selectWikiContext(pages, { repo, companyTag, tags: wiki.wikiTags, exclude: containsSecret });
      return {
        success: true,
        companyTag,
        pagesScanned: selection.pagesScanned,
        totalChars: selection.totalChars,
        skipped: selection.skipped,
        excerpts: selection.excerpts.map((e) => ({ slug: e.slug, title: e.title, updated: e.updated, reasons: e.reasons, chars: e.excerpt.length })),
      };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsWikiTags, async (_event: IpcMainInvokeEvent, payload?: { wikiDir?: unknown }) => {
    const wiki = parseWikiSettings({ wikiDir: payload?.wikiDir });
    if (!wiki.ok) return { success: false, error: wiki.error };
    const dir = resolveHomePath(wiki.wikiDir);
    if (!fs.existsSync(dir)) return { success: false, error: `Wiki folder not found: ${wiki.wikiDir}` };
    try {
      return { success: true, tags: listWikiTags(await readWiki(dir)) };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsBuildDetect, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; repo?: unknown; root?: unknown }) => {
    const project = findProject(payload?.id);
    const repo = typeof payload?.repo === 'string' ? payload.repo : '';
    if (!project || !(project.repos ?? []).includes(repo)) return { success: false, error: 'Choose one of the project’s repos.' };
    const token = tokenStore.getToken(project.id, 'github');
    if (!token) return { success: false, error: 'Save a GitHub token first.' };
    try {
      const info = await githubGet(token, `/repos/${repo}`);
      if (!info.ok) return { success: false, error: githubErrorMessage(info.status) };
      const branch = String(((await info.json()) as { default_branch?: unknown }).default_branch ?? 'main');
      // The project folder inside the repo ('' = root). Never outside it.
      const root = typeof payload?.root === 'string' ? payload.root.replace(/^\.?\/+|\/+$/g, '') : '';
      if (root.split('/').includes('..') || root.length > 200) return { success: false, error: 'Invalid project folder.' };
      // Folders that look like a Roku project, from one call to the repo's file tree.
      let roots: string[] = [''];
      const tree = await githubGet(token, `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`).catch(() => null);
      if (tree?.ok) {
        const body = (await tree.json()) as { tree?: { path?: string; type?: string }[] };
        roots = projectFolders((body.tree ?? []).filter((t) => t.type === 'blob' && t.path).map((t) => t.path as string));
        if (!roots.length) roots = [''];
      }
      // Reads files from the base branch through the API: nothing from the repo runs here.
      const read = async (rel: string): Promise<string | null> => {
        const file = root ? `${root}/${rel}` : rel;
        const res = await githubGet(token, `/repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
        if (!res.ok) return null;
        const body = (await res.json()) as { content?: string; encoding?: string };
        return body.content && body.encoding === 'base64' ? Buffer.from(body.content, 'base64').toString('utf-8') : null;
      };
      const detected = await detectBuild(read);
      return detected
        ? { success: true, detected: { ...detected, branch, root }, roots }
        : { success: false, roots, error: `No Roku project found in ${root ? `the folder "${root}"` : 'the repo root'} on ${branch}.${roots.some((r) => r !== root) ? ' Pick another project folder.' : ' Enter the commands yourself.'}` };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.ProjectsBuildSave, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; repo?: unknown } & Record<string, unknown>) => {
    const projects = readRegistry();
    const project = projects.find((p) => p.id === payload?.id);
    const repo = typeof payload?.repo === 'string' ? payload.repo : '';
    if (!project || !(project.repos ?? []).includes(repo)) return { success: false, error: 'Choose one of the project’s repos.' };
    const parsed = parseBuildConfig(payload);
    if (!parsed.ok) return { success: false, error: parsed.error };
    const existing = project.builds?.[repo];
    const next: ProjectRecord = { ...project, builds: { ...(project.builds ?? {}), [repo]: { ...parsed.config, approvedAt: Date.now(), envFiles: existing?.envFiles, envVars: existing?.envVars } } };
    writeRegistry(projects.map((p) => (p.id === project.id ? next : p)));
    return { success: true, project: toListItem(next) };
  });

  ipcMain.handle(IPC.ProjectsBuildEnvSave, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; repo?: unknown; text?: unknown }) => {
    const projects = readRegistry();
    const project = projects.find((p) => p.id === payload?.id);
    const repo = typeof payload?.repo === 'string' ? payload.repo : '';
    if (!project || !(project.repos ?? []).includes(repo)) return { success: false, error: 'Choose one of the project’s repos.' };
    const parsed = parseEnvBulk(typeof payload?.text === 'string' ? payload.text : '');
    if (!parsed.ok) return { success: false, error: parsed.error };
    try {
      tokenStore.setSecret(project.id, `buildenv:${repo}`, JSON.stringify(parsed.env.files));
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
    const existing = project.builds?.[repo] ?? { command: '', outDir: '.', install: '' };
    const next: ProjectRecord = { ...project, builds: { ...(project.builds ?? {}), [repo]: { ...existing, envFiles: Object.keys(parsed.env.files).length, envVars: parsed.env.vars } } };
    writeRegistry(projects.map((p) => (p.id === project.id ? next : p)));
    // Only counts and names come back; values never leave the main process.
    return { success: true, project: toListItem(next), files: Object.keys(parsed.env.files), vars: parsed.env.vars, removed: parsed.env.removed };
  });

  ipcMain.handle(IPC.ProjectsBuildEnvClear, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; repo?: unknown }) => {
    const projects = readRegistry();
    const project = projects.find((p) => p.id === payload?.id);
    const repo = typeof payload?.repo === 'string' ? payload.repo : '';
    if (!project || !project.builds?.[repo]) return { success: false, error: 'Nothing saved for this repo.' };
    tokenStore.clearSecret(project.id, `buildenv:${repo}`);
    const next: ProjectRecord = { ...project, builds: { ...project.builds, [repo]: { ...project.builds[repo], envFiles: 0, envVars: 0 } } };
    writeRegistry(projects.map((p) => (p.id === project.id ? next : p)));
    return { success: true, project: toListItem(next) };
  });

  ipcMain.handle(IPC.ProjectsListModels, async (_event: IpcMainInvokeEvent, payload?: { id?: unknown }) => {
    const project = findProject(payload?.id);
    if (!project) return { success: false, error: 'Project not found.' };
    const apiKey = tokenStore.getToken(project.id, 'cursor');
    if (!apiKey) return { success: false, error: 'Save a Cursor API key first.' };
    try {
      return { success: true, models: await listCursorModels(apiKey) };
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle(
    IPC.ProjectsSetSettings,
    async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; jiraSite?: unknown; jiraEmail?: unknown; figmaTestUrl?: unknown }) => {
      const projects = readRegistry();
      const project = projects.find((p) => p.id === payload?.id);
      if (!project) return { success: false, error: 'Project not found.' };
      const next: ProjectRecord = { ...project };
      try {
        if (typeof payload?.jiraSite === 'string' && payload.jiraSite.trim()) {
          const site = parseJiraSite(payload.jiraSite);
          if (!site.ok) return { success: false, error: site.error };
          next.jiraSite = site.value;
        }
        if (typeof payload?.jiraEmail === 'string' && payload.jiraEmail.trim()) {
          const email = parseJiraEmail(payload.jiraEmail);
          if (!email.ok) return { success: false, error: email.error };
          next.jiraEmail = email.value;
        }
        if (typeof payload?.figmaTestUrl === 'string' && payload.figmaTestUrl.trim()) {
          const figma = parseFigmaTestUrl(payload.figmaTestUrl);
          if (!figma.ok) return { success: false, error: figma.error };
          next.figmaTestUrl = figma.value;
        }
        writeRegistry(projects.map((p) => (p.id === project.id ? next : p)));
        return { success: true, project: toListItem(next) };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    }
  );

  ipcMain.handle(
    IPC.ProjectsTest,
    async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; service?: unknown }) => {
      const project = findProject(payload?.id);
      if (!project || !isTokenService(payload?.service)) return { success: false, error: 'Invalid project or service.' };
      const token = tokenStore.getToken(project.id, payload.service);
      if (!token) return { success: false, error: 'Save a token first.' };
      try {
        // Tokens are used only in request headers. They are never logged or returned.
        if (payload.service === 'jira') {
          if (!project.jiraSite || !project.jiraEmail) return { success: false, error: 'Set the JIRA site URL and email first.' };
          const basic = Buffer.from(`${project.jiraEmail}:${token}`).toString('base64');
          const res = await fetch(`${project.jiraSite}/rest/api/3/myself`, {
            headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
          });
          if (!res.ok) return { success: false, error: res.status === 401 || res.status === 403 ? 'JIRA rejected the email or token.' : `JIRA returned HTTP ${res.status}.` };
          const me = (await res.json()) as { displayName?: unknown };
          return { success: true, detail: `Signed in as ${typeof me.displayName === 'string' ? me.displayName : 'JIRA user'}.` };
        }
        if (payload.service === 'cursor') {
          const models = await listCursorModels(token);
          return { success: true, detail: `Key works · ${models.length} models available.` };
        }
        if (payload.service === 'figma') {
          if (!project.figmaTestUrl) return { success: false, error: 'Set a Figma test file URL first.' };
          const figma = parseFigmaTestUrl(project.figmaTestUrl);
          if (!figma.ok) return { success: false, error: figma.error };
          const res = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(figma.fileKey)}?depth=1`, {
            headers: { 'X-Figma-Token': token },
          });
          if (!res.ok) return { success: false, error: res.status === 403 ? 'Figma rejected the token for this file.' : `Figma returned HTTP ${res.status}.` };
          const file = (await res.json()) as { name?: unknown };
          return { success: true, detail: `Can read "${typeof file.name === 'string' ? file.name : 'file'}".` };
        }
        const scan = await scanAccessibleRepos(token);
        const orgs = scan.orgs.length === 1 ? '1 org' : `${scan.orgs.length} orgs`;
        const skipped = scan.skipped.length ? ` Skipped: ${scan.skipped.map((s) => `${s.org} (${s.reason})`).join(', ')}.` : '';
        return { success: true, detail: `Signed in as ${scan.login} · ${orgs} · ${scan.repos.length}${scan.truncated ? '+' : ''} repos.${skipped}` };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    }
  );

  ipcMain.handle(
    IPC.ProjectsSetToken,
    async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; service?: unknown; value?: unknown }) => {
      const project = findProject(payload?.id);
      if (!project || !isTokenService(payload?.service)) return { success: false, error: 'Invalid project or service.' };
      if (typeof payload?.value !== 'string') return { success: false, error: 'Token is required.' };
      try {
        tokenStore.setToken(project.id, payload.service, payload.value);
        return { success: true, hasToken: true };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    }
  );

  ipcMain.handle(
    IPC.ProjectsClearToken,
    async (_event: IpcMainInvokeEvent, payload?: { id?: unknown; service?: unknown }) => {
      const project = findProject(payload?.id);
      if (!project || !isTokenService(payload?.service)) return { success: false, error: 'Invalid project or service.' };
      try {
        tokenStore.clearToken(project.id, payload.service);
        return { success: true, hasToken: false };
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
    }
  );
}

export { setupProjectHandlers };
