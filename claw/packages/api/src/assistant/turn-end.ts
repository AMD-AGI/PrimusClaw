// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A worker's turn that ended and nobody was told.
 *
 * A worker is asked to finish with a report, and a model sometimes just stops. Failing that, or crashing, an
 * accepted item would sit in progress for ever with nothing running behind it. So the end of every worker
 * turn is looked at: if the worker did not tell the assistant something that needs the user, the end itself
 * is recorded as a report: `failed` for a run that failed, `ready` for one that finished. Ready is the safe
 * direction, because a ready result still waits for a person to accept it.
 *
 * Two callers, one decision. The completion handler does it when the turn ends, with the worker's last
 * words; the sweep does it for a turn whose completion was lost or never came (a handler that threw after
 * the run was closed, a run interrupted from the web UI). They record under the same unique key, one record
 * per run, so neither can double what the other did.
 */
import pino from "pino";
import { db } from "../infra/db.js";
import { SWEEPABLE_RUN_STATUSES } from "../tasks/chat-run.js";
import { REPORT_SUMMARY_MAX } from "./report.js";
import { ingestReport } from "./reports.js";
import { REPORT_KINDS, reportTransition, type WorkReport } from "./work-items.js";

const logger = pino({ name: "assistant-turn-end" });

/** A run closed this recently is the completion handler's to record; the sweep waits for it. */
const SWEEP_GRACE_SECONDS = 60;
export const SWEEP_BATCH = 20;

/**
 * The reports that already tell the assistant something it must act on, read off the state table rather than
 * listed again: a kind that wakes the router whatever it carries, and a kind that wakes it only with a question.
 */
const WAKING_KINDS = REPORT_KINDS.filter((kind) => reportTransition({ kind }).wake);
const WAKING_WITH_QUESTION = REPORT_KINDS.filter(
  (kind) => !WAKING_KINDS.includes(kind) && reportTransition({ kind, question: "?" }).wake,
);

/**
 * What a run's end has to know, as SQL over `w` (the item) and `e` (the run's `run_started` event). Written once
 * for `recordRunEnd` and for the sweep that looks for runs to record, so the sweep does not select a run
 * `recordRunEnd` would skip: a run it would skip is selected again on every tick, and enough of them fill the
 * batch and keep the runs behind them from ever being reached.
 *
 * `RUN_TOLD`: the last report of this run is one that made the assistant hear about it, so the end adds nothing.
 * Only the last: a run that said ready and then went on (said progress) has taken the item back to work, and
 * its end is the next thing the assistant has to hear. (The sweep needs no such test: a run whose last report
 * woke the assistant left the item needing the user, and an item that does is not in progress.)
 * `RUN_CONTINUING`: another turn is open or queued behind this one on the same session, so the item is not at
 * rest and the next turn will report for itself.
 *
 * $1 the statuses of a run that is not over; $2 and $3 the kinds of report that tell the assistant something.
 */
const RUN_TOLD = `EXISTS (
  SELECT 1 FROM (
    SELECT r.kind, r.question FROM claw_work_item_events r
     WHERE r.item_id = w.item_id AND r.run_id = e.run_id AND r.kind <> 'run_started'
     ORDER BY r.id DESC LIMIT 1
  ) last
   WHERE last.kind = ANY($2::text[]) OR (last.kind = ANY($3::text[]) AND last.question IS NOT NULL)
)`;
const RUN_CONTINUING = `(EXISTS (
  SELECT 1 FROM claw_tasks t
   WHERE t.session_id = w.worker_session_id AND t.origin = 'chat' AND t.task_id <> e.run_id AND t.status = ANY($1::text[])
) OR EXISTS (
  SELECT 1 FROM claw_pending_messages p WHERE p.session_id = w.worker_session_id
))`;

export type TurnEndOutcome = "failed" | "finished" | "interrupted";

interface RunRecord {
  item_id: string;
  generation: number;
  told: boolean;
  continuing: boolean;
}

/**
 * What the item knows of this run, or null when the run never carried an assistant role (it began before the
 * assistant was on, or is another session's).
 */
