// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review someone asked of another person (R asked X: X's item, `params.requested_by` = R) that stops because GitHub will not merge the
 * pull request while its branch conflicts with the base (`gh_pr_merge` refused `merge_state_not_clean` on merge state DIRTY). Only the
 * author can resolve a conflict, yet the item, and so every notice that it is blocked, is the reviewer's: on 2026-11-07 (daily gaps, N5) at
 * least 17 of the 23 "is blocked" notices a reviewer got were this, and nobody told the one who asked. R is told now too, through their own
 * assistant, in their language: which pull request, that its branch has conflicts, and that the author resolves them before the review can
 * merge it. Once per item and head commit (the notice's key): a push that still conflicts is told again, a second block on the same head is not.
 *
 * The same holds for a merge GitHub refused because the pull request changes a CI workflow file and the reviewer's GitHub authorization
 * has no `workflow` scope (`gh_pr_merge` refused `github_workflow_scope_missing`; 2026-11-09, daily gaps N17): no one can get past it
 * through Claw, binding again does not add the scope, and the pull request has to be merged by hand on GitHub. R is told so, the same way.
 *
 * The same holds for a merge GitHub refused on merge state BLOCKED (2026-11-10, daily gaps N20): the branch's rules (a required check
 * that has not passed, a required review still missing) stop it even after the review approved, and what unblocks it is the author's or
 * CI's, not the reviewer's. Only the reviewer was told, so R, who waited on the merge, never learned it had stopped. R is told so, the same way.
 *
 * What R is told is within what R may know of the item (`requester-view.ts`, which lists it): the pull request R named and one fact GitHub
 * shows on it to anyone who can read it, read through the reviewer's session as the view's `findings` and `merged` are; nothing of the
 * session itself (no summary, question or session id).
 *
 * Started where a review item comes to need its owner: `syncReviewItem` (`review-items.ts`), which writes a review's "blocked" from the
 * facts of its session (a review session sends no worker report), and `ingestReport` for an item that does report. A merge someone else
 * asked for that GitHub refused for one of these reasons no longer needs the reviewer (2026-11-12): `syncReviewItem` keeps the item in
 * progress, waiting for the author (`params.author_waiting`), and starts this check from that state too. Both start it after
 * their commit and do not wait for it (`checkConflictLater`), so a slow read or notice never delays either.
 */
