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
 * R is told only what R may know of the item (`requester-view.ts`): the pull request R named and GitHub's merge state, which anyone who can
 * read the pull request sees; nothing of the reviewer's session.
 */
import pino from "pino";
import { CLAW_ASSISTANT_ENABLED, CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { db, type Querier } from "../infra/db.js";
import { personWritesChinese, recordSystemNotice } from "./outbound.js";
import { requestedByOfItem } from "./requester-view.js";

const logger = pino({ name: "assistant-review-conflict" });

/** What R is told, by language. */
export function conflictText(pr: string, url: string, zh: boolean): string {
  return zh
    ? `你请人评审并合入的 ${pr} 合不进去：GitHub 显示这个分支和目标分支有冲突。需要作者先解决冲突（合并或变基目标分支后推送），评审才能继续合入。${url}`
    : `${pr}, which you asked to be reviewed and merged, cannot be merged: GitHub says its branch has conflicts with the base branch. The author `
      + `has to resolve them (merge or rebase onto the base branch, then push) before the review can merge it. ${url}`;
}

/** The ports a test stands in for: what reaches R. */
export const reviewConflictPorts = { recordSystemNotice };

/**
 * After a report that left a review item needing its owner: when the item was asked by someone else and the latest merge its session tried
 * was refused on a conflict, tell the one who asked. True when told now. Never throws: the report stands whatever this does.
 */
export async function tellRequesterOfConflict(itemId: string): Promise<boolean> {
  if (!CLAW_ASSISTANT_ENABLED || !CLAW_GITHUB_REVIEW_ENABLED) return false;
  try {
    const q: Querier = (t, p) => db.query(t, p);
    const item = (await q(
      "SELECT item_id, user_id, kind, board_state, params, worker_session_id FROM claw_work_items WHERE item_id = $1", [itemId],
    )).rows[0] as { item_id: string; user_id: string; kind: string; board_state: string; params: Record<string, unknown> | null; worker_session_id: string | null } | undefined;
    if (!item || item.kind !== "review" || item.board_state !== "needs_you" || !item.worker_session_id) return false;
    const requester = requestedByOfItem(item.params);
    if (!requester || requester === item.user_id) return false;
    // The session's latest merge, whatever came of it: a conflict that a later merge got past (or failed on for another reason) is not told.
    const merge = (await q(
      `SELECT repo, pr, head_sha, result, detail, merge_state FROM claw_github_audit
        WHERE session_id = $1 AND tool = 'gh_pr_merge' AND result <> 'started' ORDER BY id DESC LIMIT 1`,
      [item.worker_session_id],
    )).rows[0] as { repo: string; pr: number | null; head_sha: string; result: string; detail: string; merge_state: string | null } | undefined;
    if (!merge || merge.result !== "refused" || merge.detail !== "merge_state_not_clean" || merge.merge_state !== "DIRTY") return false;
    if (!merge.repo || !merge.pr) return false;
    const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [requester])).rows[0]?.session_id as string | undefined;
    if (!sessionId) return false;
    const pr = `${merge.repo}#${merge.pr}`;
    const zh = await personWritesChinese(q, requester);
    const told = await reviewConflictPorts.recordSystemNotice({
      userId: requester, sessionId, text: conflictText(pr, `https://github.com/${merge.repo}/pull/${merge.pr}`, zh),
      key: `review_conflict:${item.item_id}:${merge.head_sha || "-"}`,
    });
    if (told) logger.info({ itemId, requester, pr }, "assistant.review_conflict_told");
    return told !== null;
  } catch (err) {
    logger.warn({ err, itemId }, "assistant.review_conflict_not_told");
    return false;
  }
}
