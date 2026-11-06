// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the person who asked for a review (R) may see of it: four facts, and nothing else of the item or its session.
 *
 * The review is the reviewer's (X's) work: their item, their session, their board. R asked for it, so R may know how it stands, which pull
 * request it is, what the review said and whether it was merged: `{status, pr_url, verdict, merged}`. Every answer R gets about the item
 * is this and only this (`GET /v1/work-items/:id`, the stop and its 409), never the item's summary, its pending question, its params or the
 * session's id. When the item closes, the four are written into `params.requester_view` and stay as they were: what X does in the session
 * afterwards (a second look, another verdict) is X's and does not reach R.
 */
import type { StatementRunner } from "../infra/db.js";

export interface RequesterView {
  status: "in_progress" | "waiting_for_reviewer" | "done" | "stopped";
  pr_url: string | null;
  verdict: "approve" | "request_changes" | "comment" | null;
  merged: boolean;
}

/** The requester of a review item that someone asked of its owner, or null for the owner's own items. */
export function requestedByOfItem(params: unknown): string | null {
  const p = params !== null && typeof params === "object" ? params as Record<string, unknown> : null;
  return typeof p?.requested_by === "string" && p.requested_by ? p.requested_by : null;
}

const VERDICTS: Record<string, RequesterView["verdict"]> = { APPROVE: "approve", REQUEST_CHANGES: "request_changes", COMMENT: "comment" };

function prUrlOf(params: Record<string, unknown>): string | null {
  const pr = params.pr as { owner?: unknown; repo?: unknown; number?: unknown } | undefined;
  return pr && typeof pr.owner === "string" && typeof pr.repo === "string" && typeof pr.number === "number"
    ? `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}` : null;
}

/** The four facts as they are now, read from the item row and from what the session did (the audit and confirmation tables). */
export async function currentRequesterView(
  q: StatementRunner, row: { board_state: unknown; outcome: unknown; worker_session_id: unknown; params: unknown },
): Promise<RequesterView> {
  const params = (row.params ?? {}) as Record<string, unknown>;
  const facts = (await q.query(
    `SELECT
       (SELECT ev FROM (
          SELECT a.arguments->>'event' AS ev, a.at FROM claw_github_audit a
           WHERE a.session_id = $1 AND a.tool = 'gh_review_submit' AND a.result = 'ok' AND a.detail IN ('submitted', 'already_submitted')
          UNION ALL
          SELECT c.review->>'event', COALESCE(c.decided_at, c.created_at) FROM claw_github_confirmations c
           WHERE c.session_id = $1 AND c.kind = 'review' AND c.status = 'submitted'
        ) v WHERE ev IS NOT NULL ORDER BY at DESC LIMIT 1) AS verdict,
       (EXISTS (SELECT 1 FROM claw_github_confirmations WHERE session_id = $1 AND status = 'merged')
        OR EXISTS (SELECT 1 FROM claw_github_audit WHERE session_id = $1 AND tool = 'gh_pr_merge' AND result = 'ok' AND detail = 'merged')
        OR EXISTS (SELECT 1 FROM claw_github_audit WHERE session_id = $1 AND tool = 'gh_pr_follow' AND result = 'ok' AND detail IN ('merged', 'already_merged'))) AS merged`,
    [row.worker_session_id],
  )).rows[0] as { verdict: string | null; merged: boolean };
  const status: RequesterView["status"] = row.board_state === "done"
    ? (row.outcome === "stopped" ? "stopped" : "done")
    : row.board_state === "needs_you" ? "waiting_for_reviewer" : "in_progress";
  return { status, pr_url: prUrlOf(params), verdict: VERDICTS[String(facts.verdict ?? "").toUpperCase()] ?? null, merged: facts.merged === true };
}

/** The view written when the item closed, or null while it is open (and for an item nobody else asked for). */
export function frozenRequesterView(params: unknown): RequesterView | null {
  const p = params !== null && typeof params === "object" ? params as Record<string, unknown> : null;
  const v = p?.requester_view;
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as RequesterView : null;
}

/** What R is answered: the frozen view of a closed item, else the view as it is now. */
export async function requesterViewOf(q: StatementRunner, row: Record<string, unknown>): Promise<RequesterView> {
  return frozenRequesterView(row.params) ?? await currentRequesterView(q, {
    board_state: row.board_state, outcome: row.outcome, worker_session_id: row.worker_session_id, params: row.params,
  });
}

/**
 * Write the view into a closed item that someone else asked for, once. Called in the transaction that closes it (stop, restart, the
 * state sync); a view already written is never rewritten, so nothing that happens after the close changes what R sees.
 */
export async function freezeRequesterView(q: StatementRunner, itemId: string): Promise<void> {
  const row = (await q.query(
    "SELECT board_state, outcome, worker_session_id, params FROM claw_work_items WHERE item_id = $1", [itemId],
  )).rows[0] as { board_state: string; outcome: string | null; worker_session_id: string; params: Record<string, unknown> } | undefined;
  if (!row || row.board_state !== "done" || !requestedByOfItem(row.params) || frozenRequesterView(row.params)) return;
  const view = await currentRequesterView(q, row);
  await q.query(
    "UPDATE claw_work_items SET params = params || jsonb_build_object('requester_view', $2::jsonb) WHERE item_id = $1 AND NOT (params ? 'requester_view')",
    [itemId, JSON.stringify(view)],
  );
}

/**
 * A review item someone else owns that this user asked for, or null. Named only by its item_id: an item's number is its owner's, and
 * the same number on the requester's own board is another item.
 */
export async function requestedItemOf(q: StatementRunner, userId: string, itemId: string): Promise<Record<string, unknown> | null> {
  const row = (await q.query(
    "SELECT * FROM claw_work_items WHERE item_id = $1 AND kind = 'review' AND params->>'requested_by' = $2 AND user_id <> $2",
    [itemId, userId],
  )).rows[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

/** One review the user asked of someone else, as their own assistant may know it: its item_id and the four facts, nothing more. */
export interface AskedOfOther { item_id: string; view: RequesterView }

/**
 * The reviews this user asked of others that are open, or closed within `closedWindow`, newest first, at most `limit`. A closed one is
 * its frozen `params.requester_view`; an open one has none yet and is the four facts as they are now. Nothing else of the item (its
 * title, summary, question, the reviewer's words, the session) is read, so nothing the reviewer's session wrote reaches the requester.
 */
export async function askedOfOthers(q: StatementRunner, userId: string, closedWindow: string, limit: number): Promise<AskedOfOther[]> {
  const rows = (await q.query(
    `SELECT item_id, board_state, outcome, worker_session_id, params FROM claw_work_items
      WHERE kind = 'review' AND params ? 'requested_by' AND params->>'requested_by' = $1 AND user_id <> $1
        AND (board_state <> 'done' OR closed_at > NOW() - $2::interval)
      ORDER BY updated_at DESC LIMIT $3`,
    [userId, closedWindow, limit],
  )).rows as Array<Record<string, unknown>>;
  const out: AskedOfOther[] = [];
  for (const row of rows) out.push({ item_id: String(row.item_id), view: await requesterViewOf(q, row) });
  return out;
}
