// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The generation a worker's run holds, fixed when the run is handed out.
 *
 * `claw_work_items.generation` is the fencing token of an item: a report is applied only if it carries the
 * item's current one, so a run that was stopped, replaced or overtaken cannot write over a newer state. It
 * goes up once per run. The run is named by its task id and the `run_started` event is unique on
 * (item, run), so a claim that is delivered twice, or a dispatch that is replayed, reads back the number the
 * first one fixed instead of taking another and fencing out the run that is actually executing.
 */
import { inTransaction } from "../infra/db.js";

export interface StartedRun {
  itemId: string;
  userId: string;
  seq: number;
  title: string;
  generation: number;
  /** The item was already done: the run still gets a token, and every report it makes is refused. */
  closed: boolean;
}

interface ItemRow {
  item_id: string;
  user_id: string;
  seq: number;
  title: string;
  generation: number;
  board_state: string;
}

/** Null when the session is not a work item's worker session. */
export async function startWorkerRun(workerSessionId: string, runId: string): Promise<StartedRun | null> {
  return inTransaction(async (query) => {
    // The row lock is what makes the read of the existing event and the bump one decision.
    const item = (await query(
      `SELECT item_id, user_id, seq, title, generation, board_state
         FROM claw_work_items WHERE worker_session_id = $1 FOR UPDATE`,
      [workerSessionId],
    )).rows[0] as ItemRow | undefined;
    if (!item) return null;
    const started = (state: { generation: number; closed: boolean }): StartedRun => ({
      itemId: item.item_id, userId: item.user_id, seq: Number(item.seq), title: item.title, ...state,
    });
    const prior = (await query(
      `SELECT generation FROM claw_work_item_events
        WHERE item_id = $1 AND run_id = $2 AND kind = 'run_started'`,
      [item.item_id, runId],
    )).rows[0] as { generation: number } | undefined;
    if (prior) return started({ generation: Number(prior.generation), closed: item.board_state === "done" });
    if (item.board_state === "done") return started({ generation: Number(item.generation), closed: true });
    const bumped = (await query(
      `UPDATE claw_work_items SET generation = generation + 1, updated_at = NOW()
        WHERE item_id = $1 RETURNING generation`,
      [item.item_id],
    )).rows[0] as { generation: number };
    await query(
      `INSERT INTO claw_work_item_events (item_id, kind, source, generation, run_id)
       VALUES ($1, 'run_started', 'worker', $2, $3)`,
      [item.item_id, bumped.generation, runId],
    );
    return started({ generation: Number(bumped.generation), closed: false });
  });
}
