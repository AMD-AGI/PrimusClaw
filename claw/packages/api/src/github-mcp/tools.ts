// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The GitHub tools, bound to one user's GitHub client.
 *
 * Every request goes through `GithubClient`: the token is a private field, the base address is the
 * configured one, and every path is built from a validated `owner/name`, a number or an encoded file path,
 * so no argument can aim the token at another host. What the tools return is GitHub's own data, cut to
 * the fields a person would read and to a size a turn can hold. Text from GitHub is untrusted data.
 *
 * The server's policy (`requires_approval: true`, the read tools in `auto_approve`; see mcp.ts) holds
 * every tool that is not listed in READ_TOOLS for the user's decision, including any added here later.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CITE_SOURCES_META, GITHUB_LIST_MAX_CHARS, type CiteSource } from "@claw/protocol";
import pino from "pino";
import { z } from "zod";
import { GithubError, GithubGraphqlError, isValidOwner, parseRepoRef, repoPath, type GithubClient } from "../github-review/github.js";

const logger = pino({ name: "github-mcp-tools" });

/** The tools that only read. Everything else this server offers writes, and waits for the user. */
export const READ_TOOLS = [
  "repo_get_file", "repo_list", "pr_get", "pr_list", "pr_files", "pr_diff", "pr_reviews", "checks_list", "job_logs",
  "issue_get", "issue_list", "issue_search", "review_threads_list", "code_search",
] as const;

/**
 * What every comment these tools write ends with: a mark, invisible on GitHub, that the comment was written from Claw. A pull request an
 * item watches (`assistant/github-events.ts`) is read with the same account, and a comment of that account carrying the mark is Claw's
 * own words, not the owner's: delivering it to the worker would wake it on its own answer. Only the account can write as itself, so a
 * stranger who copies the mark changes nothing.
 */
export const CLAW_WRITE_MARK = "<!-- claw:github-tool -->";
const COMMENT_MAX = 65_536 - CLAW_WRITE_MARK.length - 2;
const marked = (body: string): string => `${body}\n\n${CLAW_WRITE_MARK}`;

/** What one answer may hold; the rest is cut with a line that says so. */
export const MAX_ANSWER_CHARS = 60_000;
const MAX_PATCH_CHARS = 4_000;
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; _meta?: Record<string, unknown> };

/**
 * The host GitHub's own pages are on, for the API at `apiUrl`: github.com for api.github.com, and the API's own host otherwise
 * (GitHub Enterprise Server serves its pages and its API from one host).
 */
export function githubWebHost(apiUrl: string): string {
  try {
    const host = new URL(apiUrl).host.toLowerCase();
    return host === "api.github.com" ? "github.com" : host;
  } catch {
    return "github.com";
  }
}

/** The most sources one result lists. */
const MAX_SOURCES = 100;

/**
 * What a read returned, as sources a turn may cite (`ExecuteRequest.cite`): GitHub's own pages only, an https address on `webHost`.
 * A check's or a status's details address is the integration's choice and is a source only when it is one of GitHub's own pages.
 */
