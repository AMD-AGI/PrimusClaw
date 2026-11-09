// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where the pull requests a review request names stand on GitHub (open, merged, closed), read as the person who asks: by the router's
 * `pr_state` before it starts anything, and again by `review_start` before a review of them is started or handed to someone else
 * (`review-tools.ts`, `reviewStart`).
 *
 * A request to review and merge pull requests that were merged already was answered with a question about the reviewer, twice in real
 * use (Yihan stopped those reviews by hand) and once in the parity run of 2026-11-06 (G3): nothing looked at the pull requests. Then
 * review_start looked first and refused a merged one, but the request still went out as a write the platform refused (parity G3,
 * 2026-11-07, scored as a review started). Now the router reads the state with `pr_state`, which only reads, and answers a merged or
 * closed pull request itself; review_start's own check stays behind it.
 *
 * Read with the person's own GitHub (their `GH_TOKEN`, else the account they bound, as the router's GitHub reads are), and a read with
 * a binding is written to GitHub review's audit log first, as every such read is (`github-mcp/mcp.ts`). A person with no GitHub here
 * is read for as anyone on the internet is: only a public repository answers. Best effort: a read that fails, or an audit row that
 * cannot be written, is `unknown` and leaves the request as it was before this check, never refused for it.
 *
 * GitHub's REST API gives a reader with no credential 60 requests an hour per IP, and every pod of a cluster leaves through the same
 * address: on 2026-11-09 the API pods' anonymous quota read 0 of 60 and every `pr_state` of a person with no GitHub here was a 403,
 * so merged pull requests were offered for review again and "#99999" was "could not be read" rather than "does not exist" (parity
 * G3, H2). Such a read that GitHub refuses as over its limit (403 or 429) reads the pull request's public page on github.com instead
 * (`pageState`), which anyone can open and which the REST limit does not count.
 */
import pino from "pino";
import { db as defaultDb } from "../infra/db.js";
import { resolveGithubToken, type ResolveBinding } from "../github-mcp/mcp.js";
import { readGithubMcpSettings, type GithubMcpSettings } from "../github-mcp/settings.js";
import { GithubClient, repoPath, type PrRef } from "../github-review/github.js";
import { auditFinish, auditStart, GITHUB_MCP_AUDIT_TOOL_PREFIX, type Queryable } from "../github-review/store.js";

const logger = pino({ name: "assistant-pr-state" });

/** The audit row's tool and the identity provider's purpose for this read. */
export const PR_STATE_TOOL = "review_start_pr_state";
/** One read of a pull request may take this long; the whole check, as long as its slowest read. */
const READ_TIMEOUT_MS = 5_000;
/** Pull requests read at once. */
const READ_PARALLEL = 10;

/** A pull request GitHub says is merged: when, and its merge commit. Not by whom: a login is text an account chose. */
export interface MergedPull {
  pr: string;
  merged_at: string;
  merge_commit: string | null;
}

/** A pull request GitHub says was closed without being merged: when. */
export interface ClosedPull {
  pr: string;
  closed_at: string | null;
}

/**
 * Where a pull request stands on GitHub, as `pr_state` answers the router: `open`, `merged` (with when and its merge commit),
 * `closed` (closed without a merge, with when), `not_found` (GitHub read the repository and has no pull request of that number) or
 * `unknown` (it could not be read: no GitHub, a failed read, or a repository that cannot be read either). Only these fields, each checked for its shape (a time, a commit id): nothing anyone wrote or chose on GitHub (a title, a
 * description, a login), so reading it is not reading untrusted text, and a turn that read it may still act for the person.
 */
export type PullState =
  | { pr: string; state: "open"; draft: boolean }
  | ({ state: "merged" } & MergedPull)
  | ({ state: "closed" } & ClosedPull)
  | { pr: string; state: "not_found" }
  | { pr: string; state: "unknown"; reason: "no_github" | "read_failed" };

export interface PrStateDeps {
  db?: Queryable;
  settings?: () => GithubMcpSettings;
  resolveBinding?: ResolveBinding;
  fetchImpl?: typeof fetch;
  /** Where the pull requests' public pages are (`https://github.com`); by default derived from the API's address. */
  webUrl?: string | null;
}

const nameOf = (p: PrRef): string => `${p.owner}/${p.repo}#${p.number}`;
/** A GitHub timestamp (`2026-11-06T09:50:16Z`), or null: nothing else is passed on as a time. */
const time = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v) ? v : null);
/** A commit id (hex, SHA-1 or SHA-256), or null. */
const commit = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(v) ? v : null);

