// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A worker's report reaching the item, and the assistant being told about it.
 *
 * The report, the event that records it and the message that wakes the Router are written in one
 * transaction: a report the Router never hears of would be a result nobody was told about, and a wake for a
 * report that was refused would be a lie. Running the Router's turn is the drain, after the commit.
 *
 * The same entry takes the three sources of a report: the worker through its tool, the end of its turn when
 * it said nothing (`recordWorkerTurnEnd`), and the sweep that finds a turn that ended unseen. They share the
 * generation fence, so none of them can write over a state a newer run or a stop has moved on from.
 */
import { isDeepStrictEqual } from "node:util";
import pino from "pino";
import { inTransaction, isFailoverError, neverCommitted, type Querier, type StatementRunner } from "../infra/db.js";
import { metrics } from "../infra/metrics.js";
import { announceItemDeliveries } from "./deliveries.js";
import { queueServerMessage, drainSessionIfIdle } from "./messages.js";
import { recordNeedsYouFallback, storeAnswerWhole, type SayDeps } from "./outbound.js";
import { formatWorkEvent, SAY_BRIEF_CHARS } from "./prompts.js";
import { tellRequesterOfConflict } from "./review-conflict.js";
import {
  applyWorkerReport, type BoardState, type ReportKind, type ReportSource, type WorkReport,
} from "./work-items.js";

const logger = pino({ name: "assistant-reports" });

const UNIQUE_VIOLATION = "23505";

export interface ReportRun {
  itemId: string;
  workerSessionId: string;
  /** The generation the run was started under (`startWorkerRun`). */
  generation: number;
  /** The run's task id: what a ready result is pinned to, and what a turn-end record is unique on. Null for a report no run made (the sweep's). */
  runId: string | null;
}

export type IngestOutcome =
  | { status: "applied"; boardState: BoardState; wokeRouter: boolean }
  /** The item is closed, or this run is no longer its current one: nothing changed. */
  | { status: "stale" }
  /** This run's turn end was already recorded. */
  | { status: "duplicate" };

/**
 * Whether this report is the one the run made last, word for word: a model that repeats a tool call, or a
 * Brain that replays it after a restart, must not count a result twice (a second `ready` is a new version,
 * and the card the user already has would go stale). Only the immediate repeat counts, so a worker that
 * reports the same thing again after something else is heard; and the item is locked first, so two replays
 * arriving together are ordered and the second sees the first.
 */
async function repeatsLastReport(query: Querier, run: ReportRun, report: WorkReport): Promise<boolean> {
  await query("SELECT 1 FROM claw_work_items WHERE item_id = $1 FOR UPDATE", [run.itemId]);
  const last = (await query(
    `SELECT kind, summary, question, result FROM claw_work_item_events
      WHERE item_id = $1 AND run_id = $2 AND source = 'worker' ORDER BY id DESC LIMIT 1`,
    [run.itemId, run.runId],
  )).rows[0] as { kind: string; summary: string | null; question: string | null; result: unknown } | undefined;
  return last !== undefined
    && last.kind === report.kind
    && last.summary === report.summary
    && (last.question ?? null) === (report.question?.trim() || null)
    && isDeepStrictEqual(last.result ?? null, report.result ?? null);
}

/**
 * An answer longer than a usual message is said to the user whole by the system (`storeAnswerWhole`, in the report's own
 * transaction), formatted as the worker wrote it, instead of being retyped by the router into one; the router is told it was
 * sent. A short one is the router's to say.
 */
export function answerSentWhole(kind: ReportKind, summary: string): boolean {
  return kind === "answer" && summary.length > SAY_BRIEF_CHARS;
}

/**
 * How the answer said whole is published (`storeAnswerWhole`), and the system's message for a report whose wake was refused
 * (`tellUnwoken`), behind a seam so a test can see them without a session stream.
 */