function sourcesOn(webHost: string, sources: Array<CiteSource | null>): CiteSource[] {
  const out: CiteSource[] = [];
  for (const s of sources) {
    if (!s || typeof s.url !== "string" || out.length >= MAX_SOURCES) continue;
    try {
      const u = new URL(s.url);
      if (u.protocol === "https:" && u.host.toLowerCase() === webHost && !u.username && !u.password) out.push(s);
    } catch { /* not an address */ }
  }
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A pull request or an issue (an `issueSummary` / `prSummary`) of `repo`, as a source. */
function itemSource(repo: string | undefined, i: Record<string, any> | null | undefined, pr?: boolean): CiteSource | null {
  if (!i || typeof i.url !== "string") return null;
  const isPr = pr ?? i.is_pull_request === true;
  return { url: i.url, title: `${repo ? `${repo}#` : "#"}${i.number ?? ""} ${str(i.title)}`.trim(), kind: isPr ? "github_pr" : "github_issue" };
}

/** An argument the tool cannot use; its message is for the model. */
class BadInput extends Error {}

function cut(text: string, max = MAX_ANSWER_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]`;
}

/** What GitHub's answer with each status means, in these tools' own words. */
const GITHUB_STATUS_MEANS: Record<number, string> = {
  400: "the request was refused as malformed",
  401: "the user's GitHub token was refused (expired or revoked); they can replace it in their Claw settings",
  403: "the user's GitHub token may not read this (a missing permission, or an organization that requires SSO authorization)",
  404: "not found, or the user's GitHub token cannot see it",
  409: "a conflict (for example, an empty repository)",
  410: "it is gone (deleted, or turned off for this repository)",
  422: "the request was refused as invalid (for a search: check the syntax, and that the users and repositories it names exist and are visible)",
  451: "unavailable for legal reasons",
};

/**
 * A read's failure, in these tools' own words: the status GitHub answered with and what it means, never GitHub's message.
 *
 * A failed read reads nothing anyone else wrote, which is what lets an assistant's router turn go on and start the work a lookup
 * could not do (`assistant/read-tools.ts`, `cleanFailures`). That holds only while the failure's text is all Claw's: GitHub's
 * message, a GraphQL error and a transport error can each carry what someone else chose (a name, a query, an address), so none
 * of them is passed on. They are logged, with GitHub's request id. `BadInput` is these tools' own, fixed, text.
 */
function readFailure(err: unknown): string {
  if (err instanceof BadInput) return err.message;
  if (err instanceof GithubGraphqlError) {
    return "GitHub refused the request: the repository, pull request or thread may not exist, or the user's GitHub token cannot see it";
  }
  if (err instanceof GithubError) {
    if (err.status === 0) return "GitHub could not be reached (the request failed or timed out); try once more";
    if (err.rateLimited) {
      return `GitHub answered ${err.status}: rate limited${err.retryAfterSeconds ? `; retry after ${err.retryAfterSeconds} seconds` : ""}`;
    }
    if (err.status >= 500) return `GitHub answered ${err.status}: GitHub could not answer (or its answer was too large to read); try once more`;
    return `GitHub answered ${err.status}: ${GITHUB_STATUS_MEANS[err.status] ?? "the request was refused"}`;
  }
  return "the call failed; try once more";
}

/** `sources`: what a read's answer lists as sources, put in the result's `_meta` where only Brain reads it, never the model. */
async function answer(tool: string, run: () => Promise<unknown>, sources?: (value: any) => CiteSource[]): Promise<ToolResult> {
  try {
    const value = await run();
    let listed: CiteSource[] = [];
    try {
      listed = sources ? sources(value) : [];
    } catch (err) {
      // The read answered; only its sources are lost.
      logger.warn({ tool, errorClass: (err as Error)?.constructor?.name }, "github_mcp.sources_failed");
    }
    return {
      content: [{ type: "text", text: cut(typeof value === "string" ? value : JSON.stringify(value)) }],
      ...(listed.length ? { _meta: { [CITE_SOURCES_META]: listed } } : {}),
    };
  } catch (err) {
    if ((READ_TOOLS as readonly string[]).includes(tool)) {
      logger.warn({
        tool, errorClass: (err as Error)?.constructor?.name, status: (err as GithubError)?.status, requestId: (err as GithubError)?.requestId,
        err: (err as Error)?.message,
      }, "github_mcp.read_failed");
      return { content: [{ type: "text", text: readFailure(err) }], isError: true };
    }
    // A write's failure says what GitHub said (its message, redacted with the token by the client): a worker acts on it, and
    // no router turn calls a write.
    if (err instanceof GithubError || err instanceof BadInput) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    logger.error({ tool, errorClass: (err as Error)?.constructor?.name }, "github_mcp.tool_failed");
    return { content: [{ type: "text", text: "the call failed; try once more" }], isError: true };
  }
}

function repoOf(input: string): { owner: string; repo: string } {
  const ref = parseRepoRef(input);
  if (!ref) throw new BadInput("repo must be owner/name");
  return ref;
}

/** A path inside the repository, each segment encoded; `..` and empty segments are refused. */
function filePath(input: string): string {
  const parts = input.replace(/^\/+/, "").split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new BadInput("path must be a plain path inside the repository");
  return parts.map(encodeURIComponent).join("/");
}

const REF_RE = /^(?!.*\.\.)[A-Za-z0-9._\/-]{1,255}$/;
function refOf(input: string): string {
  if (!REF_RE.test(input)) throw new BadInput("ref must be a branch, tag or commit sha");
  return input;
}

const login = (u: unknown): string | undefined => (u && typeof u === "object" ? (u as { login?: string }).login : undefined);

/** `owner/name` of a search hit, from its `repository_url` (`<api>/repos/owner/name`). */
const repoOfUrl = (u: unknown): string | undefined => (typeof u === "string" ? /\/repos\/([^/]+\/[^/]+)$/.exec(u)?.[1] : undefined);

function prSummary(p: Record<string, any>) {
  return {
    number: p.number, title: p.title, state: p.state, draft: p.draft, merged: p.merged, author: login(p.user),
    url: p.html_url, base: p.base?.ref, head: p.head?.ref, head_sha: p.head?.sha, head_repo: p.head?.repo?.full_name,
    mergeable_state: p.mergeable_state, additions: p.additions, deletions: p.deletions, changed_files: p.changed_files,
    labels: Array.isArray(p.labels) ? p.labels.map((l: { name?: string }) => l.name) : undefined,
    created_at: p.created_at, updated_at: p.updated_at,
    // When and how it ended: "已经合入了吗" is answered with the time and the commit, not with merged: true alone.
    ...(p.merged_at ? { merged_at: p.merged_at, merged_by: login(p.merged_by), merge_commit: p.merge_commit_sha } : {}),
    ...(p.closed_at && !p.merged_at ? { closed_at: p.closed_at } : {}),
    body: p.body ?? "",
  };
}

function issueSummary(i: Record<string, any>) {
  return {
    number: i.number, title: i.title, state: i.state, author: login(i.user), url: i.html_url,
    is_pull_request: i.pull_request !== undefined, comments: i.comments,
    labels: Array.isArray(i.labels) ? i.labels.map((l: { name?: string } | string) => (typeof l === "string" ? l : l.name)) : undefined,
    created_at: i.created_at, updated_at: i.updated_at,
  };
}

/** A pull request in a list: what a person reads in one line, without the description. */
function prLine(p: Record<string, any>) {
  return {
    number: p.number, title: p.title, state: p.state, draft: p.draft, author: login(p.user), head: p.head?.ref, base: p.base?.ref,
    ...(p.merged_at ? { merged_at: p.merged_at } : {}), ...(p.closed_at && !p.merged_at ? { closed_at: p.closed_at } : {}),
    ...(Array.isArray(p.labels) && p.labels.length ? { labels: p.labels.map((l: { name?: string }) => l.name) } : {}),
    created_at: p.created_at, updated_at: p.updated_at, url: p.html_url,
  };
}

/** An issue or pull request in a list: `issueSummary` without the counts and empty fields a list has no use for. */
function issueLine(i: Record<string, any>) {
  const { labels, comments: _c, created_at: _created, ...rest } = issueSummary(i);
  return { ...rest, ...(labels?.length ? { labels } : {}) };
}

/**
 * A list answer that a turn sees whole: the items, in order, as many as fit in GITHUB_LIST_MAX_CHARS (which Brain keeps whole
 * for these tools), and what says whether that is all of them. `total_count` is the number of matches where it is known (a
 * search's count, or a list read to its end); `complete` is true only when every match is in `items`. A list cut in its middle
 * by the turn's own result cap answered "15 of my 22 open pull requests" with nothing to say which were left out.
 */
export function listAnswer(
  items: readonly unknown[],
  meta: {
    total_count?: number | null; complete: boolean; next_page?: number | null; note?: string; by_repo?: Record<string, number>;
    refs_by_repo?: Record<string, string[]>; since?: string; fixtures_excluded?: number | string;
    /** The page of the list these items are (1 for the first); false `count_exact` when total_count may be low (a search that timed out). */
    page?: number; count_exact?: boolean;
  },
): Record<string, unknown> {
  const repos = meta.by_repo ? Object.entries(meta.by_repo) : [];
  const headOf = (refs: boolean, repoKeep: number = repos.length) => ({
    total_count: meta.total_count ?? null, shown: 0, complete: false,
    ...(meta.by_repo ? { by_repo: Object.fromEntries(repos.slice(0, repoKeep)) } : {}),
    ...(repoKeep < repos.length
      ? { by_repo_cut: `${repos.length - repoKeep} more repositories (${repos.slice(repoKeep).reduce((n, [, c]) => n + c, 0)} matches) are not listed in by_repo: name one with repo: to count it` }
      : {}),
    ...(meta.refs_by_repo && refs ? { refs_by_repo: meta.refs_by_repo } : {}),
    ...(meta.refs_by_repo && !refs ? { refs_by_repo_cut: "too many repositories for every number to fit: by_repo counts them; list one repository's with its repo: qualifier" } : {}),
    ...(meta.since ? { since: meta.since } : {}),
    ...(meta.fixtures_excluded !== undefined && meta.fixtures_excluded !== 0 ? { fixtures_excluded: meta.fixtures_excluded } : {}),
    ...(meta.note ? { note: meta.note } : {}),
  });
  // The envelope's own size, with room for the fields filled in below (the partial line among them). An envelope that leaves no room
  // for them drops its numbers per repository first (by_repo still counts them): an answer over the cap is cut in two by Brain, and
  // is no longer JSON at all.
  const room = (h: object): boolean => JSON.stringify(h).length + ENVELOPE_ROOM + PARTIAL_ROOM <= GITHUB_LIST_MAX_CHARS;
  let head = headOf(true);
  if (!room(head)) head = headOf(false);
  // Still no room: the repositories with the most matches are kept in by_repo, the rest counted in one line.
  for (let keep = repos.length - 1; !room(head) && keep >= 0; keep--) head = headOf(false, keep);
  const kept: unknown[] = [];
  let size = JSON.stringify(head).length + ENVELOPE_ROOM + PARTIAL_ROOM;
  for (const item of items) {
    const n = JSON.stringify(item).length + 1;
    if (size + n > GITHUB_LIST_MAX_CHARS) break;
    kept.push(item);
    size += n;
  }
  const cutBySize = kept.length < items.length;
  const complete = meta.complete && !cutBySize;
  return {
    ...head, shown: kept.length, complete,
    ...(complete ? {} : {
      partial: partialLine(kept.length, meta.total_count ?? null, {
        page: meta.page ?? 1, more: cutBySize || Boolean(meta.next_page), exact: meta.count_exact !== false,
      }),
    }),
    ...(cutBySize ? { not_shown: items.length - kept.length, cut: "the answer holds no more: ask for fewer per page, or narrow the query" } : {}),
    ...(!complete && !cutBySize && meta.next_page ? { next_page: meta.next_page } : {}),
    items: kept,
  };
}

/**
 * What a list that is not all of its matches says beside them, in the answer itself. Read as if whole, 20 of the merged pull requests
 * answered "17 merged in the last 11 hours" and "only 3 open" (2026-11-07 06:09, the owner's 研发进度): the router had complete: false
 * and a note, and counted the page. So the answer names its own scope, and what to do before a count.
 */
export function partialLine(shown: number, total: number | null, at: { page?: number; more?: boolean; exact?: boolean } = {}): string {
  const page = at.page ?? 1;
  const these = page === 1 ? `the ${shown} most recent (最近 ${shown} 条里)` : `page ${page}, ${shown} of them (第 ${page} 页)`;
  const where = `items holds ${these}, not all the matches`;
  const rest = at.more ? "; to list the others, read next_page while there is one" : "";
  if (total !== null && at.exact !== false) {
    return `${where}. total_count ${total} counts all of them: give that as the total, never a count of items${rest}.`;
  }
  return `${where}, and ${total === null ? "how many there are in all is not known" : `total_count ${total} may be low`}. Before you give a `
    + "count, a total or \"all\"/\"only N\", read next_page while there is one (or narrow: since, state, author, a repository); if "
    + `you answer from these alone, say in the answer that it covers only these: ${these}.`;
}
/** Room the envelope keeps for `partialLine`, and for its other fields filled in after the items are chosen. */
export const PARTIAL_ROOM = 460;
const ENVELOPE_ROOM = 160;

/**
 * One page of a list GitHub pages itself (`per_page`, `page`): a page shorter than asked is the list's end, which gives the
 * count; a full one may have more after it.
 */
export function pageAnswer(items: readonly unknown[], perPage: number, page: number): Record<string, unknown> {
  const ended = items.length < perPage;
  return listAnswer(items, {
    total_count: ended ? (page - 1) * perPage + items.length : null,
    complete: ended && page === 1,
    next_page: ended ? null : page + 1,
    page,
  });
}

type PullState = "open" | "closed" | "merged" | "all";

/**
 * Pull requests read page by page (100 each, at most MAX_SCAN_PAGES) to keep one author's, or to order closed ones by when
 * they closed and merged ones by when they merged: GitHub's list orders by creation or by last update, and "the 3 most recently
 * merged" read in creation order named a pull request merged before another it was created after.
 *
 * Closed and merged ones are read most recently updated first, and the reading stops once the ones asked for are settled: a pull
 * request not read yet was updated no later than the oldest one read, and it closed or merged no later than it was updated, so
 * once enough have closed (merged) at or after that time, nothing unread can come before them.
 */
async function scanPulls(
  gh: GithubClient, r: { owner: string; repo: string }, filter: Record<string, string>, state: PullState,
  opts: { author: string | null; includeFixtures: boolean; since: number | null; sinceText?: string },
  perPage: number, page: number,
): Promise<Record<string, unknown>> {
  const { author, includeFixtures, since } = opts;
  const ordered = state === "closed" || state === "merged";
  const timeOf = (p: Record<string, any>): number =>
    Date.parse(String(state === "merged" ? p.merged_at : state === "closed" ? p.closed_at : p.created_at)) || 0;
  const latestFirst = (x: Record<string, any>, y: Record<string, any>): number => timeOf(y) - timeOf(x);
  const want = page * perPage;
  const kept: Record<string, any>[] = [];
  let ended = false;
  let settled = false;
  // With since: every one in the window has been read (an unread one was updated, or created, before it).
  let windowRead = false;
  let fixtures = 0;
  let read = 0;
  let oldestRead = Infinity;
  // Past the scan, reading goes on while the page asked for is not yet in hand (or, with since, while the window is not read), with
  // the same filter throughout, so that the items before it are counted the same way (a fixture left out of an earlier page moves
  // every later one); and one more than the page needs, to know whether another follows. A list in creation order with no author
  // filter is read as far as GitHub pages; a filtered or reordered one at most MAX_DEEP_PAGES, past which the note names the search.
  // One ordered by when it closed or merged reads on until the page is settled: it is read in update order, so a later page can still
  // hold one that closed or merged after some already read.
  const limit = !ordered && author === null ? MAX_LIST_PAGES : MAX_DEEP_PAGES;
  for (let n = 1; n <= limit && !ended && !settled && !windowRead && (n <= MAX_SCAN_PAGES || since !== null || ordered || kept.length <= want); n++) {
    const q = { ...filter, state: state === "merged" ? "closed" : state, sort: ordered ? "updated" : "created", direction: "desc", per_page: 100, page: n };
    const list = (await gh.get<any[]>(repoPath(r, "/pulls"), q)).json ?? [];
    read += list.length;
    for (const p of list) {
      if (author !== null && login(p.user)?.toLowerCase() !== author.toLowerCase()) continue;
      if (state === "merged" && !p.merged_at) continue;
      if (since !== null && timeOf(p) < since) continue;
      if (!includeFixtures && isGateFixture(p)) { fixtures++; continue; }
      kept.push(p);
    }
    const last = list[list.length - 1];
    if (last) oldestRead = Math.min(oldestRead, Date.parse(String(last.updated_at)) || 0);
    ended = list.length < 100;
    // A pull request not read yet was updated no later than the oldest read (closed and merged ones are read in update order, and
    // close or merge no later than they are updated), or, in creation order, created no later than the last one read.
    if (since !== null && last) windowRead = (ordered ? oldestRead : Date.parse(String(last.created_at)) || 0) < since;
    // Without a window, the reading stops once the page asked for is settled; with one, it reads the whole window, to count it.
    // Settled one past the page asked for, so that a next page is named only when it has one to give.
    if (since === null && ordered && !ended && kept.length > want) settled = timeOf([...kept].sort(latestFirst)[want]) >= oldestRead;
  }
  const known = ended || windowRead;
  const all = ordered ? [...kept].sort(latestFirst) : kept;
  const what = state === "all" ? "" : `${state === "merged" ? "closed" : state} `;
  return listAnswer(all.slice((page - 1) * perPage, want).map(prLine), {
    total_count: known ? all.length : null,
    complete: known && page === 1 && all.length <= perPage,
    // A next page only where there is one to give: past what the scan read, a page would come back empty and name the one after it.
    next_page: all.length > want ? page + 1 : null,
    page,
    ...(opts.sinceText ? { since: opts.sinceText } : {}),
    ...(fixtures ? { fixtures_excluded: fixtures } : {}),
    note: [
      ...(known ? [] : [
        `read the ${read} most recently ${ordered ? "updated" : "created"} ${what}pull requests, not all of them: how many there are in all is not known`
          + (ordered && !settled ? `, and older ones may have ${state === "merged" ? "merged" : "closed"} later than some shown` : "")
          + (all.length <= want
            ? `; pr_list reads no further`
              + (searchOfList(r, state, author, filter, opts.sinceText ?? null) !== null
                ? `: for older ones search with issue_search (${searchOfList(r, state, author, filter, opts.sinceText ?? null)}`
                  + `${includeFixtures ? ", include_fixtures: true" : ""})` : "")
              + (since === null ? `${searchOfList(r, state, author, filter, null) !== null ? ", or" : ":"} narrow with since` : "")
            : ""),
      ]),
      ...(fixtures ? [`${fixtures} release-gate fixture pull request(s) of those read are left out (test fixtures, never the project's work); include_fixtures: true lists them`] : []),
    ].join("; ") || undefined,
  });
}

