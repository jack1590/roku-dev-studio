/**
 * Pins the wiki reader against a throwaway wiki: frontmatter forms, ranking by repo tag, extra
 * tags and keywords, freshness, size caps, and caller-driven exclusion.
 * Run with `npm run verify -w roku-dev-studio-review`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWikiTags, parseFrontmatter, readWiki, renderWikiPromptBlock, repoTag, selectWikiContext } from './wiki';

const page = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}\n`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rds-wiki-'));
  try {
    for (const sub of ['concepts', 'sources', 'raw', '.evolution']) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, 'sources', 'pr-player-1.md'), page('type: source\ntitle: "PR 1 learnings"\ntags: [pr-learning, project-acme-player-roku, company-acme]\nupdated: 2026-10-09', 'Never call observeField inside a Task loop.'));
    writeFileSync(join(dir, 'sources', 'pr-acmeplus-9.md'), page('type: source\ntitle: "acmeplus PR 9"\ntags: [pr-learning, project-acmeplus-roku, company-acme]\nupdated: 2026-10-08', 'Other Acme repo, other org.'));
    writeFileSync(join(dir, 'concepts', 'globex-only.md'), page('type: concept\ntitle: Globex only\ntags: [project-globex-apps-roku, company-globex, feature-flag]\nupdated: 2026-10-10', 'Belongs to another company. Mentions rendezvous too.'));
    writeFileSync(join(dir, 'concepts', 'global-setup.md'), page('type: concept\ntitle: Global setup\ntags: [project-global, setup]\nupdated: 2026-10-10', 'No company. Mentions rendezvous.'));
    writeFileSync(join(dir, 'sources', 'pr-player-0.md'), page('type: source\ntitle: Older PR\ntags:\n  - project-acme-player-roku\nupdated: 2026-01-01', 'Old note.'));
    writeFileSync(join(dir, 'concepts', 'roku-bugs.md'), page('type: concept\ntitle: Roku known bugs\ntags: [project-roku]\nupdated: 2026-10-01', 'Video node rendezvous on the render thread is slow.'));
    writeFileSync(join(dir, 'concepts', 'unrelated.md'), page('type: concept\ntitle: Unrelated\ntags: [project-other]\nupdated: 2026-10-10', 'Nothing about this repo.'));
    writeFileSync(join(dir, 'concepts', 'leaky.md'), page('type: concept\ntitle: Leaky\ntags: [project-acme-player-roku]\nupdated: 2026-10-10', 'password = hunter2secret'));
    writeFileSync(join(dir, 'raw', 'ignored.md'), page('title: Raw\ntags: [project-acme-player-roku]', 'raw source must not be read'));
    writeFileSync(join(dir, '.evolution', 'ignored.md'), page('title: Evo\ntags: [project-acme-player-roku]', 'never read'));

    assert.equal(repoTag('acme/Acme-Player-Roku'), 'project-acme-player-roku');
    assert.deepEqual(parseFrontmatter('no frontmatter').data, {});
    assert.deepEqual(parseFrontmatter(page('tags: [a, "b"]', 'x')).data.tags, ['a', 'b']);

    const pages = await readWiki(dir);
    assert.equal(pages.length, 8, 'raw/ and .evolution/ are never read');

    // Company boundary: extra tags and keywords never pull in another company or a global page...
    const fenced = selectWikiContext(pages, { repo: 'acme/acme-player-roku', companyTag: 'company-acme', tags: ['feature-flag'], keywords: ['rendezvous'], exclude: (text) => /password\s*=/.test(text) });
    const fencedSlugs = fenced.excerpts.map((e) => e.slug);
    assert.ok(!fencedSlugs.includes('globex-only'), 'other company stays out even when its tag or text matches');
    assert.ok(!fencedSlugs.includes('global-setup'), 'global page stays out unless one of its tags is picked');
    assert.ok(!fencedSlugs.includes('roku-bugs'), 'pages with no company tag stay out');
    // ...unless picked explicitly.
    const optIn = selectWikiContext(pages, { repo: 'acme/acme-player-roku', companyTag: 'company-acme', tags: ['company-globex', 'setup'], exclude: (text) => /password\s*=/.test(text) });
    const optInSlugs = optIn.excerpts.map((e) => e.slug);
    assert.ok(optInSlugs.includes('globex-only') && optInSlugs.includes('global-setup'));
    assert.equal(optInSlugs[0], 'pr-player-1', 'own repo still first');

    const tags = listWikiTags(pages);
    assert.deepEqual(tags[0], { tag: 'project-acme-player-roku', count: 3, group: 'project' }, 'most used first');
    assert.deepEqual(tags.find((t) => t.tag === 'company-acme'), { tag: 'company-acme', count: 2, group: 'company' });
    assert.equal(tags.find((t) => t.tag === 'pr-learning')?.group, 'topic');

    // Company tag: the repo's own pages first, then other repos of the same company; other companies never.
    const company = selectWikiContext(pages, { repo: 'acme/acme-player-roku', companyTag: 'company-acme', exclude: (text) => /password\s*=/.test(text) });
    assert.deepEqual(company.excerpts.map((e) => e.slug).slice(0, 3), ['pr-player-1', 'pr-player-0', 'pr-acmeplus-9']);
    assert.ok(!company.excerpts.some((e) => e.slug === 'globex-only'));

    const selection = selectWikiContext(pages, {
      repo: 'acme/acme-player-roku',
      tags: ['project-roku'],
      keywords: ['rendezvous', 'xx', 'roku', 'player'],
      exclude: (text) => /password\s*=/.test(text),
    });
    const slugs = selection.excerpts.map((e) => e.slug);
    // No company tag given = no boundary, so keyword matches from any page can follow.
    assert.deepEqual(slugs.slice(0, 3), ['pr-player-1', 'pr-player-0', 'roku-bugs'], 'repo tag first, fresher first, then extra tag + keyword');
    assert.ok(!slugs.includes('unrelated'));
    assert.deepEqual(selection.skipped, [{ slug: 'leaky', reason: 'looks like it contains a credential' }]);
    assert.ok(selection.excerpts[2].reasons.some((r) => r.startsWith('mentions rendezvous')));
    assert.ok(!selection.excerpts.some((e) => e.reasons.some((r) => /mentions.*\b(roku|player)\b/.test(r))), 'generic words never count as matches');

    const capped = selectWikiContext(pages, { repo: 'acme/acme-player-roku', maxChars: 50 });
    assert.ok(capped.totalChars <= 50);
    assert.ok(capped.skipped.some((s) => s.reason === 'over the size cap'));

    const truncated = selectWikiContext(pages, { repo: 'acme/acme-player-roku', maxPageChars: 10 });
    assert.ok(truncated.excerpts[0].excerpt.endsWith('…(truncated)'));

    const block = renderWikiPromptBlock(selection);
    assert.ok(block.includes('(wiki: pr-player-1, updated 2026-10-09)'));
    assert.equal(renderWikiPromptBlock({ excerpts: [], skipped: [], totalChars: 0, pagesScanned: 0 }), '');
    console.log('verify-wiki: ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
