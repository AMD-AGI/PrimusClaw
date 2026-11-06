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
import { CITE_SOURCES_META, type CiteSource } from "@claw/protocol";
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
    created_at: p.created_at, updated_at: p.updated_at, body: p.body ?? "",
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

const REPO = z.string().describe("The repository, owner/name");
const NUMBER = z.number().int().min(1).describe("The pull request or issue number");
const PER_PAGE = z.number().int().min(1).max(50).optional().describe("Default 20");
const PAGE = z.number().int().min(1).max(100).optional();

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes {
    id isResolved isOutdated path line
    comments(first: 20) { nodes { author { login } body createdAt url } }
  } } } }
}`;

export interface GithubToolDeps {
  gh: GithubClient;
  /** The host of GitHub's own pages (`githubWebHost`): the only one a read lists sources on. Default github.com. */
  webHost?: string;
  /** For the one request that leaves GitHub's API: a job log's download address, which GitHub signs and hands out. */
  fetchImpl?: typeof fetch;
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

export function buildGithubToolServer({ gh, fetchImpl = fetch, webHost = "github.com" }: GithubToolDeps): McpServer {
  const mcp = new McpServer({ name: "github", version: "1.0.0" });
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
    const q: Record<string, string | number> = { sort: "pushed", per_page: a.per_page ?? 20, page: a.page ?? 1 };
    let list: any[] | null;
    if (!a.owner) {
      list = (await gh.get<any[]>("/user/repos", q)).json;
    } else {
      if (!isValidOwner(a.owner)) throw new BadInput("owner must be a user or organization login");
      // An organization's list holds the private repositories the user may see; a user's login answers 404 there.
      const org = await gh.get<any[]>(`/orgs/${encodeURIComponent(a.owner)}/repos`, q, [404]);
      list = org.status === 404 ? (await gh.get<any[]>(`/users/${encodeURIComponent(a.owner)}/repos`, q)).json : org.json;
    }
    return (list ?? []).map((r) => ({
      repo: r.full_name, private: r.private, archived: r.archived, fork: r.fork, default_branch: r.default_branch,
      description: r.description, url: r.html_url, pushed_at: r.pushed_at, open_issues_and_prs: r.open_issues_count,
    }));
  }, (v) => on(each(v).map((r) => (typeof r.url === "string" ? { url: r.url, title: str(r.repo), kind: "github_repo" as const } : null)))));

  mcp.tool("pr_get", "A pull request: title, state, author, branches, head sha, mergeability, size and description.", {
    repo: REPO, number: NUMBER,
  }, (a) => answer("pr_get", async () => prSummary((await gh.get<any>(repoPath(repoOf(a.repo), `/pulls/${a.number}`))).json),
    (v) => on([itemSource(repoName(a.repo), v, true)])));

  mcp.tool("pr_list", "List pull requests of a repository, newest first.", {
    repo: REPO, state: z.enum(["open", "closed", "all"]).optional(), head: z.string().optional().describe("owner:branch"),
    base: z.string().optional(), per_page: PER_PAGE, page: PAGE,
  }, (a) => answer("pr_list", async () => {
    const q: Record<string, string | number> = { state: a.state ?? "open", per_page: a.per_page ?? 20, page: a.page ?? 1 };
    if (a.head) q.head = a.head;
    if (a.base) q.base = a.base;
    const list = (await gh.get<any[]>(repoPath(repoOf(a.repo), "/pulls"), q)).json ?? [];
    return list.map((p) => { const { body: _b, ...rest } = prSummary(p); return rest; });
  }, (v) => on(each(v).map((p) => itemSource(repoName(a.repo), p, true)))));

  mcp.tool("pr_files", "The files a pull request changes, with each file's patch (long patches are cut).", {
    repo: REPO, number: NUMBER, page: PAGE,
  }, (a) => answer("pr_files", async () => {
    const files = (await gh.get<any[]>(repoPath(repoOf(a.repo), `/pulls/${a.number}/files`), { per_page: 100, page: a.page ?? 1 })).json ?? [];
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
    const reviews = (await gh.get<any[]>(repoPath(repoOf(a.repo), `/pulls/${a.number}/reviews`), { per_page: 100 })).json ?? [];
    return reviews.map((r) => ({ id: r.id, author: login(r.user), state: r.state, submitted_at: r.submitted_at, commit: r.commit_id, body: r.body ?? "" }));
  }));

  mcp.tool("checks_list", "The CI of a commit, branch or tag: every check run (its id is the job id job_logs takes) and every commit status.", {
    repo: REPO, ref: z.string().describe("A commit sha (a pull request's head_sha), branch or tag"),
  }, (a) => answer("checks_list", async () => {
    const r = repoOf(a.repo);
    const ref = encodeURIComponent(refOf(a.ref));
    const runs = (await gh.get<any>(repoPath(r, `/commits/${ref}/check-runs`), { per_page: 100 })).json;
    const status = (await gh.get<any>(repoPath(r, `/commits/${ref}/status`))).json;
    return {
      check_runs: (runs?.check_runs ?? []).map((c: any) => ({
        id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, app: c.app?.slug, url: c.details_url,
        started_at: c.started_at, completed_at: c.completed_at,
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

  mcp.tool("issue_list", "List issues of a repository (pull requests are included and marked).", {
    repo: REPO, state: z.enum(["open", "closed", "all"]).optional(), labels: z.string().optional().describe("Comma-separated label names"),
    per_page: PER_PAGE, page: PAGE,
  }, (a) => answer("issue_list", async () => {
    const q: Record<string, string | number> = { state: a.state ?? "open", per_page: a.per_page ?? 20, page: a.page ?? 1 };
    if (a.labels) q.labels = a.labels;
    return ((await gh.get<any[]>(repoPath(repoOf(a.repo), "/issues"), q)).json ?? []).map(issueSummary);
  }, (v) => on(each(v).map((i) => itemSource(repoName(a.repo), i)))));

  mcp.tool("issue_search", "Search pull requests and issues across GitHub, as the user, with GitHub's search syntax: `is:pr is:open author:@me` (the user's open pull requests), `is:pr is:open review-requested:@me`, `is:issue is:open assignee:@me`; narrow with `repo:owner/name` or `org:name`. Returns the total count and the matches, most recently updated first.", {
    query: z.string().min(1).max(256).describe("GitHub search syntax; @me is the user"),
    sort: z.enum(["updated", "created", "comments"]).optional().describe("Default updated"), per_page: PER_PAGE, page: PAGE,
  }, (a) => answer("issue_search", async () => {
    const res = (await gh.get<any>("/search/issues", { q: a.query, sort: a.sort ?? "updated", order: "desc", per_page: a.per_page ?? 20, page: a.page ?? 1 })).json;
    return {
      total_count: res?.total_count, incomplete_results: res?.incomplete_results,
      items: (res?.items ?? []).map((i: any) => ({ repo: repoOfUrl(i.repository_url), ...issueSummary(i), ...(i.pull_request ? { draft: i.draft === true } : {}) })),
    };
  }, (v) => on(each(v?.items).map((i) => itemSource(typeof i.repo === "string" ? i.repo : undefined, i)))));

  mcp.tool("review_threads_list", "The review threads of a pull request: id (for review_thread_reply / review_thread_resolve), resolved or not, file, line and comments.", {
    repo: REPO, number: NUMBER,
  }, (a) => answer("review_threads_list", async () => {
    const r = repoOf(a.repo);
    const data = await gh.graphql<any>(THREADS_QUERY, { owner: r.owner, repo: r.repo, number: a.number });
    const pr = data?.repository?.pullRequest;
    if (!pr) throw new BadInput("no such pull request");
    return (pr.reviewThreads?.nodes ?? []).map((t: any) => ({
      id: t.id, resolved: t.isResolved, outdated: t.isOutdated, path: t.path, line: t.line,
      comments: (t.comments?.nodes ?? []).map((c: any) => ({ author: login(c.author), created_at: c.createdAt, url: c.url, body: c.body })),
    }));
  }));

  mcp.tool("code_search", "Search code on GitHub (GitHub's code search syntax, e.g. `foo repo:owner/name path:src`).", {
    query: z.string().min(1).max(256), per_page: PER_PAGE, page: PAGE,
  }, (a) => answer("code_search", async () => {
    const res = (await gh.get<any>("/search/code", { q: a.query, per_page: a.per_page ?? 20, page: a.page ?? 1 })).json;
    return {
      total_count: res?.total_count,
      items: (res?.items ?? []).map((i: any) => ({ repo: i.repository?.full_name, path: i.path, url: i.html_url })),
    };
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

  return mcp;
}
