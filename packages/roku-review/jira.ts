/**
 * The JIRA ticket behind a PR, so reviewers can check the change against what it was
 * meant to do.
 *
 * - Key: from the PR description, then the title, then the branch name. A key only counts if it
 *   resolves in JIRA, so "release-2" or a stale key never picks a wrong ticket.
 * - Read with the project's JIRA token: summary, type, status, description, acceptance criteria
 *   (any field named like that), and Figma links from the description and the ticket's remote links.
 * - No ticket: the review is correctness-only and the agents are told not to raise scope findings.
 *
 * The token is only used in the request header; it is never logged or returned.
 */

export interface Ticket {
  key: string;
  url: string;
  summary: string;
  type?: string;
  status?: string;
  description: string;
  acceptanceCriteria?: string;
  figmaLinks: string[];
  /** Where the key was found: "PR description", "PR title" or "branch name". */
  foundIn: string;
}

export interface TicketLookup {
  ticket: Ticket | null;
  /** Why there is no ticket, for the review card. */
  note?: string;
}

const KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;
const MAX_TEXT = 6000;

/** Candidate keys in order: description, title, branch; first occurrence wins. Pure; pinned by verify-review.ts. */
export function ticketKeyCandidates(sources: { from: string; text: string }[]): { key: string; from: string }[] {
  const out: { key: string; from: string }[] = [];
  for (const { from, text } of sources) {
    // Branches are often lower case ("rok-8326-fix"): match them case-insensitively.
    const hay = from === 'branch name' ? text.toUpperCase() : text;
    for (const m of hay.matchAll(KEY)) if (!out.some((c) => c.key === m[1])) out.push({ key: m[1], from });
  }
  return out;
}

/** Atlassian Document Format → plain text (paragraphs, lists, headings, code, links). Pure. */
export function adfToText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { url?: string; href?: string }; marks?: { type?: string; attrs?: { href?: string } }[] };
  if (n.type === 'text') {
    const link = n.marks?.find((m) => m.type === 'link')?.attrs?.href;
    return link && link !== n.text ? `${n.text ?? ''} (${link})` : n.text ?? '';
  }
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'inlineCard' || n.type === 'blockCard' || n.type === 'embedCard') return n.attrs?.url ?? '';
  const inner = (n.content ?? []).map(adfToText);
  switch (n.type) {
    case 'listItem':
      return `- ${inner.join('').trim()}\n`;
    case 'bulletList':
    case 'orderedList':
      return `${inner.join('')}\n`;
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'panel':
      return `${inner.join('').trim()}\n\n`;
    case 'codeBlock':
      return `\`\`\`\n${inner.join('')}\n\`\`\`\n\n`;
    default:
      return inner.join('');
  }
}

const figmaLinks = (text: string) => [...new Set([...text.matchAll(/https:\/\/(?:www\.)?figma\.com\/[^\s)\]"'>]+/g)].map((m) => m[0]))];
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (truncated)` : s).trim();

async function jira<T>(site: string, auth: string, path: string, signal?: AbortSignal): Promise<{ status: number; json: T | null }> {
  const res = await fetch(`${site}${path}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }, signal });
  return { status: res.status, json: res.ok ? ((await res.json()) as T) : null };
}

export async function lookupTicket(input: {
  site?: string;
  email?: string;
  token?: string | null;
  pr: { title: string; body: string; branch: string };
  signal?: AbortSignal;
}): Promise<TicketLookup> {
  const candidates = ticketKeyCandidates([
    { from: 'PR description', text: input.pr.body },
    { from: 'PR title', text: input.pr.title },
    { from: 'branch name', text: input.pr.branch },
  ]).slice(0, 5);
  if (!input.site || !input.email || !input.token) {
    return { ticket: null, note: candidates.length ? `Ticket ${candidates[0].key} not read: add the JIRA token, site and email in Settings → Projects.` : 'No JIRA set up for this project.' };
  }
  if (!candidates.length) return { ticket: null, note: 'No ticket key in the PR description, title or branch.' };
  const auth = Buffer.from(`${input.email}:${input.token}`).toString('base64');
  let lastStatus = 0;
  for (const c of candidates) {
    try {
      const res = await jira<{ key: string; fields: Record<string, unknown>; names?: Record<string, string> }>(input.site, auth, `/rest/api/3/issue/${encodeURIComponent(c.key)}?expand=names`, input.signal);
      lastStatus = res.status;
      if (!res.json) continue; // not a real ticket (or no access): try the next candidate
      const f = res.json.fields;
      const description = clip(adfToText(f.description));
      // Acceptance criteria live in a custom field on most sites; find it by its display name.
      const acField = Object.entries(res.json.names ?? {}).find(([, name]) => /acceptance\s*criteria/i.test(name))?.[0];
      const acceptanceCriteria = acField && f[acField] ? clip(typeof f[acField] === 'string' ? (f[acField] as string) : adfToText(f[acField])) : undefined;
      const remote = await jira<{ object?: { url?: string } }[]>(input.site, auth, `/rest/api/3/issue/${encodeURIComponent(c.key)}/remotelink`, input.signal).catch(() => ({ status: 0, json: null }));
      const links = [...figmaLinks(`${description}\n${acceptanceCriteria ?? ''}`), ...(remote.json ?? []).map((r) => r.object?.url ?? '').filter((u) => /figma\.com/.test(u))];
      return {
        ticket: {
          key: res.json.key,
          url: `${input.site}/browse/${res.json.key}`,
          summary: String(f.summary ?? ''),
          type: (f.issuetype as { name?: string } | undefined)?.name,
          status: (f.status as { name?: string } | undefined)?.name,
          description,
          acceptanceCriteria,
          figmaLinks: [...new Set(links)].slice(0, 10),
          foundIn: c.from,
        },
      };
    } catch {
      lastStatus = 0;
    }
  }
  return {
    ticket: null,
    note: lastStatus === 401 || lastStatus === 403 ? `JIRA refused the token (HTTP ${lastStatus}) for ${candidates.map((c) => c.key).join(', ')}.` : `${candidates.map((c) => c.key).join(', ')} did not resolve in JIRA.`,
  };
}

/** What the agents get. With no ticket they must not raise scope or requirement findings. */
export function ticketPromptBlock(lookup: TicketLookup | undefined): string {
  if (!lookup?.ticket) {
    return `JIRA ticket: none (${lookup?.note ?? 'not looked up'}). Review for correctness only: do not raise findings about missing scope or unmet requirements.`;
  }
  const t = lookup.ticket;
  return `JIRA ticket ${t.key} (${[t.type, t.status].filter(Boolean).join(', ') || 'ticket'}), found in the ${t.foundIn}: ${t.summary}
This is what the PR is meant to do. Check the change against it: requirements it misses or gets wrong, and behaviour it adds that the ticket does not ask for, are findings. Quote the ticket line you rely on.
--- TICKET DESCRIPTION ---
${t.description || '(empty)'}
--- END TICKET DESCRIPTION ---${t.acceptanceCriteria ? `\n--- ACCEPTANCE CRITERIA ---\n${t.acceptanceCriteria}\n--- END ACCEPTANCE CRITERIA ---` : ''}${t.figmaLinks.length ? `\nLinked designs (not shown here): ${t.figmaLinks.join(', ')}` : ''}`;
}
