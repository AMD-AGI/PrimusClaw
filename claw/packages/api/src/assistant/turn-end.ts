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
import { REPORT_SUMMARY_MAX } from "./report.js";
import { ingestReport } from "./reports.js";
import type { WorkReport } from "./work-items.js";

const logger = pino({ name: "assistant-turn-end" });

/** A run closed this recently is the completion handler's to record; the sweep waits for it. */
const SWEEP_GRACE_SECONDS = 60;
const SWEEP_BATCH = 20;

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
 *
 * `told`: a report of this run already made the assistant hear about it, so the end adds nothing.
 * `continuing`: another turn is open or queued behind this one on the same session, so the item is not at
 * rest and the next turn will report for itself.
 */
async function runRecord(workerSessionId: string, runId: string): Promise<RunRecord | null> {
  const row = (await db.query(
    `SELECT w.item_id, e.generation,
            EXISTS (
              SELECT 1 FROM claw_work_item_events r
               WHERE r.item_id = w.item_id AND r.run_id = e.run_id
                 AND (r.kind IN ('blocked', 'ready', 'failed', 'dropped')
                      OR (r.kind = 'waiting' AND r.question IS NOT NULL))
            ) AS told,
            (EXISTS (
               SELECT 1 FROM claw_tasks t
                WHERE t.session_id = w.worker_session_id AND t.origin = 'chat' AND t.task_id <> e.run_id
                  AND t.status IN ('queued', 'preparing', 'running', 'cancelling')
             ) OR EXISTS (
               SELECT 1 FROM claw_pending_messages p WHERE p.session_id = w.worker_session_id
            )) AS continuing
       FROM claw_work_items w
       JOIN claw_work_item_events e ON e.item_id = w.item_id AND e.run_id = $2 AND e.kind = 'run_started'
      WHERE w.worker_session_id = $1`,
    [workerSessionId, runId],
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
        AND t.completed_at < NOW() - make_interval(secs => $1::int)
        AND NOT EXISTS (
          SELECT 1 FROM claw_work_item_events x
           WHERE x.item_id = w.item_id AND x.run_id = e.run_id AND x.source = 'turn_end'
        )
      ORDER BY t.completed_at
      LIMIT $2`,
    [SWEEP_GRACE_SECONDS, SWEEP_BATCH],
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