/**
 * The issue_search query that reads the same pull requests as a pr_list call (its state, author, base and window), or null when there
 * is none: GitHub's search names a head branch without the fork it is on, so a head filter (owner:branch) has no search of its own.
 */
function searchOfList(r: { owner: string; repo: string }, state: PullState, author: string | null, filter: Record<string, string>, since: string | null): string | null {
  if (filter.head) return null;
  const when = state === "merged" ? "merged" : state === "closed" ? "closed" : "created";
  return [
    `is:pr repo:${r.owner}/${r.repo}`, ...(state === "all" ? [] : [`is:${state}`]), ...(author !== null ? [`author:${author}`] : []),
    ...(filter.base ? [`base:${filter.base}`] : []), ...(since ? [`${when}:>=${since.slice(0, 19)}Z`] : []),
  ].join(" ");
}

/** `since` as a time, or a refusal: a date the model wrote is checked, never guessed at. */
function sinceOf(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const t = text.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(t);
  // Each field in its range, the day in its month: Date.parse would move 2026-02-30 to March 2 and count another window.
  const [y, mo, d, h, mi, sec] = m ? [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) : [];
  const valid = m !== null && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && h <= 23 && mi <= 59 && sec <= 59;
  const ms = valid ? Date.parse(m[4] !== undefined && m[7] === undefined ? `${t}Z` : t) : NaN;
  if (!Number.isFinite(ms)) throw new BadInput("since must be an ISO date or time, such as 2026-11-02 or 2026-11-02T00:00:00Z");
  return ms;
}

