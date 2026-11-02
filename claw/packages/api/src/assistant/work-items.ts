// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The state of a work item: what a worker's report does to it, and the two
 * things only a person can do, accept a result and stop the item.
 *
 * The row is the single source of truth. Every change is one UPDATE whose WHERE
 * clause is the rule (the item is still open, the caller is the worker of the
 * current generation, the version being accepted is the version on the row), so
 * two writers racing for the same item cannot both win, and the event row that
 * records the change is written by the same statement from the row the UPDATE
 * returned: no event exists for a change that did not happen.
 *
 * Nothing here talks to a model or to the outbox. Waking the router after a
 * report is the caller's job, in the same transaction, from `wake`.
 */
import { CLAW_ASSISTANT_MAX_ACTIVE_ITEMS } from "../config.js";
import { db, inTransaction, type StatementRunner } from "../infra/db.js";
import { stopSessionRuns } from "../tasks/chat-run.js";
import { newWorkItemId } from "../tasks/ids.js";

export const BOARD_STATES = ["in_progress", "needs_you", "done"] as const;
export type BoardState = (typeof BOARD_STATES)[number];

export const REPORT_KINDS = ["progress", "waiting", "ready", "blocked", "failed", "dropped"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type Outcome = "accepted" | "dropped" | "stopped";

export interface WorkReport {
  kind: ReportKind;
  summary: string;
  question?: string;
  result?: unknown;
}

const TITLE_MAX = 40;
const SUMMARY_MAX = 80;
export const DONE_WINDOW_DAYS = 7;

/** One line, at most `max` characters (not UTF-16 units: titles are mostly Chinese). */
function clipOneLine(text: string, max: number): string {
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, max).join("");
}

// --- What a report does -------------------------------------------------------------

export interface ReportTransition {
  boardState: BoardState;
  /** The router has to hear about it. */
  wake: boolean;
  /** A result the user can accept: the result version goes up. */
  newResult: boolean;
  /** The item now needs the user: the attention counter goes up. */
  needsAttention: boolean;
  question: string | null;
  outcome: Outcome | null;
}

const QUIET: ReportTransition = {
  boardState: "in_progress", wake: false, newResult: false, needsAttention: false, question: null, outcome: null,
};
const NEEDS_YOU: ReportTransition = { ...QUIET, boardState: "needs_you", wake: true, needsAttention: true };

/**
 * Where a report moves the item. Progress, and waiting on nothing but the world
 * (a CI run), keep it on the board's first column and do not wake the router: it
 * speaks only when the user is needed.
 */
export function reportTransition(report: Pick<WorkReport, "kind" | "question">): ReportTransition {
  const question = report.question?.trim() || null;
  switch (report.kind) {
    case "progress": return QUIET;
    case "waiting": return question ? { ...NEEDS_YOU, question } : QUIET;
    case "blocked": return { ...NEEDS_YOU, question };
    case "ready": return { ...NEEDS_YOU, newResult: true };
    case "failed": return NEEDS_YOU;
    case "dropped": return { ...QUIET, boardState: "done", wake: true, outcome: "dropped" };
  }
}

export type ReportSource = "worker" | "turn_end" | "sweep";

export interface ApplyReport {
  itemId: string;
  /** The generation the reporter was started under; a stale one matches nothing. */
  generation: number;
  /** Who is allowed to report: the item's own worker session. */
  workerSessionId: string;
  source: ReportSource;
  runId?: string | null;
  report: WorkReport;
}

export type ReportOutcome =
  | { applied: false }
  | {
    applied: true;
    eventId: number;
    userId: string;
    boardState: BoardState;
    wake: boolean;
    resultVersion: number;
    attentionSeq: number;
  };

/**
 * Apply a report if its sender is still the item's current worker and the item
 * is still open.
 *
 * `applied: false` means nothing changed: the item is closed, belongs to another
 * worker, or has moved to a newer generation. A second `turn_end` for the same
 * run raises Postgres 23505 from the unique index, and the statement changes
 * nothing; the caller reads that as "already recorded".
 */
export async function applyWorkerReport(q: StatementRunner, input: ApplyReport): Promise<ReportOutcome> {
  const t = reportTransition(input.report);
  const { report } = input;
  const rows = (await q.query(
    `WITH upd AS (
       UPDATE claw_work_items
          SET board_state = $4,
              last_report_kind = $5,
              summary = $6,
              pending_question = $7,
              result_version = result_version + $8::int,
              attention_seq = attention_seq + $9::int,
              outcome = $10,
              closed_at = CASE WHEN $4 = 'done' THEN NOW() ELSE closed_at END,
              updated_at = NOW()
        WHERE item_id = $1 AND generation = $2 AND worker_session_id = $3 AND board_state <> 'done'
    RETURNING item_id, user_id, generation, board_state, result_version, attention_seq
     ), ev AS (
       INSERT INTO claw_work_item_events (item_id, kind, source, generation, run_id, summary, question, result)
       SELECT item_id, $5::text, $11::text, generation, $12::text, $13::text, $14::text, $15::jsonb FROM upd
    RETURNING id
     )
     SELECT upd.*, ev.id AS event_id FROM upd, ev`,
    [
      input.itemId, input.generation, input.workerSessionId,
      t.boardState, report.kind, clipOneLine(report.summary, SUMMARY_MAX), t.question,
      t.newResult ? 1 : 0, t.needsAttention ? 1 : 0, t.outcome,
      input.source, input.runId ?? null, report.summary, t.question,
      report.kind === "ready" && report.result !== undefined ? JSON.stringify(report.result) : null,
    ],
  )).rows as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return { applied: false };
  return {
    applied: true,
    eventId: Number(row.event_id),
    userId: row.user_id as string,
    boardState: row.board_state as BoardState,
    wake: t.wake,
    resultVersion: Number(row.result_version),
    attentionSeq: Number(row.attention_seq),
  };
}