async function runRecord(workerSessionId: string, runId: string): Promise<RunRecord | null> {
  const row = (await db.query(
    `SELECT w.item_id, e.generation, ${RUN_TOLD} AS told, ${RUN_CONTINUING} AS continuing
       FROM claw_work_items w
       JOIN claw_work_item_events e ON e.item_id = w.item_id AND e.run_id = $5 AND e.kind = 'run_started'
      WHERE w.worker_session_id = $4`,
    [SWEEPABLE_RUN_STATUSES, WAKING_KINDS, WAKING_WITH_QUESTION, workerSessionId, runId],
  )).rows[0] as RunRecord | undefined;
  return row ?? null;
}

function endReport(
  outcome: TurnEndOutcome, detail: { finalText?: string; failureReason?: string },
): WorkReport {
  if (outcome === "failed") {
    return { kind: "failed", summary: `The run failed: ${detail.failureReason || "unknown error"}.` };
  }
  if (outcome === "interrupted") {
    return { kind: "failed", summary: "The run was interrupted before it reported." };
  }
  const text = (detail.finalText ?? "").trim();
  return {
    kind: "ready",
    summary: text
      ? text.slice(0, REPORT_SUMMARY_MAX)
      : "The run finished without a report or a final message; open the worker's session to see what it did.",
  };
}

/** Record how one run ended, if that tells the assistant something it was not already told. */
export async function recordRunEnd(
  workerSessionId: string, runId: string, outcome: TurnEndOutcome,
  detail: { finalText?: string; failureReason?: string } = {},
): Promise<"recorded" | "skipped"> {
  const record = await runRecord(workerSessionId, runId);
  if (!record || record.told || record.continuing) return "skipped";
  const result = await ingestReport(
    { itemId: record.item_id, workerSessionId, generation: Number(record.generation), runId },
    endReport(outcome, detail),
    "turn_end",
  );
  return result.status === "applied" ? "recorded" : "skipped";
}

export interface WorkerTurnEnd {
  sessionId: string;
  /** The runs the completion closed. */
  runIds: string[];
  failed: boolean;
  interrupted: boolean;
  finalText?: string;
  failureReason?: string;
}

/**
 * The completion handler's hook. An interrupted turn is not recorded: a stop the assistant asked for has
 * already closed the item, and one from anywhere else is left to the sweep, which says so plainly.
 */
export async function recordWorkerTurnEnd(end: WorkerTurnEnd): Promise<void> {
  if (end.interrupted) return;
  for (const runId of end.runIds) {
    await recordRunEnd(end.sessionId, runId, end.failed ? "failed" : "finished", {
      finalText: end.finalText, failureReason: end.failureReason,
    });
  }
}

/**
 * Runs that ended while their item was still in progress, and that nothing recorded: the completion that
 * should have recorded them was lost. Returns how many were recorded.
 */
export async function reconcileWorkerRuns(): Promise<number> {
  const runs = (await db.query(
    `SELECT w.worker_session_id, e.run_id, t.status, t.failure_reason
       FROM claw_work_items w
       JOIN claw_work_item_events e ON e.item_id = w.item_id AND e.kind = 'run_started' AND e.generation = w.generation
       JOIN claw_tasks t ON t.task_id = e.run_id
      WHERE w.board_state = 'in_progress'
        AND t.status IN ('completed', 'failed', 'cancelled')
        AND t.completed_at < NOW() - make_interval(secs => $2::int)
        AND NOT EXISTS (
          SELECT 1 FROM claw_work_item_events x
           WHERE x.item_id = w.item_id AND x.run_id = e.run_id AND x.source = 'turn_end'
        )
        AND NOT ${RUN_CONTINUING}
      ORDER BY t.completed_at
      LIMIT $3`,
    [SWEEPABLE_RUN_STATUSES, SWEEP_GRACE_SECONDS, SWEEP_BATCH],
  )).rows as Array<{ worker_session_id: string; run_id: string; status: string; failure_reason: string | null }>;
  let recorded = 0;
  for (const run of runs) {
    try {
      const outcome: TurnEndOutcome = run.status === "failed" ? "failed" : run.status === "cancelled" ? "interrupted" : "finished";
      if (await recordRunEnd(run.worker_session_id, run.run_id, outcome, { failureReason: run.failure_reason ?? undefined }) === "recorded") {
        recorded += 1;
      }
    } catch (err) {
      logger.warn({ err, sessionId: run.worker_session_id, runId: run.run_id }, "assistant.reconcile_run_failed");
    }
  }
  if (recorded) logger.warn({ recorded }, "assistant.reconciled_unrecorded_runs");
  return recorded;
}