/** The workflow run of a GitHub Actions check run, from its details address (`.../actions/runs/<run>/job/<job>`), or null. */
function actionsRunOf(c: Record<string, any>): number | null {
  if (c?.app?.slug !== "github-actions" || typeof c.details_url !== "string") return null;
  const m = /\/actions\/runs\/(\d{1,20})\/job\/\d+/.exec(c.details_url);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A search's matches are counted per repository (`by_repo`) up to this many: GitHub's search pages hold 100, so three more reads at most. */
export const BY_REPO_MAX = 300;

/** Why a search has no `by_repo`: too many matches, the matches changed (or a read was cut short) between reads, or a read failed. */
export type ByRepoUnavailable = "too_many" | "changed" | { failed: number | null };

/**
 * How many of a search's matches are in each repository, most first: from the page already read when it holds them all, else read
 * 100 at a time while there are at most BY_REPO_MAX; otherwise why not. "How many pull requests have I open, and where" was answered
 * from the 21 of a list cut in two, with "the count per repository is not certain". Never throws: the count is an extra beside
 * the page already read, so a read of it that fails (search's own rate limit, a 5xx, a timeout) costs the count and not the answer.
 */
export async function searchCountByRepo(
  gh: GithubClient, query: string, firstPage: ReadonlyArray<{ repo?: string }>, total: number,
): Promise<{ byRepo: Record<string, number> } | { unavailable: ByRepoUnavailable }> {
  let repos: Array<string | undefined>;
  if (firstPage.length >= total) {
    repos = firstPage.map((i) => i.repo);
  } else {
    if (total > BY_REPO_MAX) return { unavailable: "too_many" };
    repos = [];
    try {
      for (let page = 1; repos.length < total && page <= Math.ceil(BY_REPO_MAX / 100); page++) {
        const res = (await gh.get<any>("/search/issues", { q: query, sort: "updated", order: "desc", per_page: 100, page })).json;
        if (res?.incomplete_results === true) return { unavailable: "changed" };
        const got = (res?.items ?? []).map((i: any) => repoOfUrl(i.repository_url));
        repos.push(...got);
        if (got.length < 100) break;
      }
    } catch (err) {
      // A GithubError of status 0 is the network's (a dropped connection, a timeout): no status GitHub sent.
      const status = err instanceof GithubError && err.status > 0 ? err.status : null;
      logger.warn({ tool: "issue_search", status, errorClass: (err as Error)?.constructor?.name }, "github_mcp.by_repo_read_failed");
      return { unavailable: { failed: status } };
    }
    // Matches that came or went between the reads: no count is better than a wrong one.
    if (repos.length !== total) return { unavailable: "changed" };
  }
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(r ?? "unknown", (counts.get(r ?? "unknown") ?? 0) + 1);
  return { byRepo: Object.fromEntries([...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) };
}

/** What a search's note says when it has no `by_repo` (fixed words: nothing GitHub sent is repeated). */
export function byRepoNote(why: ByRepoUnavailable): string {
  if (why === "too_many") return `by_repo is not counted for more than ${BY_REPO_MAX} matches: narrow the query with repo: or org: to count one`;
  if (why === "changed") return "by_repo could not be counted: the matches changed while they were read; ask again";
  return `by_repo could not be counted: reading the other matches failed${why.failed !== null ? ` (GitHub answered ${why.failed})` : ""}; `
    + "the matches shown and total_count are as read; ask again for the count";
}

/**
 * A search page's matches as the user names them, `#number` grouped by repository: the repositories in the order of `byRepo` when
 * there is one (most matches first), else by how many of the page each has; within one, in the page's order. What a turn lists when
 * it is asked "how many pull requests do I have open": the count alone was the answer once, without the pull requests it counted
 * (2026-11-06 parity run, G1).
 */
export function refsByRepo(items: ReadonlyArray<{ repo?: string; number?: unknown }>, byRepo: Record<string, number> | null): Record<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const i of items) {
    if (!Number.isSafeInteger(i.number)) continue;
    const repo = i.repo ?? "unknown";
    const list = groups.get(repo) ?? [];
    list.push(`#${i.number as number}`);
    groups.set(repo, list);
  }
  const order = byRepo ? Object.keys(byRepo) : [];
  const rank = (r: string): number => { const k = order.indexOf(r); return k < 0 ? order.length : k; };
  return Object.fromEntries([...groups.entries()].sort((x, y) => rank(x[0]) - rank(y[0]) || y[1].length - x[1].length));
}

/** What starts the failure a read answers for a pull request that does not exist (`missingPullRequest`): the prompt names it. */
export const NO_SUCH_PULL_REQUEST = "no_such_pull_request";

/** How many of a repository's newest pull request numbers a read for one that does not exist lists. */
const NEWEST_LISTED = 5;

/**
 * Why a read of pull request `number` of `r` failed, when the reason is that it does not exist: the repository itself is read first,
 * so a 404 there (no such repository, or a token that cannot see it) keeps GitHub's plain answer; then the number as a pull request
 * and as an issue, and the repository's newest pull requests. Null when it cannot be told (the repository cannot be read, the number
 * is a pull request after all, or a read failed): the caller then answers as it would have. Claw's own words and GitHub's numbers
 * only, so it is a clean failure (`assistant/read-tools.ts`). "may be private" was the answer to #99999 of a repository the user
 * reads every day, with no number to go on (2026-11-06 parity run, H2).
 */
export async function missingPullRequest(gh: GithubClient, r: { owner: string; repo: string }, number: number): Promise<string | null> {
  const name = `${r.owner}/${r.repo}`;
  try {
    if ((await gh.get(repoPath(r), undefined, [404])).status !== 200) return null;
    if ((await gh.get(repoPath(r, `/pulls/${number}`), undefined, [404])).status !== 404) return null;
    const issue = await gh.get<any>(repoPath(r, `/issues/${number}`), undefined, [404, 410]);
    if (issue.status === 200 && issue.json && issue.json.pull_request === undefined) {
      return `${NO_SUCH_PULL_REQUEST}: ${name}#${number} is an issue, not a pull request (the repository is readable, and GitHub answered 404 for pull request #${number})`;
    }
    const newest = ((await gh.get<any[]>(repoPath(r, "/pulls"), { state: "all", sort: "created", direction: "desc", per_page: NEWEST_LISTED })).json ?? [])
      .map((p) => p?.number).filter((n): n is number => Number.isSafeInteger(n));
    const head = `${NO_SUCH_PULL_REQUEST}: ${name} has no pull request #${number} (the repository is readable, and GitHub answered 404 for that number`
      + `${issue.status === 410 ? "; an issue of that number was deleted" : ""})`;
    if (!newest.length) return `${head}; the repository has no pull requests`;
    const listed = newest.map((n) => `#${n}`).join(", ");
    return number > newest[0]
      ? `${head}; its newest pull request is #${newest[0]}, so #${number} is past the last number used (newest: ${listed})`
      : `${head}; its newest pull requests are ${listed}`;
  } catch (err) {
    logger.warn({ status: (err as GithubError)?.status, errorClass: (err as Error)?.constructor?.name }, "github_mcp.missing_pull_check_failed");
    return null;
  }
}