export const reportPorts: {
  sayDeps: SayDeps;
  tellUnwoken: (input: { itemId: string }, deps: SayDeps) => Promise<unknown>;
} = { sayDeps: {}, tellUnwoken: recordNeedsYouFallback };

/**
 * What waking the item's owner's assistant came to (`queueRouterWake`): queued in the router's session; refused, as a session that
 * holds none of its owner's credentials yet is (a session made again after a delete, before the user's first message in it); or no
 * assistant to wake.
 */
export type RouterWake =
  | { status: "queued"; sessionId: string; userId: string }
  | { status: "refused"; error: string }
  | { status: "none" };

/**
 * Queue the message that tells the item's owner's assistant what happened, in the caller's transaction, deduplicated on the event it is
 * about. Not queued when there is no assistant to tell, or the message is refused: what happened stands, and the caller tells the user
 * itself when it was refused (`tellUnwoken`), as the router cannot be woken to.
 *
 * An item started in an assistant session the user has since deleted is told to the session they have now: the message says so
 * (`fromEarlierConversation`), so the router says where the item came from, as the system's own message about it does.
 */
export async function queueRouterWake(q: StatementRunner, e: {
  itemId: string; userId: string; eventId: number; kind: ReportKind; version: number; summary: string; question: string | null;
  /** The answer is stored for sending whole in this same transaction (`storeAnswerWhole`): the router is told so. */
  sentInFull?: boolean;
}): Promise<RouterWake> {
  const target = (await q.query(
    `SELECT w.seq, a.session_id AS router_session_id, w.router_session_id AS own_session_id,
            EXISTS (SELECT 1 FROM claw_sessions s WHERE s.session_id = w.router_session_id AND s.deleted_at IS NULL) AS own_live
       FROM claw_work_items w LEFT JOIN claw_assistants a ON a.user_id = w.user_id
      WHERE w.item_id = $1`,
    [e.itemId],
  )).rows[0] as { seq: number; router_session_id: string | null; own_session_id: string | null; own_live: boolean } | undefined;
  if (!target?.router_session_id) return { status: "none" };
  const fromEarlierConversation = target.own_session_id !== null && target.own_session_id !== target.router_session_id && !target.own_live;
  const queued = await queueServerMessage(q, {
    sessionId: target.router_session_id,
    userId: e.userId,
    content: formatWorkEvent({
      itemId: e.itemId, seq: Number(target.seq), kind: e.kind, version: e.version, summary: e.summary, question: e.question,
      sentInFull: e.sentInFull === true, fromEarlierConversation,
    }),
    dedupeKey: `wi-evt:${e.eventId}`,
  });
  if (queued.ok) return { status: "queued", sessionId: target.router_session_id, userId: e.userId };
  logger.warn({ itemId: e.itemId, error: queued.error }, "assistant.wake_not_queued");
  return { status: "refused", error: queued.error };
}

/**
 * After the commit of a report whose wake was refused (`queueRouterWake`): the router cannot say it, so the system says it now, in its
 * own words (`recordNeedsYouFallback`), rather than leaving it to the silent sweep minutes later (2026-11-07 parity run, v369 B-short:
 * a session made again after a delete holds no credentials until the user's first message in it, and the answer came 5 minutes late).
 * It is the sweep's own message under the same id, so it is said once whoever says it first; an item that does not need the user and
 * was not answered (a progress report) has none. Never fails the report: what this did not say, the sweep does.
 */
export async function tellUnwoken(itemId: string): Promise<void> {
  try {
    await reportPorts.tellUnwoken({ itemId }, reportPorts.sayDeps);
  } catch (err) {
    logger.warn({ err, itemId }, "assistant.unwoken_not_told");
  }
}