// --- What the user sees ---------------------------------------------------------------

const ITEM_COLUMNS = `item_id, seq, title, summary, board_state, last_report_kind, pending_question,
  outcome, result_version, accepted_version, worker_session_id, created_at, updated_at, closed_at`;

export interface WorkItemView {
  item_id: string;
  seq: number;
  title: string;
  summary: string;
  board_state: BoardState;
  last_report_kind: ReportKind | null;
  pending_question: string | null;
  outcome: Outcome | null;
  result_version: number;
  accepted_version: number | null;
  can_accept: boolean;
  updated_at: Date;
}

/** Derived from the state, never chosen by a model: a result waits for a person. */
export function canAccept(row: { board_state: string; last_report_kind: string | null }): boolean {
  return row.board_state === "needs_you" && row.last_report_kind === "ready";
}

export function itemView(row: Record<string, unknown>): WorkItemView {
  return {
    item_id: row.item_id as string,
    seq: Number(row.seq),
    title: row.title as string,
    summary: row.summary as string,
    board_state: row.board_state as BoardState,
    last_report_kind: (row.last_report_kind ?? null) as ReportKind | null,
    pending_question: (row.pending_question ?? null) as string | null,
    outcome: (row.outcome ?? null) as Outcome | null,
    result_version: Number(row.result_version),
    accepted_version: row.accepted_version == null ? null : Number(row.accepted_version),
    can_accept: canAccept(row as { board_state: string; last_report_kind: string | null }),
    updated_at: row.updated_at as Date,
  };
}