/** A read of one pull request whose failure says plainly that it does not exist, when that is why (`missingPullRequest`). */
async function onePull<T>(gh: GithubClient, r: { owner: string; repo: string }, number: number, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    // GraphQL answers a number that is no pull request with an error (or with none), REST with 404.
    const notFound = err instanceof GithubGraphqlError || (err instanceof GithubError && err.status === 404)
      || (err instanceof BadInput && err.message === NO_PULL_IN_ANSWER);
    const missing = notFound ? await missingPullRequest(gh, r, number) : null;
    if (missing) throw new BadInput(missing);
    throw err;
  }
}

/** What review_threads_list said of a pull request GitHub's GraphQL answered with none. */
const NO_PULL_IN_ANSWER = "no such pull request";

/** A search's qualifiers that name where to search: GitHub refuses some tokens a search that carries one. */
const SCOPED_SEARCH_RE = /(^|\s)-?(repo|org|user):/i;

/**
 * A search narrowed with repo:, org: or user: that GitHub refused (422): fine-grained tokens of another owner are refused such a
 * search even where they read the repository itself. The same pull requests and issues are read by listing the repository. Fixed
 * words: a failed read says nothing GitHub sent (`readFailure`).
 */
const SCOPED_SEARCH_REFUSED = "GitHub answered 422: a search narrowed with repo:, org: or user: is refused for some tokens (a fine-grained "
  + "token of another owner) even where the repository itself can be read. List the repository instead: pr_list with repo, state "
  + "and author for pull requests, issue_list with repo and state for issues; both say how many there are";

/** The most pages of 100 a list reads to filter or order it: past them it says it did not read to the end. */
const MAX_SCAN_PAGES = 5;
/** How far a list in creation order is read for a page asked past the scan: GitHub's own page limit. */
const MAX_LIST_PAGES = 100;
/** How far a list filtered by author, or ordered by when it closed or merged, is read for a page not yet in hand. */
const MAX_DEEP_PAGES = 20;

/**
 * Release-gate fixtures: pull requests a release gate opens against its own fixture branches (`release-gate-fixture/base`, heads under
 * `release-gate-fixture/` or `<name>-e2e-fixture/`), titled "..., do not merge". They are nobody's work, and a "merged" one merged into
 * the fixture branch, not into the project: listed with the rest they were counted as "3 still open" and as merged work (2026-11-07
 * 06:09). Lists and searches leave them out unless asked (`include_fixtures`). A person's own "[do not merge]" pull request is theirs:
 * the title alone excludes only together with the word fixture.
 */
export const FIXTURE_BASE = "release-gate-fixture/base";
const FIXTURE_REF_RE = /^(?:release-gate-fixture|[A-Za-z0-9._-]+-e2e-fixture)\//;

export function isGateFixture(p: Record<string, any>): boolean {
  const refs = [p?.head?.ref, p?.base?.ref].filter((r): r is string => typeof r === "string");
  const title = typeof p?.title === "string" ? p.title : "";
  return refs.some((r) => FIXTURE_REF_RE.test(r)) || (/\bfixture\b/i.test(title) && /\bdo not merge\b/i.test(title));
}

/** The search qualifier that leaves the fixtures out of an issue_search (it leaves issues, which have no base, as they are). */
export const FIXTURE_SEARCH_EXCLUSION = `-base:${FIXTURE_BASE}`;

/** The query issue_search sends: the user's, with the fixtures left out unless asked for or the query already names a base. */
export function searchQueryOf(query: string, includeFixtures: boolean): string {
  if (includeFixtures || /(^|\s)-?base:/i.test(query) || /fixture/i.test(query)) return query;
  return `${query} ${FIXTURE_SEARCH_EXCLUSION}`;
}

const INCLUDE_FIXTURES = z.boolean().optional()
  .describe("true also lists release-gate fixture pull requests (test fixtures, titled \"fixture, do not merge\"); left out by default");
const SINCE = z.string().max(40).optional()
  .describe("An ISO date or time (2026-11-02, or 2026-11-02T00:00:00Z): only those created (open, all), closed (closed) or merged (merged) at or after it, all of them counted; use it for \"this week\" or \"since Monday\"");