export async function ingestReport(
  run: ReportRun, report: WorkReport, source: ReportSource,
  /** Runs first inside the transaction; throwing aborts the report. The worker's tool asks whether its turn is live. */
  guard?: (query: Querier) => Promise<void>,
): Promise<IngestOutcome> {
  // A ready result names the run that produced it, so what the user accepts is that run and no other.
  const recorded: WorkReport = report.kind === "ready"
    ? { ...report, result: { ...(report.result as Record<string, unknown> | undefined), run_id: run.runId } }
    : report;
  interface Written {
    outcome: IngestOutcome; wake: RouterWake | null; eventId?: number;
    answer?: { announce: () => Promise<void> } | null;
  }
  let written: Written;
  // The answer this report stored for sending, for the case the COMMIT's own answer is lost (see the catch).
  let answerStored: { settle: () => void } | null = null;
  try {
    written = await inTransaction(async (query): Promise<Written> => {
      answerStored = null;
      const q = { query };
      await guard?.(query);
      if (source === "worker" && await repeatsLastReport(query, run, recorded)) return { outcome: { status: "duplicate" }, wake: null };
      const applied = await applyWorkerReport(q, {
        itemId: run.itemId, generation: run.generation, workerSessionId: run.workerSessionId,
        source, runId: run.runId, report: recorded,
      });
      if (!applied.applied) return { outcome: { status: "stale" }, wake: null };
      // Stored for sending with the report itself, so the router below is told "sent in full" only of an answer that will be:
      // a failure to store it fails the report, which the worker sends again, rather than leaving an answer nobody says.
      const answer = answerSentWhole(recorded.kind, recorded.summary)
        ? await storeAnswerWhole(query, run.itemId, reportPorts.sayDeps)
        : null;
      answerStored = answer;
      const wake = applied.wake
        ? await queueRouterWake(q, {
          itemId: run.itemId, userId: applied.userId, eventId: applied.eventId, kind: recorded.kind,
          version: applied.resultVersion, summary: recorded.summary, question: recorded.question ?? null, sentInFull: answer !== null,
        })
        : null;
      return {
        outcome: { status: "applied", boardState: applied.boardState, wokeRouter: wake?.status === "queued" }, wake, eventId: applied.eventId, answer,
      };
    });
  } catch (err) {
    // The COMMIT met a failover and its answer was lost: the report may have landed with the answer, and the report sent again
    // is then a duplicate that announces nothing. The answer is looked up in the background and announced if it is there.
    const pending = answerStored as { settle: () => void } | null;
    if (pending && isFailoverError(err) && !neverCommitted(err)) pending.settle();
    if (source === "turn_end" && (err as { code?: string })?.code === UNIQUE_VIOLATION) {
      return { status: "duplicate" };
    }
    throw err;
  }
  if (written.outcome.status === "stale") metrics.onWorkItemStaleRejected(source);
  const applied = written.outcome.status === "applied";
  // Before the router runs, so the user has the answer and the files first and the router's line follows them.
  if (written.answer) await written.answer.announce();
  // The router cannot be woken to say it: the system says it now, after the answer said whole (which this then finds stored).
  if (written.wake?.status === "refused") await tellUnwoken(run.itemId);
  // A review someone else asked for, stopped by a conflict in the author's branch: the one who asked is told too, not only the reviewer.
  if (applied && written.outcome.status === "applied" && written.outcome.boardState === "needs_you") await tellRequesterOfConflict(run.itemId);
  if (applied && recorded.kind !== "progress") await announceDeliveries(run.itemId, written.eventId);
  else if (source === "turn_end") await announceDeliveries(run.itemId);
  if (written.wake?.status === "queued") await drainSessionIfIdle(written.wake.sessionId, written.wake.userId);
  return written.outcome;
}

/**
 * The worker's delivered files, to the user (`deliveries.ts`), recorded as announced through `eventId` when given. Never fails the
 * report: what this did not announce, the run's end or the sweep does.
 */
export async function announceDeliveries(itemId: string, eventId?: number): Promise<void> {
  try {
    await announceItemDeliveries(itemId, {}, eventId);
  } catch (err) {
    logger.warn({ err, itemId }, "assistant.item_deliveries_not_announced");
  }
}
