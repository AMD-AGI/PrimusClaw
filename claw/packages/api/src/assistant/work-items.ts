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
import { closeConfirmationsForStop } from "../github-review/store.js";
import { db, inTransaction, type Querier, type StatementRunner } from "../infra/db.js";
import { ITEM_REF_HINT, parseItemRef, type ItemRefError } from "./item-ref.js";
import { stopSessionRuns } from "../tasks/chat-run.js";
import { newWorkItemId } from "../tasks/ids.js";

export const BOARD_STATES = ["in_progress", "needs_you", "done"] as const;
export type BoardState = (typeof BOARD_STATES)[number];

export const REPORT_KINDS = ["progress", "waiting", "ready", "blocked", "failed", "dropped"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type Outcome = "accepted" | "dropped" | "stopped";

/** `task`: a worker that reports does it. `review`: a GitHub review on someone's behalf, whose state is read off what it did (`review-items.ts`). */
export const ITEM_KINDS = ["task", "review"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface WorkReport {
  kind: ReportKind;
  summary: string;
  question?: string;
  result?: unknown;
}

export const TITLE_MAX = 40;
const SUMMARY_MAX = 80;
export const DONE_WINDOW_DAYS = 7;

/** One line, at most `max` characters (not UTF-16 units: titles are mostly Chinese). */
export function clipOneLine(text: string, max: number): string {
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

export type ReportSource = "worker" | "turn_end" | "sweep" | "watchdog";

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
  outcome, result_version, accepted_version, worker_session_id, created_at, updated_at, closed_at, kind, params`;

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
  kind: ItemKind;
  /** What a review was asked with (`review-items.ts`); `{}` for a task. */
  params: Record<string, unknown>;
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
    kind: row.kind === "review" ? "review" : "task",
    params: row.params !== null && typeof row.params === "object" ? row.params as Record<string, unknown> : {},
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

/** What a reference named: enough to act on the item, whichever way it was named. */
export interface ResolvedItem {
  item_id: string;
  seq: number;
  worker_session_id: string;
}

export type ItemLookup =
  | { ok: true; item: ResolvedItem }
  | { ok: false; error: ItemRefError | "item_not_found"; message: string };

/**
 * The item a reference names among this user's own, by its id or by its number (`item-ref.ts`).
 *
 * The user is part of the lookup, never a check after it: a number is only unique per user, and another user's
 * item, named by its id or by a number, is indistinguishable from one that does not exist. `forUpdate` locks the
 * row for the caller's transaction.
 */
export async function resolveWorkItem(
  run: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  userId: string, raw: unknown, opts: { forUpdate?: boolean } = {},
): Promise<ItemLookup> {
  const parsed = parseItemRef(raw);
  if (!parsed.ok) return parsed;
  const byId = parsed.ref.by === "id";
  const row = (await run(
    `SELECT item_id, seq, worker_session_id FROM claw_work_items
      WHERE user_id = $1 AND ${byId ? "item_id" : "seq"} = $2${opts.forUpdate ? " FOR UPDATE" : ""}`,
    [userId, parsed.ref.by === "id" ? parsed.ref.itemId : parsed.ref.seq],
  )).rows[0] as ResolvedItem | undefined;
  if (!row) return { ok: false, error: "item_not_found", message: `no such item: ${ITEM_REF_HINT}` };
  return { ok: true, item: { item_id: row.item_id, seq: Number(row.seq), worker_session_id: row.worker_session_id } };
}

/** `resolveWorkItem` outside a transaction. */
export const resolveWorkItemNow = (userId: string, raw: unknown): Promise<ItemLookup> =>
  resolveWorkItem((text, params) => db.query(text, params), userId, raw);

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
  input: { userId: string; title: string; workerSessionId: string; repo?: unknown; kind?: ItemKind; params?: Record<string, unknown> },
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
    `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, worker_session_id, repo, kind, params)
     VALUES ($1, $2, $3, $4, 'in_progress', $5, $6::jsonb, $7, $8::jsonb)`,
    [
      itemId, input.userId, counts.next, clipOneLine(input.title, TITLE_MAX), input.workerSessionId,
      input.repo === undefined ? null : JSON.stringify(input.repo), input.kind ?? "task", JSON.stringify(input.params ?? {}),
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
  | { status: "conflict"; error: "version_mismatch" | "not_acceptable" | "item_closed" | StopRefusal; item: WorkItemView };

/** Why a review item cannot be stopped: its merge is being made, or was made. Saying so is the truth; nothing is undone. */
export type StopRefusal = "merge_in_progress" | "already_merged";

/** Thrown inside the stop's transaction, which it rolls back: nothing was stopped and no confirmation was denied. */
class StopRefused extends Error {
  constructor(readonly reason: StopRefusal) { super(reason); }
}

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
 *
 * A review item's session may have a merge or an approval held for someone's
 * answer. Interrupting the session leaves that card answerable for a day, so the
 * held writes are denied in the same transaction (`closeConfirmationsForStop`);
 * one that is already being made, or a merge that was made, refuses the stop.
 */
export async function stopWorkItem(input: {
  userId: string;
  itemId: string;
  source: "user" | "router";
  reason?: string;
  /** Runs first inside the transaction; throwing stops nothing. The router's tool asks whether its turn is still live. */
  guard?: (query: Querier) => Promise<void>;
}): Promise<DecisionResult> {
  let refused: StopRefusal | null = null;
  const stopped = await inTransaction(async (query) => {
    await input.guard?.(query);
    const open = (await query(
      "SELECT kind, params, worker_session_id FROM claw_work_items WHERE item_id = $1 AND user_id = $2 AND board_state <> 'done' FOR UPDATE",
      [input.itemId, input.userId],
    )).rows[0] as { kind: string; params: { acting_as: string; pr: { owner: string; repo: string; number: number } }; worker_session_id: string } | undefined;
    if (open?.kind === "review") {
      const refusal = await closeConfirmationsForStop({ query }, open.worker_session_id, input.userId, { actorUserId: open.params.acting_as, pr: open.params.pr });
      if (refusal) throw new StopRefused(refusal);
    }
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
  }).catch((err: unknown) => {
    if (!(err instanceof StopRefused)) throw err;
    refused = err.reason;
    return undefined;
  });
  const current = stopped ?? await getWorkItem(input.userId, input.itemId);
  if (!current) return { status: "not_found" };
  const item = itemView(current);
  if (refused) return { status: "conflict", error: refused, item };
  if (!stopped && current.outcome !== "stopped") return { status: "conflict", error: "item_closed", item };
  await stopSessionRuns(current.worker_session_id as string);
  return { status: "ok", item };
}

/**
 * The user asked for more on an item: back to in progress, with the old result no
 * longer the one to accept (the accept's WHERE clause needs `ready`).
 *
 * The generation goes up with it. A run that is still executing never saw this
 * instruction, so whatever it reports next, `ready` above all, describes work the
 * user has already asked to change: it is fenced out, and the run that carries the
 * instruction is the next one to be heard.
 */
export async function reopenWorkItem(
  q: StatementRunner,
  input: { userId: string; itemId: string; text?: string },
): Promise<WorkItemView | null> {
  const rows = (await q.query(
    `WITH upd AS (
       UPDATE claw_work_items
          SET board_state = 'in_progress', last_report_kind = 'progress', pending_question = NULL,
              generation = generation + 1, updated_at = NOW()
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
