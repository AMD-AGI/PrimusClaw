// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An item that is in progress in name only.
 *
 * Something is meant to be working on it (a turn is open on its worker's session, or a message is waiting there for
 * one) and for longer than `CLAW_ASSISTANT_WATCHDOG_SEC` nothing has happened to it: no report, no new run, no new
 * instruction. The worker may be stuck in a loop, its sandbox may have gone, or its instruction may never have been
 * taken up. The user would only find out by asking, so the watchdog asks for them: the item is put in front of them,
 * with the reason, as a `blocked` report of the system's own. That wakes the assistant like any report that needs the
 * user, and if the assistant says nothing the silent sweep tells them anyway.
 *
 * The watchdog stops nothing. A worker that was only slow reports again and the item is back in progress, and from
 * then on the clock starts over; an item it has put in front of the user is not picked again while it waits there.
 *
 * It is the third of three sweeps that never pick the same item. An item with nothing running and nothing waiting is
 * the orphan sweep's, a run that ended unrecorded is `reconcileWorkerRuns`'s, and this one takes only items where
 * something is still open. Its record carries no run, so it does not count as that run having told the assistant: the
 * end of the run is still recorded when it comes.
 */
import pino from "pino";
import { CLAW_ASSISTANT_WATCHDOG_SEC } from "../config.js";
import { db } from "../infra/db.js";
import { OPEN_RUN_STATUSES } from "../tasks/chat-run.js";
import { ingestReport } from "./reports.js";
import type { WorkReport } from "./work-items.js";

const logger = pino({ name: "assistant-watchdog" });

export const WATCHDOG_BATCH = 20;

/** The write, behind a seam so a test can make the item come back to life between the select and the write. */
export const watchdogPorts = { ingestReport };

/**
 * An item in progress with something open behind it and no sign of life for longer than the threshold. Its last sign
 * of life is the later of its own last change and its last event (a report, a run that started, an instruction sent).
 * $1 the statuses of a run that is not over; $2 the threshold, in seconds.
 */
const STUCK_ITEM = `
  w.board_state = 'in_progress' AND w.kind = 'task'
  AND GREATEST(w.updated_at, COALESCE(
        (SELECT MAX(e.created_at) FROM claw_work_item_events e WHERE e.item_id = w.item_id), w.updated_at))
      < NOW() - make_interval(secs => $2::int)
  AND (
    EXISTS (SELECT 1 FROM claw_tasks t
             WHERE t.session_id = w.worker_session_id AND t.origin = 'chat' AND t.status = ANY($1::text[]))
    OR EXISTS (SELECT 1 FROM claw_pending_messages p
                WHERE p.session_id = w.worker_session_id AND p.created_at < NOW() - make_interval(secs => $2::int))
  )`;

/** Which way the item is stuck, read off what is open behind it. */
const STUCK_REASON = `CASE
  WHEN EXISTS (SELECT 1 FROM claw_tasks t
                WHERE t.session_id = w.worker_session_id AND t.origin = 'chat' AND t.status = ANY($1::text[])
                  AND t.status <> 'queued' AND t.lease_expires_at < NOW()) THEN 'worker_lost'
  WHEN NOT EXISTS (SELECT 1 FROM claw_tasks t
                    WHERE t.session_id = w.worker_session_id AND t.origin = 'chat' AND t.status = ANY($1::text[])
                      AND t.status <> 'queued') THEN 'not_started'
  ELSE 'no_progress' END`;

export type StuckReason = "worker_lost" | "not_started" | "no_progress";

export function stuckReport(reason: StuckReason, minutes: number): WorkReport {
  const question = "Keep waiting, send the instruction again, or stop it?";
  switch (reason) {
    case "worker_lost":
      return { kind: "blocked", question, summary: `The worker stopped answering: its run has had no heartbeat, and nothing has happened to this item for more than ${minutes} minutes.` };
    case "not_started":
      return { kind: "blocked", question, summary: `The last instruction has not reached a worker: it has waited more than ${minutes} minutes without a run starting.` };
    case "no_progress":
      return { kind: "blocked", question, summary: `No progress for more than ${minutes} minutes: the worker is still running but has not reported anything.` };
  }
}

/** Thrown inside the report's transaction when the item stopped being stuck between the sweep's read and its write. */
class NoLongerStuck extends Error {}

/**
 * Put every stuck item in front of its owner, with the reason. Returns how many were. Does nothing while the threshold
 * is 0, which is the default.
 *
 * Asked again under the item's row lock, in the transaction that writes, as the orphan sweep is: a report or an
 * instruction that arrived after the select makes the item no longer stuck, and two sweepers meet there. The report is
 * fenced by the generation read with the item, so a run that started since is not written over.
 */
export async function surfaceStuckItems(thresholdSeconds: number = CLAW_ASSISTANT_WATCHDOG_SEC): Promise<number> {
  if (thresholdSeconds <= 0) return 0;
  const items = (await db.query(
    `SELECT w.item_id, w.worker_session_id, w.generation, ${STUCK_REASON} AS reason
       FROM claw_work_items w
      WHERE ${STUCK_ITEM}
      ORDER BY w.updated_at
      LIMIT $3`,
    [OPEN_RUN_STATUSES, thresholdSeconds, WATCHDOG_BATCH],
  )).rows as Array<{ item_id: string; worker_session_id: string; generation: number; reason: StuckReason }>;
  const minutes = Math.max(1, Math.round(thresholdSeconds / 60));
  let surfaced = 0;
  for (const item of items) {
    try {
      const result = await watchdogPorts.ingestReport(
        { itemId: item.item_id, workerSessionId: item.worker_session_id, generation: Number(item.generation), runId: null },
        stuckReport(item.reason, minutes),
        "watchdog",
        async (query) => {
          const still = await query(
            `SELECT 1 FROM claw_work_items w WHERE w.item_id = $3 AND ${STUCK_ITEM} FOR UPDATE OF w`,
            [OPEN_RUN_STATUSES, thresholdSeconds, item.item_id],
          );
          if (!still.rowCount) throw new NoLongerStuck();
        },
      );
      if (result.status === "applied") {
        surfaced += 1;
        logger.warn({ itemId: item.item_id, reason: item.reason }, "assistant.watchdog_surfaced_item");
      }
    } catch (err) {
      if (err instanceof NoLongerStuck) continue;
      logger.warn({ err, itemId: item.item_id }, "assistant.watchdog_item_failed");
    }
  }
  return surfaced;
}