/**
 * An item in progress that nothing is working on: no run has started under its current generation, no turn is
 * open on its worker's session or queued for it, none ended within the grace, and it has been quiet for longer
 * than the completion handler needs. Its last instruction never started (the dispatch was refused, or failed
 * before the run was claimed), so no run will ever report, and there is no run end for `reconcileWorkerRuns` to
 * find. A run that did start under this generation is `reconcileWorkerRuns`'s, however many of them are waiting
 * behind its batch: it records what that run did, where this would record that nothing ran.
 * $1 the statuses of a run that is not over; $2 the grace, in seconds.
 */
const ORPHANED_ITEM = `
  w.board_state = 'in_progress'
  AND w.updated_at < NOW() - make_interval(secs => $2::int)
  AND NOT EXISTS (
    SELECT 1 FROM claw_work_item_events e
     WHERE e.item_id = w.item_id AND e.kind = 'run_started' AND e.generation = w.generation
  )
  AND NOT EXISTS (
    SELECT 1 FROM claw_tasks t
     WHERE t.session_id = w.worker_session_id AND t.origin = 'chat'
       AND (t.status = ANY($1::text[]) OR t.completed_at >= NOW() - make_interval(secs => $2::int))
  )
  AND NOT EXISTS (SELECT 1 FROM claw_pending_messages p WHERE p.session_id = w.worker_session_id)`;

const ORPHANED_REPORT: WorkReport = {
  kind: "failed",
  summary: "Nothing is working on this item and nothing is waiting to start: the last instruction never reached a run. Send it again.",
};

/** Thrown inside the report's transaction when the item stopped being an orphan between the sweep's read and its write. */
class NoLongerOrphaned extends Error {}

/**
 * Tell the assistant about each item in progress that nothing is working on. Returns how many were recorded.
 *
 * Re-asked under the item's row lock, in the transaction that writes the report: two sweepers that selected
 * the same item meet there, and the second finds it no longer in progress, as does an instruction that arrived
 * after the select.
 */
export async function reconcileOrphanedItems(): Promise<number> {
  const items = (await db.query(
    `SELECT w.item_id, w.worker_session_id, w.generation FROM claw_work_items w
      WHERE ${ORPHANED_ITEM}
      ORDER BY w.updated_at
      LIMIT $3`,
    [SWEEPABLE_RUN_STATUSES, SWEEP_GRACE_SECONDS, SWEEP_BATCH],
  )).rows as Array<{ item_id: string; worker_session_id: string; generation: number }>;
  let recorded = 0;
  for (const item of items) {
    try {
      const result = await ingestReport(
        { itemId: item.item_id, workerSessionId: item.worker_session_id, generation: Number(item.generation), runId: null },
        ORPHANED_REPORT,
        "sweep",
        async (query) => {
          const still = await query(
            `SELECT 1 FROM claw_work_items w WHERE w.item_id = $3 AND ${ORPHANED_ITEM} FOR UPDATE OF w`,
            [SWEEPABLE_RUN_STATUSES, SWEEP_GRACE_SECONDS, item.item_id],
          );
          if (!still.rowCount) throw new NoLongerOrphaned();
        },
      );
      if (result.status === "applied") recorded += 1;
    } catch (err) {
      if (err instanceof NoLongerOrphaned) continue;
      logger.warn({ err, itemId: item.item_id }, "assistant.reconcile_item_failed");
    }
  }
  if (recorded) logger.warn({ recorded }, "assistant.reconciled_orphaned_items");
  return recorded;
}
