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

/** A pull request GitHub says is merged: when, by whom, and its merge commit. */
export interface MergedPull {
  pr: string;
  merged_at: string;
  merge_commit: string | null;
  merged_by: string | null;
}

/** A pull request GitHub says was closed without being merged: when. */
export interface ClosedPull {
  pr: string;
  closed_at: string | null;
}

/**
 * Where a pull request stands on GitHub, as `pr_state` answers the router: `open`, `merged` (with when, by whom and its merge
 * commit), `closed` (closed without a merge, with when) or `unknown` (it could not be read: no GitHub, a failed read, no such pull
 * request). Only these fields: nothing anyone wrote on it (its title, its description), so reading it is not reading untrusted text.
 */
export type PullState =
  | { pr: string; state: "open"; draft: boolean }
  | ({ state: "merged" } & MergedPull)
  | ({ state: "closed" } & ClosedPull)
  | { pr: string; state: "unknown"; reason: "no_github" | "read_failed" };

export interface PrStateDeps {
  db?: Queryable;
  settings?: () => GithubMcpSettings;
  resolveBinding?: ResolveBinding;
  fetchImpl?: typeof fetch;
}

const nameOf = (p: PrRef): string => `${p.owner}/${p.repo}#${p.number}`;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** What one pull request's JSON says about where it stands. */
function stateOf(p: PrRef, pr: Record<string, any> | null | undefined): PullState {
  const name = nameOf(p);
  if (!pr || typeof pr !== "object") return { pr: name, state: "unknown", reason: "read_failed" };
  const mergedAt = str(pr.merged_at);
  if (mergedAt) return { pr: name, state: "merged", merged_at: mergedAt, merge_commit: str(pr.merge_commit_sha), merged_by: str(pr.merged_by?.login) };
  if (pr.state === "closed") return { pr: name, state: "closed", closed_at: str(pr.closed_at) };
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
  try {
    const cred = await resolveGithubToken(q, userId, { binding: s.binding, purpose: `github_mcp:${PR_STATE_TOOL}`, resolve: deps.resolveBinding });
    if (cred.token === null) {
      read = anonymousReader(s.apiUrl, deps.fetchImpl ?? fetch);
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
  for (let i = 0; i < prs.length; i += READ_PARALLEL) {
    states.push(...await Promise.all(prs.slice(i, i + READ_PARALLEL).map(async (p): Promise<PullState> => {
      try {
        return stateOf(p, await read(repoPath(p, `/pulls/${p.number}`)));
      } catch (err) {
        failed++;
        logger.warn({ sessionId, pr: nameOf(p), status: (err as { status?: number })?.status }, "assistant.pr_state_read_failed");
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