import pino from "pino";
import { CLAW_ASSISTANT_ENABLED, CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { db, type Querier } from "../infra/db.js";
import { personWritesChinese, recordSystemNotice } from "./outbound.js";
import { requestedByOfItem } from "./requester-view.js";
import { WORKFLOW_SCOPE_REFUSAL } from "../github-review/service.js";

const logger = pino({ name: "assistant-review-conflict" });

/**
 * What happens next, as `followReviewItems` does it (`AuthorWait` in `review-items.ts`), and no more: new commits run the review once more,
 * which may or may not merge them; a day without them hands it back to the reviewer. Never that it will be merged.
 */
const AFTER_ZH = "作者推送新提交后，评审会在新提交上自动再做一次；一天内没有新提交，会交回评审人处理。";
const AFTER_EN = "Once the author pushes new commits, the review runs once more on them; if none come within a day, it goes back to the reviewer. ";

/** What R is told, by language. */
export function conflictText(pr: string, url: string, zh: boolean): string {
  return zh
    ? `你请人评审并合入的 ${pr} 合不进去：GitHub 显示这个分支和目标分支有冲突。需要作者先解决冲突（合并或变基目标分支后推送）。${AFTER_ZH}${url}`
    : `${pr}, which you asked to be reviewed and merged, cannot be merged: GitHub says its branch has conflicts with the base branch. The author `
      + `has to resolve them (merge or rebase onto the base branch, then push). ${AFTER_EN}${url}`;
}

/** What R is told, by language, when GitHub refused the merge for the missing `workflow` scope. */
export function workflowScopeText(pr: string, url: string, zh: boolean): string {
  return zh
    ? `你请人评审并合入的 ${pr} 没能合入：这个 PR 改了 CI workflow 文件（.github/workflows/ 下），助理代为合入需要 GitHub 的 workflow 权限，目前没有这个权限。请在 GitHub 上手动合入。${url}`
    : `${pr}, which you asked to be reviewed and merged, was not merged: it changes CI workflow files (.github/workflows/), and the assistant needs `
      + `GitHub's workflow permission to merge it on someone's behalf, which it does not have. Please merge it by hand on GitHub. ${url}`;
}

/** What R is told, by language, when GitHub's branch rules blocked the merge (merge state BLOCKED). */
export function branchRulesText(pr: string, url: string, zh: boolean): string {
  return zh
    ? `你请人评审并合入的 ${pr} 没能合入：GitHub 的分支保护规则挡住了合入（比如必需的检查还没通过，或者还缺必需的评审）。需要作者或 CI 先满足这些规则。${AFTER_ZH}${url}`
    : `${pr}, which you asked to be reviewed and merged, was not merged: GitHub's branch protection rules block the merge (for example a required `
      + `check has not passed, or a required review is still missing). The author or CI has to meet those rules. ${AFTER_EN}${url}`;
}

type Notice = "conflict" | "workflow_scope" | "branch_rules";
const NOTICE_TEXT: Record<Notice, (pr: string, url: string, zh: boolean) => string> = {
  conflict: conflictText, workflow_scope: workflowScopeText, branch_rules: branchRulesText,
};
/** The notice's key prefix; the conflict's is the one it always had, so a conflict told before this is not told again. */
const NOTICE_KEY: Record<Notice, string> = { conflict: "review_conflict", workflow_scope: "review_workflow_scope", branch_rules: "review_branch_rules" };

/** Which refused merge R is told of, from the merge's audit row: a conflict (DIRTY), branch rules (BLOCKED), the missing `workflow` scope, or none. */
function noticeOf(merge: { result: string; detail: string; merge_state: string | null }): Notice | { skip: string; extra: Record<string, unknown> } {
  if (merge.result === "refused" && merge.detail === WORKFLOW_SCOPE_REFUSAL) return "workflow_scope";
  if (merge.result !== "refused" || merge.detail !== "merge_state_not_clean") {
    return { skip: "merge_not_refused_on_state", extra: { result: merge.result, detail: merge.detail } };
  }
  if (merge.merge_state === "DIRTY") return "conflict";
  if (merge.merge_state === "BLOCKED") return "branch_rules";
  return { skip: "merge_state_not_told", extra: { mergeState: merge.merge_state ?? null } };
}

/** The ports a test stands in for: what reaches R. */
export const reviewConflictPorts = { recordSystemNotice };

/** The checks started and not finished yet, for a test to wait on (`conflictChecksSettled`). */
const inflight = new Set<Promise<boolean>>();

/** Start `tellRequesterOfConflict` for the item without waiting for it: the report it follows is already committed and answered. */
export function checkConflictLater(itemId: string): void {
  const p = tellRequesterOfConflict(itemId);
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** Resolves when every check started so far has finished (tests). */
export async function conflictChecksSettled(): Promise<void> {
  await Promise.all([...inflight]);
}

/**
 * After a report that left a review item needing its owner: when the item was asked by someone else and the latest merge its session tried
 * was refused on a conflict, tell the one who asked. True when told now. Never throws: the report stands whatever this does.
 */
export async function tellRequesterOfConflict(itemId: string): Promise<boolean> {
  // Every way this ends without telling says why (`assistant.review_conflict_skipped`, with the reason), so a conflict nobody was told of
  // is never silent in the logs (2026-11-08, N5: neither "told" nor "not told" was ever logged for four of them).
  const skipped = (reason: string, extra: Record<string, unknown> = {}): false => {
    logger.info({ itemId, reason, ...extra }, "assistant.review_conflict_skipped");
    return false;
  };
  if (!CLAW_ASSISTANT_ENABLED || !CLAW_GITHUB_REVIEW_ENABLED) return skipped("disabled");
  try {
    const q: Querier = (t, p) => db.query(t, p);
    // Only a review someone else asked to be merged: a review only never merges, and the owner's own review has no one else to tell.
    const item = (await q(
      `SELECT item_id, user_id, params, worker_session_id, kind, board_state FROM claw_work_items WHERE item_id = $1`,
      [itemId],
    )).rows[0] as {
      item_id: string; user_id: string; params: Record<string, unknown> | null; worker_session_id: string | null;
      kind: string; board_state: string;
    } | undefined;
    if (!item) return skipped("no_item");
    if (item.kind !== "review") return skipped("not_a_review");
    // A merge that waits for its author (`author_waiting`, `review-items.ts`) is in progress for the reviewer, and told to the one who asked.
    const waitsForAuthor = item.board_state === "in_progress" && typeof item.params?.author_waiting === "string";
    if (item.board_state !== "needs_you" && !waitsForAuthor) return skipped("not_needs_you", { boardState: item.board_state });
    if (String(item.params?.review_only ?? "false") === "true") return skipped("review_only");
    const requester = requestedByOfItem(item.params);
    if (!requester) return skipped("no_requested_by");
    if (requester === item.user_id) return skipped("requested_by_is_owner");
    if (!item.worker_session_id) return skipped("no_worker_session");
    // The session's latest merge, whatever came of it: a conflict that a later merge got past (or failed on for another reason) is not told.
    const merge = (await q(
      `SELECT repo, pr, head_sha, result, detail, merge_state FROM claw_github_audit
        WHERE session_id = $1 AND tool = 'gh_pr_merge' AND result <> 'started' ORDER BY id DESC LIMIT 1`,
      [item.worker_session_id],
    )).rows[0] as { repo: string; pr: number | null; head_sha: string; result: string; detail: string; merge_state: string | null } | undefined;
    if (!merge) return skipped("no_merge");
    const kind = noticeOf(merge);
    if (typeof kind !== "string") return skipped(kind.skip, kind.extra);
    if (!merge.repo || !merge.pr) return skipped("merge_without_pr");
    const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [requester])).rows[0]?.session_id as string | undefined;
    if (!sessionId) return skipped("requester_has_no_assistant", { requester });
    const pr = `${merge.repo}#${merge.pr}`;
    const zh = await personWritesChinese(q, requester);
    const url = `https://github.com/${merge.repo}/pull/${merge.pr}`;
    const told = await reviewConflictPorts.recordSystemNotice({
      userId: requester, sessionId, text: NOTICE_TEXT[kind](pr, url, zh),
      key: `${NOTICE_KEY[kind]}:${item.item_id}:${merge.head_sha || "-"}`,
    });
    if (told === null) return skipped("already_told", { requester, pr, head: merge.head_sha || "-", kind });
    logger.info({ itemId, requester, pr, kind }, "assistant.review_conflict_told");
    return true;
  } catch (err) {
    logger.warn({ err, itemId }, "assistant.review_conflict_not_told");
    return false;
  }
}