const REPO = z.string().describe("The repository, owner/name");
const NUMBER = z.number().int().min(1).describe("The pull request or issue number");
const PER_PAGE = z.number().int().min(1).max(100).optional().describe("Default 50");
const PAGE = z.number().int().min(1).max(100).optional();
const LIST_PER_PAGE = 50;

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    id isResolved isOutdated path line
    comments(first: 20) { nodes { author { login } body createdAt url } }
  } } } }
}`;

/**
 * Called before each tool runs, with its name and arguments as the server parsed them: what it returns is called with how the call
 * ended. Null: the call is not made (it could not be written down), and the model is told so.
 */
export type GithubToolCallHook = (tool: string, args: Record<string, unknown>) =>
  Promise<((result: { isError: boolean; text: string }) => Promise<void>) | null>;

export interface GithubToolDeps {
  gh: GithubClient;
  /** The host of GitHub's own pages (`githubWebHost`): the only one a read lists sources on. Default github.com. */
  webHost?: string;
  /** For the one request that leaves GitHub's API: a job log's download address, which GitHub signs and hands out. */
  fetchImpl?: typeof fetch;
  /** Around every call of every tool, reads and writes alike (mcp.ts: the audit of a call made with a GitHub binding). */
  onCall?: GithubToolCallHook;
}

/**
 * `mcp.tool` with `onCall` around every handler, so no tool registered below (nor one added later) can be called past it. Without a
 * hook it is the server's own.
 */
function registrar(mcp: McpServer, onCall: GithubToolCallHook | undefined): Pick<McpServer, "tool"> {
  if (!onCall) return mcp;
  const tool = (...a: unknown[]): unknown => {
    const name = a[0] as string;
    const handler = a[a.length - 1] as (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;
    a[a.length - 1] = async (args: Record<string, unknown>, extra: unknown): Promise<ToolResult> => {
      const finish = await onCall(name, args ?? {});
      if (!finish) return { content: [{ type: "text", text: "the call could not be recorded, so nothing was done; try again later" }], isError: true };
      let result: ToolResult;
      try {
        result = await handler(args, extra);
      } catch (err) {
        await finish({ isError: true, text: "the call failed" });
        throw err;
      }
      await finish({ isError: result.isError === true, text: result.content[0]?.text ?? "" });
      return result;
    };
    return (mcp.tool as (...b: unknown[]) => unknown).apply(mcp, a);
  };
  return { tool: tool as McpServer["tool"] };
}

/** The last `max` bytes of a body, read as it arrives: a long log is never held whole in this shared process. */
async function tailBytes(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer> {
  const kept: Uint8Array[] = [];
  let size = 0;
  if (body) {
    const reader = body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      kept.push(r.value);
      size += r.value.length;
      while (size > max) {
        const over = size - max;
        if (kept[0].length <= over) size -= kept.shift()!.length;
        else { kept[0] = kept[0].slice(over); size = max; }
      }
    }
  }
  return Buffer.concat(kept, size);
}

export function buildGithubToolServer({ gh, fetchImpl = fetch, webHost = "github.com", onCall }: GithubToolDeps): McpServer {
  const server = new McpServer({ name: "github", version: "1.0.0" });
  const mcp = registrar(server, onCall);
  const host = webHost.toLowerCase();
  const on = (list: Array<CiteSource | null>): CiteSource[] => sourcesOn(host, list);
  const each = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
  const repoName = (input: string): string => { const r = parseRepoRef(input); return r ? `${r.owner}/${r.repo}` : ""; };

  // ---- reads ----
  mcp.tool("repo_get_file", "Read a file, or list a directory, of a repository at a ref (default branch when no ref).", {
    repo: REPO, path: z.string().describe("Path inside the repository; empty or / for the root"), ref: z.string().optional(),
  }, (a) => answer("repo_get_file", async () => {
    const r = repoOf(a.repo);
    const p = a.path.replace(/^\/+|\/+$/g, "");
    const res = await gh.get<any>(repoPath(r, p ? `/contents/${filePath(p)}` : "/contents"), a.ref ? { ref: refOf(a.ref) } : undefined);
    const body = res.json;
    if (Array.isArray(body)) return body.map((e: Record<string, unknown>) => ({ name: e.name, type: e.type, path: e.path, size: e.size }));
    if (!body || body.type !== "file") return { type: body?.type ?? "unknown", path: body?.path };
    if (body.encoding !== "base64" || typeof body.content !== "string") return `[${body.path}: ${body.size} bytes, too large to read through the API]`;
    const bytes = Buffer.from(body.content, "base64");
    if (bytes.includes(0)) return `[${body.path}: binary file, ${bytes.length} bytes]`;
    return bytes.toString("utf8");
  }));

  mcp.tool("repo_list", "List repositories, most recently pushed first: with no owner, the ones the user can reach (their own, ones they collaborate on and their organizations'); with owner, that user's or organization's.", {
    owner: z.string().optional().describe("A user or organization login; leave out for the user's own"), per_page: PER_PAGE, page: PAGE,
  }, (a) => answer("repo_list", async () => {
    const perPage = a.per_page ?? LIST_PER_PAGE;
    const page = a.page ?? 1;
    const q: Record<string, string | number> = { sort: "pushed", per_page: perPage, page };
    let list: any[] | null;
    if (!a.owner) {
      list = (await gh.get<any[]>("/user/repos", q)).json;
    } else {
      if (!isValidOwner(a.owner)) throw new BadInput("owner must be a user or organization login");
      // An organization's list holds the private repositories the user may see; a user's login answers 404 there.
      const org = await gh.get<any[]>(`/orgs/${encodeURIComponent(a.owner)}/repos`, q, [404]);
      list = org.status === 404 ? (await gh.get<any[]>(`/users/${encodeURIComponent(a.owner)}/repos`, q)).json : org.json;
    }
    const items = (list ?? []).map((r) => ({
      repo: r.full_name, private: r.private, archived: r.archived, fork: r.fork, default_branch: r.default_branch,
      description: r.description, url: r.html_url, pushed_at: r.pushed_at, open_issues_and_prs: r.open_issues_count,
    }));
    return pageAnswer(items, perPage, page);
  }, (v) => on(each(v?.items).map((r) => (typeof r.url === "string" ? { url: r.url, title: str(r.repo), kind: "github_repo" as const } : null)))));

  mcp.tool("pr_get", "A pull request: title, state, author, branches, head sha, mergeability, size, description, and once it is merged when (merged_at), by whom and its merge commit.", {
    repo: REPO, number: NUMBER,
  }, (a) => answer("pr_get", async () => {
    const r = repoOf(a.repo);
    return prSummary((await onePull(gh, r, a.number, () => gh.get<any>(repoPath(r, `/pulls/${a.number}`)))).json);
  },
    (v) => on([itemSource(repoName(a.repo), v, true)])));

  mcp.tool("pr_list", "List pull requests of a repository. state open (the default) or all: newest first; closed: most recently closed first; merged: only the merged ones, most recently merged first (use it for \"what merged last\"). author keeps one person's; since keeps a time window and counts all of it (\"what merged this week\": state merged, since the week's first day). Release-gate fixture pull requests are left out unless include_fixtures. Says how many there are (total_count) and whether every one is shown (complete); when complete is false, items are not all of them.", {
    repo: REPO, state: z.enum(["open", "closed", "merged", "all"]).optional(),
    author: z.string().optional().describe("A user login: only the pull requests this person opened"),
    head: z.string().optional().describe("owner:branch"), base: z.string().optional(), since: SINCE, include_fixtures: INCLUDE_FIXTURES,
    per_page: PER_PAGE, page: PAGE,
  }, (a) => answer("pr_list", async () => {
    const r = repoOf(a.repo);
    const state = a.state ?? "open";
    const perPage = a.per_page ?? LIST_PER_PAGE;
    const page = a.page ?? 1;
    if (a.author !== undefined && !isValidOwner(a.author)) throw new BadInput("author must be a user login");
    const since = sinceOf(a.since);
    const filter: Record<string, string> = {};
    if (a.head) filter.head = a.head;
    if (a.base) filter.base = a.base;
    // Read 100 at a time and filtered here (the fixtures, a window, an author): a page of GitHub's own with a fixture taken out of it
    // would count one short, and say nothing of the ones left out.
    return scanPulls(gh, r, filter, state, {
      author: a.author ?? null, includeFixtures: a.include_fixtures === true, since, ...(since !== null ? { sinceText: new Date(since).toISOString() } : {}),
    }, perPage, page);
  }, (v) => on(each(v?.items).map((p) => itemSource(repoName(a.repo), p, true)))));

  mcp.tool("pr_files", "The files a pull request changes, with each file's patch (long patches are cut).", {
    repo: REPO, number: NUMBER, page: PAGE,
  }, (a) => answer("pr_files", async () => {
    const r = repoOf(a.repo);
    const files = (await onePull(gh, r, a.number, () => gh.get<any[]>(repoPath(r, `/pulls/${a.number}/files`), { per_page: 100, page: a.page ?? 1 }))).json ?? [];
    return files.map((f) => ({
      filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
      ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
      patch: typeof f.patch === "string" ? cut(f.patch, MAX_PATCH_CHARS) : undefined,
    }));
  }));

  mcp.tool("pr_diff", "The whole unified diff of a pull request.", { repo: REPO, number: NUMBER }, (a) => answer("pr_diff", async () =>
    (await gh.getText(repoPath(repoOf(a.repo), `/pulls/${a.number}`), "application/vnd.github.diff")).text));

  mcp.tool("pr_reviews", "The reviews of a pull request: who reviewed, their verdict (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED), when, on which commit, and what they wrote.", {
    repo: REPO, number: NUMBER,
  }, (a) => answer("pr_reviews", async () => {
    const r = repoOf(a.repo);
    const reviews = (await onePull(gh, r, a.number, () => gh.get<any[]>(repoPath(r, `/pulls/${a.number}/reviews`), { per_page: 100 }))).json ?? [];
    return reviews.map((r) => ({ id: r.id, author: login(r.user), state: r.state, submitted_at: r.submitted_at, commit: r.commit_id, body: r.body ?? "" }));
  }));

  mcp.tool("checks_list", "The CI of a commit, branch or tag: every check run (its id is the job id job_logs takes; a GitHub Actions job also gives the run_id of its workflow run, which checks_rerun_failed takes) and every commit status.", {
    repo: REPO, ref: z.string().describe("A commit sha (a pull request's head_sha), branch or tag"),
  }, (a) => answer("checks_list", async () => {
    const r = repoOf(a.repo);
    const ref = encodeURIComponent(refOf(a.ref));
    const runs = (await gh.get<any>(repoPath(r, `/commits/${ref}/check-runs`), { per_page: 100 })).json;
    const status = (await gh.get<any>(repoPath(r, `/commits/${ref}/status`))).json;
    return {
      check_runs: (runs?.check_runs ?? []).map((c: any) => ({
        id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, app: c.app?.slug, url: c.details_url,
        ...(actionsRunOf(c) ? { run_id: actionsRunOf(c) } : {}), started_at: c.started_at, completed_at: c.completed_at,
      })),
      combined_state: status?.state,
      statuses: (status?.statuses ?? []).map((s: any) => ({ context: s.context, state: s.state, description: s.description, url: s.target_url })),
    };
  }, (v) => on([
    ...each(v?.check_runs).map((c) => (typeof c.url === "string" ? { url: c.url, title: `${repoName(a.repo)} ${str(c.name)}`.trim(), kind: "github_check" as const } : null)),
    ...each(v?.statuses).map((s) => (typeof s.url === "string" ? { url: s.url, title: `${repoName(a.repo)} ${str(s.context)}`.trim(), kind: "github_check" as const } : null)),
  ])));

  mcp.tool("job_logs", "The end of a GitHub Actions job's log (the id of its check run).", {
    repo: REPO, job_id: z.number().int().min(1), tail_lines: z.number().int().min(1).max(2000).optional().describe("Default 200"),
  }, (a) => answer("job_logs", async () => {
    const res = await gh.request("GET", repoPath(repoOf(a.repo), `/actions/jobs/${a.job_id}/logs`), { allow: [302], redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    let text = res.text;
    if (res.status === 302) {
      if (!location.startsWith("https://")) throw new BadInput("GitHub gave no download address for this log");
      // A signed, short-lived address: no credential is sent with it.
      const log = await fetchImpl(location, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
      if (!log.ok) throw new BadInput(`the log download answered ${log.status}`);
      text = (await tailBytes(log.body, MAX_LOG_BYTES)).toString("utf8");
    }
    const lines = text.split("\n");
    const n = a.tail_lines ?? 200;
    return (lines.length > n ? `[${lines.length - n} earlier lines not shown]\n` : "") + lines.slice(-n).join("\n");
  }));

  mcp.tool("issue_get", "An issue (or a pull request's conversation): its description and its latest comments.", {
    repo: REPO, number: NUMBER,
  }, (a) => answer("issue_get", async () => {
    const r = repoOf(a.repo);
    const issue = (await gh.get<any>(repoPath(r, `/issues/${a.number}`))).json;
    const comments = (await gh.get<any[]>(repoPath(r, `/issues/${a.number}/comments`), { per_page: 100 })).json ?? [];
    return {
      ...issueSummary(issue), body: issue?.body ?? "",
      latest_comments: comments.slice(-30).map((c) => ({ id: c.id, author: login(c.user), created_at: c.created_at, url: c.html_url, body: c.body })),
    };
  }, (v) => on([itemSource(repoName(a.repo), v)])));

  mcp.tool("issue_list", "List issues of a repository (pull requests are included and marked), most recently created first. Says how many there are when the list ends on this page (total_count) and whether every one is shown (complete).", {
    repo: REPO, state: z.enum(["open", "closed", "all"]).optional(), labels: z.string().optional().describe("Comma-separated label names"),
    per_page: PER_PAGE, page: PAGE,
  }, (a) => answer("issue_list", async () => {
    const perPage = a.per_page ?? LIST_PER_PAGE;
    const page = a.page ?? 1;
    const q: Record<string, string | number> = { state: a.state ?? "open", per_page: perPage, page };
    if (a.labels) q.labels = a.labels;
    return pageAnswer(((await gh.get<any[]>(repoPath(repoOf(a.repo), "/issues"), q)).json ?? []).map(issueLine), perPage, page);
  }, (v) => on(each(v?.items).map((i) => itemSource(repoName(a.repo), i)))));

  mcp.tool("issue_search", "Search pull requests and issues across GitHub, as the user, with GitHub's search syntax: `is:pr is:open author:@me` (the user's open pull requests), `is:pr is:open review-requested:@me`, `is:issue is:open assignee:@me`; narrow with `repo:owner/name` or `org:name` (some tokens are refused such a search: then list the repository with pr_list or issue_list). Returns the total count (total_count), how many are in each repository (by_repo, up to " + BY_REPO_MAX + " matches), the matches, most recently updated first, and whether every match is shown (complete); list them all from `items`, and count from total_count and by_repo.", {
    query: z.string().min(1).max(256).describe("GitHub search syntax; @me is the user"),
    sort: z.enum(["updated", "created", "comments"]).optional().describe("Default updated"), include_fixtures: INCLUDE_FIXTURES,
    per_page: PER_PAGE, page: PAGE,
  }, (a) => answer("issue_search", async () => {
    const perPage = a.per_page ?? LIST_PER_PAGE;
    const page = a.page ?? 1;
    // The release-gate fixtures are left out by GitHub's search itself, so total_count and by_repo count without them.
    const query = searchQueryOf(a.query, a.include_fixtures === true);
    let res: any;
    try {
      res = (await gh.get<any>("/search/issues", { q: query, sort: a.sort ?? "updated", order: "desc", per_page: perPage, page })).json;
    } catch (err) {
      if (err instanceof GithubError && err.status === 422 && SCOPED_SEARCH_RE.test(a.query)) {
        logger.warn({ tool: "issue_search", status: err.status, requestId: err.requestId }, "github_mcp.scoped_search_refused");
        throw new BadInput(SCOPED_SEARCH_REFUSED);
      }
      throw err;
    }
    const items = (res?.items ?? []).map((i: any) => ({ repo: repoOfUrl(i.repository_url), ...issueLine(i), ...(i.pull_request ? { draft: i.draft === true } : {}) }));
    const total = typeof res?.total_count === "number" ? res.total_count : null;
    const seen = (page - 1) * perPage + items.length;
    // A search GitHub cut short may report a low total_count, so a page that seems to hold every match may not: no by_repo then.
    const incomplete = res?.incomplete_results === true;
    const counted = page === 1 && total !== null && !incomplete ? await searchCountByRepo(gh, query, items, total) : null;
    const byRepo = counted && "byRepo" in counted ? counted.byRepo : null;
    const notes = [
      ...(incomplete ? ["GitHub's search timed out before it found every match: total_count may be low"] : []),
      ...(page === 1 && total !== null && incomplete ? ["by_repo is not counted for a search that timed out; ask again"] : []),
      ...(counted && "unavailable" in counted ? [byRepoNote(counted.unavailable)] : []),
    ];
    return listAnswer(items, {
      total_count: total,
      complete: page === 1 && total !== null && items.length >= total && !incomplete,
      next_page: total !== null && seen < total && items.length === perPage ? page + 1 : null,
      page, count_exact: !incomplete,
      ...(byRepo ? { by_repo: byRepo } : {}),
      refs_by_repo: refsByRepo(items, byRepo),
      ...(query !== a.query ? { fixtures_excluded: `release-gate fixture pull requests (base ${FIXTURE_BASE}) are left out of the search and its counts; include_fixtures: true counts them` } : {}),
      ...(notes.length ? { note: notes.join("; ") } : {}),
    });
  }, (v) => on(each(v?.items).map((i) => itemSource(typeof i.repo === "string" ? i.repo : undefined, i)))));

  mcp.tool("review_threads_list", "The review threads of a pull request: id (for review_thread_reply / review_thread_resolve), resolved or not, file, line and comments.", {
    repo: REPO, number: NUMBER,
  }, (a) => answer("review_threads_list", async () => {
    const r = repoOf(a.repo);
    const pr = await onePull(gh, r, a.number, async () => {
      const found = (await gh.graphql<any>(THREADS_QUERY, { owner: r.owner, repo: r.repo, number: a.number }))?.repository?.pullRequest;
      if (!found) throw new BadInput(NO_PULL_IN_ANSWER);
      return found;
    });
    return (pr.reviewThreads?.nodes ?? []).map((t: any) => ({
      id: t.id, resolved: t.isResolved, outdated: t.isOutdated, path: t.path, line: t.line,
      comments: (t.comments?.nodes ?? []).map((c: any) => ({ author: login(c.author), created_at: c.createdAt, url: c.url, body: c.body })),
    }));
  }));

  mcp.tool("code_search", "Search code on GitHub (GitHub's code search syntax, e.g. `foo repo:owner/name path:src`).", {
    query: z.string().min(1).max(256), per_page: PER_PAGE, page: PAGE,
  }, (a) => answer("code_search", async () => {
    const perPage = a.per_page ?? LIST_PER_PAGE;
    const page = a.page ?? 1;
    const res = (await gh.get<any>("/search/code", { q: a.query, per_page: perPage, page })).json;
    const items = (res?.items ?? []).map((i: any) => ({ repo: i.repository?.full_name, path: i.path, url: i.html_url }));
    const total = typeof res?.total_count === "number" ? res.total_count : null;
    return listAnswer(items, {
      total_count: total,
      complete: page === 1 && total !== null && items.length >= total,
      next_page: total !== null && (page - 1) * perPage + items.length < total && items.length === perPage ? page + 1 : null,
    });
  }, (v) => on(each(v?.items).map((i) => (typeof i.url === "string" ? { url: i.url, title: `${str(i.repo)} ${str(i.path)}`.trim(), kind: "github_file" as const } : null)))));

  // ---- writes: each waits for the user's decision ----
  mcp.tool("issue_comment", "Post a comment on an issue or a pull request's conversation. Waits for the user's approval.", {
    repo: REPO, number: NUMBER, body: z.string().min(1).max(COMMENT_MAX),
  }, (a) => answer("issue_comment", async () => {
    const c = (await gh.request<any>("POST", repoPath(repoOf(a.repo), `/issues/${a.number}/comments`), { body: { body: marked(a.body) } })).json;
    return { id: c?.id, url: c?.html_url };
  }));

  mcp.tool("issue_create", "Open an issue. Waits for the user's approval.", {
    repo: REPO, title: z.string().min(1).max(256), body: z.string().max(65_536).optional(), labels: z.array(z.string()).max(20).optional(),
  }, (a) => answer("issue_create", async () => {
    const i = (await gh.request<any>("POST", repoPath(repoOf(a.repo), "/issues"), {
      body: { title: a.title, ...(a.body !== undefined ? { body: a.body } : {}), ...(a.labels ? { labels: a.labels } : {}) },
    })).json;
    return { number: i?.number, url: i?.html_url };
  }));

  mcp.tool("pr_create", "Open a pull request from a branch that is already pushed. Waits for the user's approval.", {
    repo: REPO, head: z.string().min(1).describe("The branch with the changes (owner:branch for a fork)"), base: z.string().min(1),
    title: z.string().min(1).max(256), body: z.string().max(65_536).optional(), draft: z.boolean().optional(),
  }, (a) => answer("pr_create", async () => {
    const p = (await gh.request<any>("POST", repoPath(repoOf(a.repo), "/pulls"), {
      body: { head: a.head, base: a.base, title: a.title, ...(a.body !== undefined ? { body: a.body } : {}), ...(a.draft !== undefined ? { draft: a.draft } : {}) },
    })).json;
    return { number: p?.number, url: p?.html_url, head_sha: p?.head?.sha };
  }));

  mcp.tool("pr_update", "Change a pull request's title, description, base branch, or close / reopen it. Waits for the user's approval.", {
    repo: REPO, number: NUMBER, title: z.string().min(1).max(256).optional(), body: z.string().max(65_536).optional(),
    base: z.string().min(1).optional(), state: z.enum(["open", "closed"]).optional(),
  }, (a) => answer("pr_update", async () => {
    const patch: Record<string, unknown> = {};
    for (const k of ["title", "body", "base", "state"] as const) if (a[k] !== undefined) patch[k] = a[k];
    if (Object.keys(patch).length === 0) throw new BadInput("nothing to change");
    return prSummary((await gh.request<any>("PATCH", repoPath(repoOf(a.repo), `/pulls/${a.number}`), { body: patch })).json);
  }));

  mcp.tool("review_thread_reply", "Reply in a review thread (its id from review_threads_list). Waits for the user's approval.", {
    thread_id: z.string().min(1).max(200), body: z.string().min(1).max(COMMENT_MAX),
  }, (a) => answer("review_thread_reply", async () => {
    const data = await gh.graphql<any>(
      "mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { url } } }",
      { id: a.thread_id, body: marked(a.body) },
    );
    return { url: data?.addPullRequestReviewThreadReply?.comment?.url };
  }));

  mcp.tool("review_thread_resolve", "Mark a review thread resolved (its id from review_threads_list). Waits for the user's approval.", {
    thread_id: z.string().min(1).max(200),
  }, (a) => answer("review_thread_resolve", async () => {
    const data = await gh.graphql<any>(
      "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }", { id: a.thread_id },
    );
    return { id: data?.resolveReviewThread?.thread?.id, resolved: data?.resolveReviewThread?.thread?.isResolved };
  }));

  mcp.tool("checks_rerun_failed", "Run again the failed jobs of a GitHub Actions workflow run, and the jobs that depend on them (its run_id from checks_list). Waits for the user's approval.", {
    repo: REPO, run_id: z.number().int().min(1).describe("The workflow run: run_id of a check run in checks_list"),
  }, (a) => answer("checks_rerun_failed", async () => {
    await gh.request("POST", repoPath(repoOf(a.repo), `/actions/runs/${a.run_id}/rerun-failed-jobs`), { body: {} });
    return { run_id: a.run_id, rerun: "the failed jobs and the jobs that depend on them" };
  }));

  mcp.tool("pr_request_reviewers", "Ask people (logins) or teams (slugs of the repository's organization) to review a pull request. Waits for the user's approval.", {
    repo: REPO, number: NUMBER,
    reviewers: z.array(z.string().min(1).max(39)).max(15).optional().describe("User logins"),
    team_reviewers: z.array(z.string().min(1).max(100)).max(15).optional().describe("Team slugs"),
  }, (a) => answer("pr_request_reviewers", async () => {
    const reviewers = a.reviewers ?? [];
    const teams = a.team_reviewers ?? [];
    if (!reviewers.length && !teams.length) throw new BadInput("name at least one reviewer or team");
    if (!reviewers.every(isValidOwner)) throw new BadInput("reviewers must be user logins");
    const p = (await gh.request<any>("POST", repoPath(repoOf(a.repo), `/pulls/${a.number}/requested_reviewers`), {
      body: { ...(reviewers.length ? { reviewers } : {}), ...(teams.length ? { team_reviewers: teams } : {}) },
    })).json;
    return {
      number: p?.number, url: p?.html_url,
      requested_reviewers: Array.isArray(p?.requested_reviewers) ? p.requested_reviewers.map(login) : undefined,
      requested_teams: Array.isArray(p?.requested_teams) ? p.requested_teams.map((t: { slug?: string }) => t.slug) : undefined,
    };
  }));

  mcp.tool("labels_set", "Set the labels of an issue or pull request to exactly this list: labels not in it are taken off, and an empty list takes every label off. Waits for the user's approval.", {
    repo: REPO, number: NUMBER, labels: z.array(z.string().min(1).max(100)).max(100).describe("The whole list of labels it should carry"),
  }, (a) => answer("labels_set", async () => {
    const set = (await gh.request<any[]>("PUT", repoPath(repoOf(a.repo), `/issues/${a.number}/labels`), { body: { labels: a.labels } })).json ?? [];
    return { number: a.number, labels: set.map((l: { name?: string }) => l.name) };
  }));

  return server;
}
