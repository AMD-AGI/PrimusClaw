// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the person who asked for a review (R) may see of it: four facts, what an open one waits for, and what the review posted on the
 * pull request; nothing else of the item or its session.
 *
 * The review is the reviewer's (X's) work: their item, their session, their board. R asked for it, so R may know how it stands, which pull
 * request it is, what the review said and whether it was merged: `{status, pr_url, verdict, merged}`. While it waits for X, R may know for
 * what (`waiting_for`: a held merge or approval for X to confirm, a review that failed and is restarted or asked again, or something else
 * for X to look at), so that R is not left guessing. And R may know what the review found, as it was posted on the pull request R named:
 * how many of its findings are still open and the first of them in one line (`findings`, `note`), from the item's record of what was
 * posted, which anyone who can read the pull request reads there too. Every answer R gets about the item is this and only this
 * (`GET /v1/work-items/:id`, the stop and its 409, `GET /v1/work-items/asked-of-others`), never the item's summary, its pending question,
 * its params or the session's id. When the item closes, the view is written into `params.requester_view` and stays as it was: what X does
 * in the session afterwards (a second look, another verdict) is X's and does not reach R.
 */
import { redactPublicJson } from "../events/redaction.js";
import type { StatementRunner } from "../infra/db.js";

export interface RequesterView {
  /** `queued`: made, and waiting for a slot (`ReviewParams.queued`); it starts by itself, and then reads `in_progress`. */
  status: "queued" | "in_progress" | "waiting_for_reviewer" | "done" | "stopped";
  pr_url: string | null;
  verdict: "approve" | "request_changes" | "comment" | null;
  merged: boolean;
  /** Only while `status` is `waiting_for_reviewer`, else null. */
  waiting_for: "confirm_merge" | "confirm_review" | "failed" | "reviewer" | null;
  /** Open findings the review posted on the pull request; null when it posted none (no record yet). */
  findings: number | null;
  /** The first open finding, one line, at most NOTE_MAX characters, credentials masked; null when there is none. */
  note: string | null;
}

/** The longest `note` R is shown: one line of a finding, as a summary names it. */
export const NOTE_MAX = 160;

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

/** What the review found, from the item's record of what it posted (`params.record`, written by the state sync): open findings. */
function foundOf(params: Record<string, unknown>): Pick<RequesterView, "findings" | "note"> {
  const record = params.record as { findings?: unknown } | null | undefined;
  if (!record || typeof record !== "object" || !Array.isArray(record.findings)) return { findings: null, note: null };
  const open = record.findings.filter((f) => f !== null && typeof f === "object" && (f as { resolved?: unknown }).resolved !== true);
  const first = open.map((f) => (f as { note?: unknown }).note).find((n): n is string => typeof n === "string" && n.trim() !== "");
  const line = first ? String(redactPublicJson(first.replace(/\s+/g, " ").trim()) ?? "") : "";
  return { findings: open.length, note: line ? (line.length > NOTE_MAX ? `${line.slice(0, NOTE_MAX - 1)}…` : line) : null };
}

