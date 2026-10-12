/**
 * Team knowledge from the user's LLM Wiki (`~/wiki`, see its SCHEMA.md), read locally.
 *
 * A review gets a few relevant excerpts in its prompt, never access to the wiki folder itself.
 *
 * The project's company tag (`company-<name>`, grouping every repo and org of one company) is a
 * hard boundary: only that company's pages are eligible, plus the repo's own `project-<repo>` pages
 * that carry no company tag. Another company's pages, or other pages with no company tag, get in
 * only when one of their tags is explicitly picked as an extra tag.
 * Within the eligible set, the repo's own pages (`project-<repo>`) rank first, then extra-tag and
 * keyword matches, then the rest of the company. Fresher pages win, sizes are capped,
 * and pages the caller flags (e.g. anything that looks like a credential) are skipped, because
 * the excerpts are sent to the AI models.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

/** Page folders from SCHEMA.md. raw/, graph/, .evolution/ and caches are never read. */
const PAGE_DIRS = ['concepts', 'entities', 'synthesis', 'sources'];
const MAX_PAGE_BYTES = 200_000;
/** Words too common in Roku codebases to say anything about relevance. */
const GENERIC_KEYWORDS = new Set(['roku', 'player', 'source', 'components', 'component', 'images', 'test', 'tests', 'main', 'index', 'utils', 'util', 'dist', 'scene', 'node', 'brs', 'xml', 'json', 'manifest', 'build', 'src', 'lib', 'app', 'apps', 'channel']);

export interface WikiPage {
  /** Path relative to the wiki root, e.g. "concepts/roku-known-bugs.md". */
  path: string;
  slug: string;
  title: string;
  type: string;
  tags: string[];
  /** YYYY-MM-DD from frontmatter, if present. */
  updated: string;
  /** Markdown without frontmatter. */
  body: string;
}

export interface WikiExcerpt {
  slug: string;
  title: string;
  path: string;
  tags: string[];
  updated: string;
  /** Why it was picked: the matching tags and/or keywords. */
  reasons: string[];
  excerpt: string;
}

export interface WikiSelection {
  excerpts: WikiExcerpt[];
  skipped: { slug: string; reason: string }[];
  totalChars: number;
  pagesScanned: number;
}

export interface WikiSelectOptions {
  /** "owner/name" of the repo under review; adds the tag project-<name>. */
  repo?: string;
  /** The project's company tag, e.g. "company-acme". When set, it is a hard boundary (see above). */
  companyTag?: string;
  /** Extra tags picked on the project. The only way to bring in other companies or global pages. */
  tags?: string[];
  /** Terms from the change (file names, identifiers). Matched case-insensitively. */
  keywords?: string[];
  /** Total characters across excerpts. */
  maxChars?: number;
  /** Characters per page. */
  maxPageChars?: number;
  /** Return true to skip a page (e.g. it looks like it contains a credential). */
  exclude?: (text: string) => boolean;
}

/** The tag a wiki page uses for a repo: project-<repo name>, lowercased. */
export function repoTag(repo: string): string {
  const name = repo.split('/').pop() ?? repo;
  return `project-${name.toLowerCase()}`;
}

/** Minimal frontmatter reader: `key: value`, `key: [a, b]`, and `- item` lists. */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) {
      if (!/^\s/.test(line)) listKey = null;
      continue;
    }
    const [, key, raw] = pair;
    listKey = null;
    if (raw === '') {
      data[key] = [];
      listKey = key;
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      data[key] = unquote(raw.trim());
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

/** All pages under the schema's page folders. Unreadable or oversized files are ignored. */
export async function readWiki(wikiDir: string): Promise<WikiPage[]> {
  const pages: WikiPage[] = [];
  for (const dir of PAGE_DIRS) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(wikiDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(wikiDir, dir, name);
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_PAGE_BYTES) continue;
        const { data, body } = parseFrontmatter(await fs.readFile(file, 'utf-8'));
        const tags = Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' ? [data.tags] : [];
        const slug = name.replace(/\.md$/, '');
        pages.push({
          path: `${dir}/${name}`,
          slug,
          title: typeof data.title === 'string' && data.title ? data.title : slug,
          type: typeof data.type === 'string' ? data.type : dir.replace(/s$/, ''),
          tags: tags.map((t) => t.toLowerCase()),
          updated: typeof data.updated === 'string' ? data.updated : '',
          body: body.trim(),
        });
      } catch {
        // A page that cannot be read is simply not used.
      }
    }
  }
  return pages;
}

