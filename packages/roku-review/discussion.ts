/**
 * The PR's existing discussion, so the judge does not repeat points already raised
 * and can weigh what the author answered.
 *
 * - Inline review threads with every reply, resolved and outdated state (GraphQL), plus general
 *   PR comments. Bot comments are dropped; ours stay (without the hidden marker) so replies to
 *   them count.
 * - Only the judge sees it, so the reviewers' prompts (and cost) do not change.
 * - A finding the discussion settles is dismissed; one the author answered wrongly gets a reply
 *   draft for that thread instead of a new comment.
 *
 * The token is only used in the request header; it is never logged or returned.
 */

export interface DiscussionComment {
  author: string;
  body: string;
  at: string;
}

export interface DiscussionThread {
  /** "t<root comment id>" for an inline thread, "c<comment id>" for a general PR comment. */
  id: string;
  kind: 'inline' | 'general';
  /** Review comment id to reply to (inline threads only). */
  rootId?: number;
  file?: string;
  line?: number;
  url?: string;
  resolved: boolean;
  outdated: boolean;
  /** The first comment, then the replies in order. */
  comments: DiscussionComment[];
}

export interface Discussion {
  threads: DiscussionThread[];
  error?: string;
}

const MAX_THREADS = 60;
const MAX_BODY = 1500;
const MARKER = /<!--\s*rds-review:[^>]*-->/g;

interface GqlComment {
  databaseId: number;
  url: string;
  body: string;
  createdAt: string;
  author: { login: string; __typename: string } | null;
}

const clean = (body: string) => {
  const text = body.replace(MARKER, '').trim();
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text;
};
const isBot = (c: GqlComment) => !c.author || c.author.__typename === 'Bot' || c.author.login.endsWith('[bot]');
const toComment = (c: GqlComment): DiscussionComment => ({ author: c.author?.login ?? 'unknown', body: clean(c.body), at: c.createdAt });

/** Shape the GraphQL reply into threads. Pure; pinned by verify-review.ts. */
export function toThreads(pr: {
  reviewThreads?: { nodes: { isResolved: boolean; isOutdated: boolean; path: string; line: number | null; originalLine: number | null; comments: { nodes: GqlComment[] } }[] };
  comments?: { nodes: GqlComment[] };
}): DiscussionThread[] {
  const threads: DiscussionThread[] = [];
  for (const t of pr.reviewThreads?.nodes ?? []) {
    const comments = t.comments.nodes.filter((c) => !isBot(c));
    const root = t.comments.nodes[0];
    if (!root || !comments.length) continue;
    threads.push({
      id: `t${root.databaseId}`,
      kind: 'inline',
      rootId: root.databaseId,
      file: t.path,
      line: t.line ?? t.originalLine ?? undefined,
      url: root.url,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      comments: comments.map(toComment),
    });
  }
  for (const c of pr.comments?.nodes ?? []) {
    if (isBot(c) || !clean(c.body)) continue;
    threads.push({ id: `c${c.databaseId}`, kind: 'general', url: c.url, resolved: false, outdated: false, comments: [toComment(c)] });
  }
  // Open threads first, then the newest: what the judge most needs fits the cap.
  return threads.sort((a, b) => Number(a.resolved) - Number(b.resolved) || (b.comments.at(-1)?.at ?? '').localeCompare(a.comments.at(-1)?.at ?? '')).slice(0, MAX_THREADS);
}

export async function fetchDiscussion(input: { token: string; repo: string; number: number; signal?: AbortSignal }): Promise<Discussion> {
  const [owner, name] = input.repo.split('/');
  const query = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
    reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine comments(first:50){nodes{databaseId url body createdAt author{login __typename}}}}}
    comments(first:100){nodes{databaseId url body createdAt author{login __typename}}}}}}`;
  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, name, n: input.number } }),
      signal: input.signal,
    });
    const json = (await res.json().catch(() => null)) as { data?: { repository?: { pullRequest?: Parameters<typeof toThreads>[0] } }; errors?: { message: string }[] } | null;
    const pr = json?.data?.repository?.pullRequest;
    if (!res.ok || !pr) return { threads: [], error: json?.errors?.[0]?.message ?? `GitHub returned HTTP ${res.status}.` };
    return { threads: toThreads(pr) };
  } catch (err) {
    return { threads: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** What the judge gets: the threads as JSON, or why there are none. */
export function discussionPromptBlock(d: Discussion | undefined): string {
  if (!d) return '';
  if (d.error) return `PR discussion: could not be read (${d.error}). Judge the findings on the code alone.`;
  if (!d.threads.length) return 'PR discussion: no comments yet.';
  const slim = d.threads.map((t) => ({ id: t.id, kind: t.kind, file: t.file, line: t.line, resolved: t.resolved, outdated: t.outdated, comments: t.comments.map((c) => ({ author: c.author, body: c.body })) }));
  return `PR discussion so far (JSON, open threads first; "comments" are in order, the first one started the thread):\n${JSON.stringify(slim, null, 2)}`;
}