/** The view as it is now, read from the item row and from what the session did (the audit and confirmation tables). */
export async function currentRequesterView(
  q: StatementRunner, row: { board_state: unknown; outcome: unknown; worker_session_id: unknown; params: unknown; last_report_kind?: unknown },
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
        OR EXISTS (SELECT 1 FROM claw_github_audit WHERE session_id = $1 AND tool = 'gh_pr_follow' AND result = 'ok' AND detail IN ('merged', 'already_merged'))) AS merged,
       (SELECT kind FROM claw_github_confirmations
         WHERE session_id = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1) AS held`,
    [row.worker_session_id],
  )).rows[0] as { verdict: string | null; merged: boolean; held: string | null };
  const status: RequesterView["status"] = row.board_state === "done"
    ? (row.outcome === "stopped" ? "stopped" : "done")
    : row.board_state === "needs_you" ? "waiting_for_reviewer" : params.queued ? "queued" : "in_progress";
  const waitingFor: RequesterView["waiting_for"] = status !== "waiting_for_reviewer" ? null
    : row.last_report_kind === "failed" ? "failed"
    : facts.held === "merge" ? "confirm_merge" : facts.held === "review" ? "confirm_review" : "reviewer";
  return {
    status, pr_url: prUrlOf(params), verdict: VERDICTS[String(facts.verdict ?? "").toUpperCase()] ?? null, merged: facts.merged === true,
    waiting_for: waitingFor, ...foundOf(params),
  };
}

/**
 * The view as the requester's assistant (the router) is given it: without `note`, the one field the reviewer's session wrote (a line of
 * a finding it posted), so that nothing a worker wrote reaches the router's context through a read that is not marked as such.
 * The person's channel shows the note; the router knows how many findings there are.
 */
export function routerView(view: RequesterView): RequesterView {
  return { ...view, note: null };
}

/** The view written when the item closed, or null while it is open (and for an item nobody else asked for). One written before the
 * view had `waiting_for`, `findings` and `note` reads them as null. */
export function frozenRequesterView(params: unknown): RequesterView | null {
  const p = params !== null && typeof params === "object" ? params as Record<string, unknown> : null;
  const v = p?.requester_view;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const view = v as Partial<RequesterView> & Pick<RequesterView, "status" | "pr_url" | "verdict" | "merged">;
  return { ...view, waiting_for: view.waiting_for ?? null, findings: view.findings ?? null, note: view.note ?? null };
}

/** What R is answered: the frozen view of a closed item, else the view as it is now. */
export async function requesterViewOf(q: StatementRunner, row: Record<string, unknown>): Promise<RequesterView> {
  return frozenRequesterView(row.params) ?? await currentRequesterView(q, {
    board_state: row.board_state, outcome: row.outcome, worker_session_id: row.worker_session_id, params: row.params,
    last_report_kind: row.last_report_kind,
  });
}

/**
 * Write the view into a closed item that someone else asked for, once. Called in the transaction that closes it (stop, restart, the
 * state sync); a view already written is never rewritten, so nothing that happens after the close changes what R sees.
 */
export async function freezeRequesterView(q: StatementRunner, itemId: string): Promise<void> {
  const row = (await q.query(
    "SELECT board_state, outcome, worker_session_id, params, last_report_kind FROM claw_work_items WHERE item_id = $1", [itemId],
  )).rows[0] as { board_state: string; outcome: string | null; worker_session_id: string; params: Record<string, unknown>; last_report_kind: string | null } | undefined;
  if (!row || row.board_state !== "done" || !requestedByOfItem(row.params) || frozenRequesterView(row.params)) return;
  // What the review posted, as the audit has it now: a close that is not the state sync's (a stop) has not written it yet.
  // (Imported here, not at the top: review-items imports this module.)
  const { refreshReviewRecord } = await import("./review-items.js");
  await refreshReviewRecord(q, itemId);
  const reread = async (): Promise<RequesterView> => {
    const fresh = (await q.query("SELECT params FROM claw_work_items WHERE item_id = $1", [itemId])).rows[0] as { params: Record<string, unknown> };
    return currentRequesterView(q, { ...row, params: fresh.params });
  };
  let view = await reread();
  // The verdict is read after the record: a submit recorded in between (its verdict and what it posted are one write) is read whole
  // by refreshing the record once more, so the view never has the verdict without what was posted with it.
  if (view.verdict !== null && view.findings === null) {
    await refreshReviewRecord(q, itemId);
    view = await reread();
  }
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

/**
 * One review the user asked of someone else, as their own assistant and their channel's board may know it: its item_id, the name of
 * who reviews it (the person the user asked), and the view, nothing more.
 */
export interface AskedOfOther { item_id: string; reviewer: string | null; view: RequesterView }

/** How many reviews this user asked of others are open, or closed within the window, in all: what a list cut at its latest can count from. */
export interface AskedOfOthersTotals {
  total: number;
  open: number;
  /** Closed within the window. */
  closed: number;
  /** Of the closed ones, those whose frozen view says merged; and those whose verdict was request_changes. */
  merged: number;
  changes_requested: number;
}

/**
 * The counts of `askedOfOthers` over the same rows, without its limit: the router was shown the 20 latest and said "19 of the 20
 * merged" when 82 had been handed over that day (2026-11-07 14:34). An open review's view is not frozen yet, so of the open ones only
 * the number is counted.
 */
export async function askedOfOthersTotals(q: StatementRunner, userId: string, closedWindow: string): Promise<AskedOfOthersTotals> {
  const row = (await q.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE board_state <> 'done')::int AS open,
            count(*) FILTER (WHERE board_state = 'done')::int AS closed,
            count(*) FILTER (WHERE board_state = 'done' AND params->'requester_view'->>'merged' = 'true')::int AS merged,
            count(*) FILTER (WHERE board_state = 'done' AND params->'requester_view'->>'verdict' = 'request_changes')::int AS changes_requested
       FROM claw_work_items
      WHERE kind = 'review' AND params ? 'requested_by' AND params->>'requested_by' = $1 AND user_id <> $1
        AND (board_state <> 'done' OR closed_at > NOW() - $2::interval)`,
    [userId, closedWindow],
  )).rows[0] as Record<string, unknown> | undefined;
  const n = (v: unknown): number => Number(v) || 0;
  return { total: n(row?.total), open: n(row?.open), closed: n(row?.closed), merged: n(row?.merged), changes_requested: n(row?.changes_requested) };
}

/**
 * The reviews this user asked of others that are open, or closed within `closedWindow`, newest first, at most `limit`. A closed one is
 * its frozen `params.requester_view`; an open one has none yet and is the four facts as they are now. Nothing else of the item (its
 * title, summary, question, the reviewer's words, the session) is read, so nothing the reviewer's session wrote reaches the requester.
 */
export async function askedOfOthers(q: StatementRunner, userId: string, closedWindow: string, limit: number): Promise<AskedOfOther[]> {
  const rows = (await q.query(
    `SELECT item_id, board_state, outcome, worker_session_id, params, last_report_kind FROM claw_work_items
      WHERE kind = 'review' AND params ? 'requested_by' AND params->>'requested_by' = $1 AND user_id <> $1
        AND (board_state <> 'done' OR closed_at > NOW() - $2::interval)
      ORDER BY updated_at DESC LIMIT $3`,
    [userId, closedWindow, limit],
  )).rows as Array<Record<string, unknown>>;
  const out: AskedOfOther[] = [];
  for (const row of rows) {
    const name = (row.params as { acting_as_name?: unknown } | null)?.acting_as_name;
    out.push({ item_id: String(row.item_id), reviewer: typeof name === "string" && name ? name : null, view: await requesterViewOf(q, row) });
  }
  return out;
}