export type WikiTagGroup = 'company' | 'project' | 'topic';

export interface WikiTag {
  tag: string;
  count: number;
  group: WikiTagGroup;
}

/** Every tag used in the wiki with its page count, grouped for a picker, most used first. */
export function listWikiTags(pages: WikiPage[]): WikiTag[] {
  const counts = new Map<string, number>();
  for (const page of pages) for (const tag of new Set(page.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const groupOf = (tag: string): WikiTagGroup => (tag.startsWith('company-') ? 'company' : tag.startsWith('project-') ? 'project' : 'topic');
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count, group: groupOf(tag) }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Pick the pages a review should see, most relevant and freshest first, within the size caps. */
export function selectWikiContext(pages: WikiPage[], options: WikiSelectOptions = {}): WikiSelection {
  const maxChars = options.maxChars ?? 12_000;
  const maxPageChars = options.maxPageChars ?? 3_000;
  const wantedTags = new Set((options.tags ?? []).map((t) => t.toLowerCase()));
  const ownTag = options.repo ? repoTag(options.repo) : null;
  if (ownTag) wantedTags.add(ownTag);
  const companyTag = options.companyTag?.toLowerCase() || null;
  if (companyTag) wantedTags.add(companyTag);
  const keywords = [...new Set((options.keywords ?? []).map((k) => k.toLowerCase()).filter((k) => k.length >= 4 && !GENERIC_KEYWORDS.has(k)))];

  const extraTags = new Set((options.tags ?? []).map((t) => t.toLowerCase()));
  /** Inside the company, or explicitly picked: another company's tag, or a tag on a page with no company. */
  const eligible = (page: WikiPage): boolean => {
    if (!companyTag) return true;
    const companies = page.tags.filter((t) => t.startsWith('company-'));
    if (companies.includes(companyTag)) return true;
    if (companies.length) return companies.some((t) => extraTags.has(t));
    // No company tag: the repo's own pages still count (e.g. pages written before company tags).
    return (ownTag !== null && page.tags.includes(ownTag)) || page.tags.some((t) => extraTags.has(t));
  };

  const scored = pages
    .filter(eligible)
    .map((page) => {
      const reasons: string[] = [];
      let score = 0;
      for (const tag of page.tags) {
        if (!wantedTags.has(tag)) continue;
        reasons.push(`tag ${tag}`);
        // The repo's own pages first, then the rest of the company, then extra tags.
        score += tag === ownTag ? 20 : tag === companyTag ? 15 : 10;
      }
      const haystack = `${page.title}\n${page.body}`.toLowerCase();
      const hits = keywords.filter((k) => haystack.includes(k));
      if (hits.length) {
        reasons.push(`mentions ${hits.slice(0, 3).join(', ')}`);
        score += Math.min(hits.length, 5) * 2;
      }
      return { page, reasons, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.page.updated.localeCompare(a.page.updated));

  const selection: WikiSelection = { excerpts: [], skipped: [], totalChars: 0, pagesScanned: pages.length };
  for (const { page, reasons } of scored) {
    if (options.exclude?.(`${page.title}\n${page.body}`)) {
      selection.skipped.push({ slug: page.slug, reason: 'looks like it contains a credential' });
      continue;
    }
    const excerpt = page.body.length > maxPageChars ? `${page.body.slice(0, maxPageChars).trimEnd()}\n…(truncated)` : page.body;
    if (selection.totalChars + excerpt.length > maxChars) {
      selection.skipped.push({ slug: page.slug, reason: 'over the size cap' });
      continue;
    }
    selection.totalChars += excerpt.length;
    selection.excerpts.push({ slug: page.slug, title: page.title, path: page.path, tags: page.tags, updated: page.updated, reasons, excerpt });
  }
  return selection;
}

/** The prompt block a reviewer or judge receives. Empty string when nothing was selected. */
export function renderWikiPromptBlock(selection: WikiSelection): string {
  if (!selection.excerpts.length) return '';
  const parts = selection.excerpts.map((e) => `### ${e.title} (wiki: ${e.slug}${e.updated ? `, updated ${e.updated}` : ''})\n${e.excerpt}`);
  return [
    '## Team knowledge (from the user’s wiki)',
    'Past findings and conventions for this codebase. Cite a page as "wiki: <slug>" when a finding relies on it. If a page conflicts with the repository’s own AGENTS.md or code, the repository wins.',
    ...parts,
  ].join('\n\n');
}
