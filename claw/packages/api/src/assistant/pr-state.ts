// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which of the pull requests a review request names are already merged, read on GitHub as the person who asks, before a review of
 * them is started or handed to someone else (`review-tools.ts`, `reviewStart`).
 *
 * A request to review and merge pull requests that were merged already was answered with a question about the reviewer, twice in real
 * use (Yihan stopped those reviews by hand) and once in the parity run of 2026-11-06 (G3): nothing looked at the pull requests. Now the
 * tool looks first, and a merged one is refused with when it merged and its merge commit, which is what the person needs to hear.
 *
 * Read with the person's own GitHub (their `GH_TOKEN`, else the account they bound, as the router's GitHub reads are), and a read with
 * a binding is written to GitHub review's audit log first, as every such read is (`github-mcp/mcp.ts`). Best effort: a person with no
 * GitHub, a read that fails, or an audit row that cannot be written leaves the request as it was before this check, never refused for
 * it; only a pull request GitHub says is merged is.
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

export interface PrStateDeps {
  db?: Queryable;
  settings?: () => GithubMcpSettings;
  resolveBinding?: ResolveBinding;
  fetchImpl?: typeof fetch;
}

const nameOf = (p: PrRef): string => `${p.owner}/${p.repo}#${p.number}`;

/** Of `prs`, the ones GitHub says are merged, in their order, as `userId` reads them. Never throws. */
export async function mergedPulls(userId: string, sessionId: string, prs: readonly PrRef[], deps: PrStateDeps = {}): Promise<MergedPull[]> {
  const q = deps.db ?? defaultDb;
  const s = (deps.settings ?? (() => readGithubMcpSettings()))();
  // The GitHub tools off: the router reads no GitHub, and neither does this.
  if (!prs.length || !s.enabled) return [];
  let gh: GithubClient;
  let audit: { id: number } | null = null;
  try {
    const cred = await resolveGithubToken(q, userId, { binding: s.binding, purpose: `github_mcp:${PR_STATE_TOOL}`, resolve: deps.resolveBinding });
    if (cred.token === null) return [];
    gh = new GithubClient({ token: cred.token, apiUrl: s.apiUrl, timeoutMs: READ_TIMEOUT_MS, fetchImpl: deps.fetchImpl });
    if (cred.source === "binding") {
      audit = {
        id: await auditStart(q, {
          requesterUserId: userId, actorUserId: userId, sessionId, tool: `${GITHUB_MCP_AUDIT_TOOL_PREFIX}${PR_STATE_TOOL}`,
          args: { prs: prs.map(nameOf).slice(0, 30) },
        }),
      };
    }
  } catch (err) {
    logger.warn({ sessionId, errorClass: (err as Error)?.constructor?.name, code: (err as { code?: string })?.code ?? "" }, "assistant.pr_state_unavailable");
    return [];
  }
  const merged: Array<MergedPull | null> = [];
  let failed = 0;
  for (let i = 0; i < prs.length; i += READ_PARALLEL) {
    merged.push(...await Promise.all(prs.slice(i, i + READ_PARALLEL).map(async (p) => {
      try {
        const pr = (await gh.get<Record<string, any>>(repoPath(p, `/pulls/${p.number}`))).json;
        if (!pr || typeof pr.merged_at !== "string" || !pr.merged_at) return null;
        return {
          pr: nameOf(p), merged_at: pr.merged_at,
          merge_commit: typeof pr.merge_commit_sha === "string" ? pr.merge_commit_sha : null,
          merged_by: typeof pr.merged_by?.login === "string" ? pr.merged_by.login : null,
        };
      } catch (err) {
        failed++;
        logger.warn({ sessionId, pr: nameOf(p), status: (err as { status?: number })?.status }, "assistant.pr_state_read_failed");
        return null;
      }
    })));
  }
  if (audit) {
    try {
      await auditFinish(q, audit.id, {
        githubRequests: gh.requests, githubRequestIds: gh.requestIds, githubStatus: gh.lastStatus || undefined, dryRun: false, write: false,
        result: failed ? "refused" : "ok", detail: failed ? `${failed} of ${prs.length} reads failed` : "",
      });
    } catch { /* the row was written before the reads; one left unfinished reads as unfinished */ }
  }
  return merged.filter((m): m is MergedPull => m !== null);
}
