// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Retry: a task the person sees failed, or stopped, runs again in its own worker session (`POST /v1/work-items/:id/retry`).
 *
 * Only a task item, and only one of two states: its worker reported `failed` (the item waits for the person), or it was stopped
 * (done, outcome `stopped`). Anything else is refused with `not_retryable` and is left as it is: a result to accept, a question to
 * answer, an item still running, one that was accepted or dropped. A review has its own restart (`review-items.ts`), and an agent
 * on the person's machine is sent instructions there (`devenv_send`).
 *
 * The item goes back to in progress at a new generation, so a late report of the run that failed or was stopped is fenced out
 * (`applyWorkerReport` matches the generation), and its worker session is sent one instruction, RETRY_TEXT, which starts the next
 * run when the session is idle. A stopped item counts against the person's limit again (`CLAW_ASSISTANT_MAX_ACTIVE_ITEMS`), counted
 * under the same lock `insertWorkItem` takes. The state change and the queued instruction are one transaction: an instruction that
 * cannot be queued (the session is gone, or holds no credentials) changes nothing.
 */
import { CLAW_ASSISTANT_MAX_ACTIVE_ITEMS } from "../config.js";
import { inTransaction } from "../infra/db.js";
import { drainSessionIfIdle, queueServerMessage } from "./messages.js";
import type { RetryRefusal } from "@claw/protocol";
import { getWorkItem, ITEM_COLUMNS, itemView, RUNNING, type WorkItemView } from "./work-items.js";

/** What the worker is told when the person presses Retry. */
export const RETRY_TEXT =
  "The person pressed Retry on this task. The previous attempt failed or was stopped. Look at what was done so far, " +
  "then carry the task through from where it stands and report as before.";

export type { RetryRefusal } from "@claw/protocol";

export type RetryResult =
  | { status: "ok"; item: WorkItemView }
  | { status: "not_found" }
  | { status: "conflict"; error: RetryRefusal; item: WorkItemView };

/** Whether an item (a row of `claw_work_items`) is one Retry takes: a task that failed, or that was stopped. */
export function retryable(row: { kind?: unknown; board_state?: unknown; last_report_kind?: unknown; outcome?: unknown }): boolean {
  if ((row.kind ?? "task") !== "task") return false;
  return (row.board_state === "needs_you" && row.last_report_kind === "failed") || (row.board_state === "done" && row.outcome === "stopped");
}

class Refused extends Error {
  constructor(readonly reason: RetryRefusal) { super(reason); }
}

export async function retryWorkItem(userId: string, itemId: string): Promise<RetryResult> {
  let refused: RetryRefusal | null = null;
  const done = await inTransaction(async (query) => {
    // The person's assistant row first, as `insertWorkItem` takes it: two items made or retried at once meet the limit in turn.
    await query("SELECT 1 FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [userId]);
    const row = (await query(
      "SELECT kind, board_state, last_report_kind, outcome, params, worker_session_id FROM claw_work_items WHERE item_id = $1 AND user_id = $2 FOR UPDATE",
      [itemId, userId],
    )).rows[0] as { kind: string; board_state: string; last_report_kind: string | null; outcome: string | null;
                    params: Record<string, unknown>; worker_session_id: string } | undefined;
    if (!row) return null;
    if (!retryable(row) || "queued" in (row.params ?? {})) throw new Refused("not_retryable");
    if (row.board_state === "done") {
      const active = (await query(
        `SELECT COUNT(*)::int AS n FROM claw_work_items WHERE user_id = $1 AND ${RUNNING} AND NOT (params ? 'requested_by')`,
        [userId],
      )).rows[0] as { n: number };
      if (active.n >= CLAW_ASSISTANT_MAX_ACTIVE_ITEMS) throw new Refused("too_many_active_items");
    }
    const updated = (await query(
      `WITH upd AS (
         UPDATE claw_work_items
            SET board_state = 'in_progress', last_report_kind = 'progress', pending_question = NULL, outcome = NULL,
                closed_at = NULL, generation = generation + 1, updated_at = NOW()
          WHERE item_id = $1 AND user_id = $2
      RETURNING ${ITEM_COLUMNS}, generation
       ), ev AS (
         INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
         SELECT item_id, 'progress', 'user', generation, 'retry' FROM upd
      RETURNING id
       )
       SELECT upd.* FROM upd, ev`,
      [itemId, userId],
    )).rows[0] as Record<string, unknown>;
    const queued = await queueServerMessage({ query }, { sessionId: row.worker_session_id, userId, content: RETRY_TEXT });
    if (!queued.ok) throw new Refused(queued.error);
    return { item: itemView(updated), sessionId: row.worker_session_id };
  }).catch((err: unknown) => {
    if (!(err instanceof Refused)) throw err;
    refused = err.reason;
    return undefined;
  });
  if (done) {
    await drainSessionIfIdle(done.sessionId, userId);
    return { status: "ok", item: done.item };
  }
  const current = await getWorkItem(userId, itemId);
  if (!current) return { status: "not_found" };
  return { status: "conflict", error: refused ?? "not_retryable", item: itemView(current) };
}