/** The caller's own item, or null: another user's item is indistinguishable from none. */
export async function getWorkItem(userId: string, itemId: string): Promise<Record<string, unknown> | null> {
  const rows = (await db.query(
    `SELECT ${ITEM_COLUMNS}, repo FROM claw_work_items WHERE item_id = $1 AND user_id = $2`,
    [itemId, userId],
  )).rows as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

export async function listWorkItems(userId: string, state: BoardState | null): Promise<WorkItemView[]> {
  const rows = (await db.query(
    `SELECT ${ITEM_COLUMNS} FROM claw_work_items
      WHERE user_id = $1
        AND ($2::text IS NULL OR board_state = $2)
        AND (board_state <> 'done' OR closed_at > NOW() - make_interval(days => $3::int))
      ORDER BY updated_at DESC
      LIMIT 200`,
    [userId, state, DONE_WINDOW_DAYS],
  )).rows as Array<Record<string, unknown>>;
  return rows.map(itemView);
}

export async function recentEvents(itemId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  return (await db.query(
    `SELECT id, kind, source, generation, run_id, summary, question, result, created_at
       FROM claw_work_item_events WHERE item_id = $1 ORDER BY id DESC LIMIT $2`,
    [itemId, limit],
  )).rows as Array<Record<string, unknown>>;
}

// --- Taking on an item ----------------------------------------------------------------

export type InsertWorkItemResult =
  | { ok: true; itemId: string; seq: number }
  | { ok: false; error: "too_many_active_items" | "no_assistant" };

/**
 * The item row and its `created` event. Must run inside the transaction that also
 * creates the worker session: the user's assistant row is locked first, so two
 * creates for one user take their numbers and meet the limit one after the other.
 */
export async function insertWorkItem(
  q: StatementRunner,
  input: { userId: string; title: string; workerSessionId: string; repo?: unknown },
): Promise<InsertWorkItemResult> {
  const locked = await q.query("SELECT 1 FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [input.userId]);
  if (!locked.rowCount) return { ok: false, error: "no_assistant" };
  const counts = (await q.query(
    `SELECT COUNT(*) FILTER (WHERE board_state <> 'done')::int AS active, COALESCE(MAX(seq), 0)::int + 1 AS next
       FROM claw_work_items WHERE user_id = $1`,
    [input.userId],
  )).rows[0] as { active: number; next: number };
  if (counts.active >= CLAW_ASSISTANT_MAX_ACTIVE_ITEMS) return { ok: false, error: "too_many_active_items" };
  const itemId = newWorkItemId();
  await q.query(
    `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, worker_session_id, repo)
     VALUES ($1, $2, $3, $4, 'in_progress', $5, $6::jsonb)`,
    [
      itemId, input.userId, counts.next, clipOneLine(input.title, TITLE_MAX), input.workerSessionId,
      input.repo === undefined ? null : JSON.stringify(input.repo),
    ],
  );
  await q.query(
    "INSERT INTO claw_work_item_events (item_id, kind, source, generation) VALUES ($1, 'created', 'router', 0)",
    [itemId],
  );
  return { ok: true, itemId, seq: counts.next };
}

// --- What only a person decides -------------------------------------------------------

export type DecisionResult =
  | { status: "ok"; item: WorkItemView }
  | { status: "not_found" }
  | { status: "conflict"; error: "version_mismatch" | "not_acceptable" | "item_closed"; item: WorkItemView };

/**
 * Accept the result the user was shown. It succeeds only if that result is still
 * the item's current one: a newer `ready`, a request for more changes, or an
 * item that was already closed all fail the same WHERE clause, so a click on an
 * old card can never accept work the user has not seen.
 */
export async function acceptWorkItem(userId: string, itemId: string, version: number): Promise<DecisionResult> {
  const accepted = (await db.query(
    `WITH upd AS (
       UPDATE claw_work_items
          SET board_state = 'done', outcome = 'accepted', accepted_version = $3,
              closed_at = NOW(), updated_at = NOW()
        WHERE item_id = $1 AND user_id = $2 AND board_state = 'needs_you'
          AND last_report_kind = 'ready' AND result_version = $3
    RETURNING ${ITEM_COLUMNS}, generation
     ), ev AS (
       INSERT INTO claw_work_item_events (item_id, kind, source, generation, result)
       SELECT item_id, 'accepted', 'user', generation, jsonb_build_object('version', $3::int) FROM upd
    RETURNING id
     )
     SELECT upd.* FROM upd, ev`,
    [itemId, userId, version],
  )).rows as Array<Record<string, unknown>>;
  if (accepted[0]) return { status: "ok", item: itemView(accepted[0]) };
  const current = await getWorkItem(userId, itemId);
  if (!current) return { status: "not_found" };
  const item = itemView(current);
  const error = item.can_accept && item.result_version !== version ? "version_mismatch" : "not_acceptable";
  return { status: "conflict", error, item };
}

/**
 * Stop an item: it is closed first, and only then is its worker interrupted, so
 * a crash between the two leaves an item that says stopped, never a worker that
 * was stopped for an item still on the board. Stopping an item that is already
 * stopped sends the interrupt again, which is how a stop that failed is retried.
 */
export async function stopWorkItem(input: {
  userId: string;
  itemId: string;
  source: "user" | "router";
  reason?: string;
}): Promise<DecisionResult> {
  const stopped = await inTransaction(async (query) => {
    const rows = (await query(
      `WITH upd AS (
         UPDATE claw_work_items
            SET board_state = 'done', outcome = 'stopped', pending_question = NULL,
                generation = generation + 1, closed_at = NOW(), updated_at = NOW()
          WHERE item_id = $1 AND user_id = $2 AND board_state <> 'done'
      RETURNING ${ITEM_COLUMNS}, generation
       ), ev AS (
         INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
         SELECT item_id, 'stopped', $3, generation, $4 FROM upd
      RETURNING id
       )
       SELECT upd.* FROM upd, ev`,
      [input.itemId, input.userId, input.source, input.reason ?? null],
    )).rows as Array<Record<string, unknown>>;
    const row = rows[0];
    // A first message still waiting for the worker's session must not start a
    // turn on an item the user has already stopped.
    if (row) await query("DELETE FROM claw_pending_messages WHERE session_id = $1", [row.worker_session_id]);
    return row;
  });
  const current = stopped ?? await getWorkItem(input.userId, input.itemId);
  if (!current) return { status: "not_found" };
  const item = itemView(current);
  if (!stopped && current.outcome !== "stopped") return { status: "conflict", error: "item_closed", item };
  await stopSessionRuns(current.worker_session_id as string);
  return { status: "ok", item };
}

/**
 * The user asked for more on an item: back to in progress, with the old result no
 * longer the one to accept (the accept's WHERE clause needs `ready`).
 */
export async function reopenWorkItem(
  q: StatementRunner,
  input: { userId: string; itemId: string; text?: string },
): Promise<WorkItemView | null> {
  const rows = (await q.query(
    `WITH upd AS (
       UPDATE claw_work_items
          SET board_state = 'in_progress', last_report_kind = 'progress', pending_question = NULL,
              updated_at = NOW()
        WHERE item_id = $1 AND user_id = $2 AND board_state <> 'done'
    RETURNING ${ITEM_COLUMNS}, generation
     ), ev AS (
       INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary)
       SELECT item_id, 'progress', 'router', generation, $3 FROM upd
    RETURNING id
     )
     SELECT upd.* FROM upd, ev`,
    [input.itemId, input.userId, input.text ?? null],
  )).rows as Array<Record<string, unknown>>;
  return rows[0] ? itemView(rows[0]) : null;
}