/** What one pull request's JSON says about where it stands. */
function stateOf(p: PrRef, pr: Record<string, any> | null | undefined): PullState {
  const name = nameOf(p);
  if (!pr || typeof pr !== "object") return { pr: name, state: "unknown", reason: "read_failed" };
  const mergedAt = time(pr.merged_at);
  if (mergedAt) return { pr: name, state: "merged", merged_at: mergedAt, merge_commit: commit(pr.merge_commit_sha) };
  if (pr.state === "closed" && pr.merged !== true) return { pr: name, state: "closed", closed_at: time(pr.closed_at) };
  if (pr.state === "open") return { pr: name, state: "open", draft: pr.draft === true };
  return { pr: name, state: "unknown", reason: "read_failed" };
}

/**
 * Reads a pull request with no credential at all, for a person who has no GitHub here: only a public repository answers it, and what it
 * answers is what anyone on the internet can read. Nothing of the person's is sent, so there is nothing to audit.
 */
function anonymousReader(apiUrl: string, fetchImpl: typeof fetch): (path: string) => Promise<Record<string, any>> {
  return async (path) => {
    const res = await fetchImpl(new URL(apiUrl + path), {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "primus-claw-assistant" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status}`), { status: res.status });
    return await res.json() as Record<string, any>;
  };
}

/** The public web address of the GitHub whose API is `apiUrl` (`https://api.github.com` -> `https://github.com`), or null. */
export function githubWebUrl(apiUrl: string): string | null {
  try {
    const u = new URL(apiUrl);
    if (u.protocol === "https:" && u.hostname === "api.github.com") return "https://github.com";
    if (u.protocol === "https:" && /^\/api\/v3\/?$/.test(u.pathname)) return `https://${u.host}`;
  } catch { /* not an address */ }
  return null;
}

/** The longest page read (a pull request's page is about 400 kB). */
const PAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Where a public pull request stands, read from its page on github.com with no credential, for when the REST API refuses a reader with
 * none as over its limit. Only the page's own data about this pull request is used (`payload.pullRequestsLayoutRoute.pullRequest` of
 * its `react-app.embeddedData`, the same number), each field checked for its shape as the API's are; a number that is not a pull
 * request redirects to the repository's issue of that number, so the repository was read and it is `not_found`. Anything else,
 * including a page whose layout changed, is `unknown`.
 */
async function pageState(webUrl: string, p: PrRef, fetchImpl: typeof fetch): Promise<PullState> {
  const name = nameOf(p);
  const failed: PullState = { pr: name, state: "unknown", reason: "read_failed" };
  const base = `${webUrl}/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}`;
  const res = await fetchImpl(new URL(`${base}/pull/${p.number}`), {
    headers: { Accept: "text/html", "User-Agent": "primus-claw-assistant" },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location");
    try {
      if (to && new URL(to, base).href === `${base}/issues/${p.number}`) return { pr: name, state: "not_found" };
    } catch { /* a location that is not an address */ }
    return failed;
  }
  if (!res.ok) return failed;
  const html = await res.text();
  if (html.length > PAGE_MAX_BYTES) return failed;
  const m = /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return failed;
  let pr: Record<string, unknown> | undefined;
  try {
    pr = (JSON.parse(m[1]!) as any)?.payload?.pullRequestsLayoutRoute?.pullRequest;
  } catch {
    return failed;
  }
  if (!pr || typeof pr !== "object" || pr.number !== p.number) return failed;
  switch (pr.state) {
    case "MERGED": {
      const mergedAt = time(pr.mergedTime);
      return mergedAt ? { pr: name, state: "merged", merged_at: mergedAt, merge_commit: commit(pr.mergeCommitSha) } : failed;
    }
    case "CLOSED": return { pr: name, state: "closed", closed_at: time(pr.closedTime) };
    case "OPEN": return { pr: name, state: "open", draft: false };
    case "DRAFT": return { pr: name, state: "open", draft: true };
    default: return failed;
  }
}

/**
 * Where each of `prs` stands on GitHub, in their order, as `userId` reads them: with their own GitHub (their `GH_TOKEN`, else the
 * account they bound), and with none, as anyone reads a public repository. Never throws: what cannot be read is `unknown`.
 */
export async function pullStates(userId: string, sessionId: string, prs: readonly PrRef[], deps: PrStateDeps = {}): Promise<PullState[]> {
  const q = deps.db ?? defaultDb;
  const s = (deps.settings ?? (() => readGithubMcpSettings()))();
  const unknown = (reason: "no_github" | "read_failed"): PullState[] => prs.map((p) => ({ pr: nameOf(p), state: "unknown", reason }));
  // The GitHub tools off: the router reads no GitHub, and neither does this.
  if (!prs.length) return [];
  if (!s.enabled) return unknown("no_github");
  let read: (path: string) => Promise<Record<string, any>>;
  let gh: GithubClient | null = null;
  let audit: { id: number } | null = null;
  // Set when the person has no GitHub here: a REST read refused as over the anonymous limit falls back to the public page.
  let pageFallback: ((p: PrRef) => Promise<PullState>) | null = null;
  try {
    const cred = await resolveGithubToken(q, userId, { binding: s.binding, purpose: `github_mcp:${PR_STATE_TOOL}`, resolve: deps.resolveBinding });
    if (cred.token === null) {
      read = anonymousReader(s.apiUrl, deps.fetchImpl ?? fetch);
      const webUrl = deps.webUrl === undefined ? githubWebUrl(s.apiUrl) : deps.webUrl;
      if (webUrl) pageFallback = (p) => pageState(webUrl, p, deps.fetchImpl ?? fetch);
    } else {
      const client = new GithubClient({ token: cred.token, apiUrl: s.apiUrl, timeoutMs: READ_TIMEOUT_MS, fetchImpl: deps.fetchImpl });
      gh = client;
      read = async (path) => (await client.get<Record<string, any>>(path)).json;
      if (cred.source === "binding") {
        audit = {
          id: await auditStart(q, {
            requesterUserId: userId, actorUserId: userId, sessionId, tool: `${GITHUB_MCP_AUDIT_TOOL_PREFIX}${PR_STATE_TOOL}`,
            args: { prs: prs.map(nameOf).slice(0, 30) },
          }),
        };
      }
    }
  } catch (err) {
    logger.warn({ sessionId, errorClass: (err as Error)?.constructor?.name, code: (err as { code?: string })?.code ?? "" }, "assistant.pr_state_unavailable");
    return unknown("read_failed");
  }
  const states: PullState[] = [];
  let failed = 0;
  // GitHub answers 404 both for a number the repository has no pull request of and for a repository the reader cannot see: the
  // repository is read once (per repository) to tell them apart, so only a number missing from a repository that was read is
  // `not_found` (2026-11-08 E249: "#99999" was said to be "could not be read" rather than "does not exist").
  const repoSeen = new Map<string, Promise<boolean>>();
  const repoReadable = (p: PrRef): Promise<boolean> => {
    const key = `${p.owner}/${p.repo}`.toLowerCase();
    let seen = repoSeen.get(key);
    if (!seen) {
      seen = read(repoPath(p)).then((r) => Boolean(r && typeof r === "object"), () => false);
      repoSeen.set(key, seen);
    }
    return seen;
  };
  for (let i = 0; i < prs.length; i += READ_PARALLEL) {
    states.push(...await Promise.all(prs.slice(i, i + READ_PARALLEL).map(async (p): Promise<PullState> => {
      try {
        return stateOf(p, await read(repoPath(p, `/pulls/${p.number}`)));
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 404 && await repoReadable(p)) return { pr: nameOf(p), state: "not_found" };
        if (pageFallback && (status === 403 || status === 429)) {
          const fromPage = await pageFallback(p).catch((): PullState => ({ pr: nameOf(p), state: "unknown", reason: "read_failed" }));
          logger.info({ sessionId, pr: nameOf(p), status, state: fromPage.state }, "assistant.pr_state_read_from_page");
          if (fromPage.state !== "unknown") return fromPage;
        }
        failed++;
        logger.warn({ sessionId, pr: nameOf(p), status }, "assistant.pr_state_read_failed");
        return { pr: nameOf(p), state: "unknown", reason: "read_failed" };
      }
    })));
  }
  if (audit && gh) {
    try {
      await auditFinish(q, audit.id, {
        githubRequests: gh.requests, githubRequestIds: gh.requestIds, githubStatus: gh.lastStatus || undefined, dryRun: false, write: false,
        result: failed ? "refused" : "ok", detail: failed ? `${failed} of ${prs.length} reads failed` : "",
      });
    } catch { /* the row was written before the reads; one left unfinished reads as unfinished */ }
  }
  return states;
}

/** Of `prs`, the ones GitHub says are merged, in their order, as `userId` reads them. Never throws. */
export async function mergedPulls(userId: string, sessionId: string, prs: readonly PrRef[], deps: PrStateDeps = {}): Promise<MergedPull[]> {
  return (await pullStates(userId, sessionId, prs, deps))
    .filter((s): s is Extract<PullState, { state: "merged" }> => s.state === "merged")
    .map(({ state: _state, ...m }) => m);
}
