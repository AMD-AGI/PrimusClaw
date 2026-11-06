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
import { inTransaction, type Querier, type StatementRunner } from "../infra/db.js";
import { metrics } from "../infra/metrics.js";
import { queueServerMessage, drainSessionIfIdle } from "./messages.js";
import { formatWorkEvent } from "./prompts.js";
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
 * Queue the message that tells the item's owner's assistant what happened, in the caller's transaction, deduplicated on the event it is
 * about. Null when there is no assistant to tell or the message could not be queued: what happened stands, and the sweep tells the user
 * an item that needs them even if the Router cannot be woken.
 */
export async function queueRouterWake(q: StatementRunner, e: {
  itemId: string; userId: string; eventId: number; kind: ReportKind; version: number; summary: string; question: string | null;
}): Promise<{ sessionId: string; userId: string } | null> {
  const target = (await q.query(
    `SELECT w.seq, a.session_id AS router_session_id
       FROM claw_work_items w LEFT JOIN claw_assistants a ON a.user_id = w.user_id
      WHERE w.item_id = $1`,
    [e.itemId],
  )).rows[0] as { seq: number; router_session_id: string | null } | undefined;
  if (!target?.router_session_id) return null;
  const queued = await queueServerMessage(q, {
    sessionId: target.router_session_id,
    userId: e.userId,
    content: formatWorkEvent({
      itemId: e.itemId, seq: Number(target.seq), kind: e.kind, version: e.version, summary: e.summary, question: e.question,
    }),
    dedupeKey: `wi-evt:${e.eventId}`,
  });
  if (queued.ok) return { sessionId: target.router_session_id, userId: e.userId };
  logger.warn({ itemId: e.itemId, error: queued.error }, "assistant.wake_not_queued");
  return null;
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
  interface Written { outcome: IngestOutcome; wake: { sessionId: string; userId: string } | null }
  let written: Written;
  try {
    written = await inTransaction(async (query): Promise<Written> => {
      const q = { query };
      await guard?.(query);
      if (source === "worker" && await repeatsLastReport(query, run, recorded)) return { outcome: { status: "duplicate" }, wake: null };
      const applied = await applyWorkerReport(q, {
        itemId: run.itemId, generation: run.generation, workerSessionId: run.workerSessionId,
        source, runId: run.runId, report: recorded,
      });
      if (!applied.applied) return { outcome: { status: "stale" }, wake: null };
      const wake = applied.wake
        ? await queueRouterWake(q, {
          itemId: run.itemId, userId: applied.userId, eventId: applied.eventId, kind: recorded.kind,
          version: applied.resultVersion, summary: recorded.summary, question: recorded.question ?? null,
        })
        : null;
      return { outcome: { status: "applied", boardState: applied.boardState, wokeRouter: wake !== null }, wake };
    });
  } catch (err) {
    if (source === "turn_end" && (err as { code?: string })?.code === UNIQUE_VIOLATION) {
      return { status: "duplicate" };
    }
    throw err;
  }
  if (written.outcome.status === "stale") metrics.onWorkItemStaleRejected(source);
  if (written.wake) await drainSessionIfIdle(written.wake.sessionId, written.wake.userId);
  return written.outcome;
}
