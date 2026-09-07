// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a run's time ledger lives on the row, and how a report reaches it.
 *
 * The merge rule is in @claw/protocol; what is here makes applying it safe
 * against the row. Every instant is `clock_timestamp()`: `NOW()` is fixed at
 * transaction start, so a transaction that began earlier and commits later
 * would pair its own older instant with an anchor already advanced.
 */
import pino from "pino";

import {
  bankQueuedMs,
  isCoveringReport,
  mergeRunTimeReport,
  beginAttemptRecord,
  endAttemptRecord,
  newRunTimeLedgerEntry,
  noteAttemptRenewal,
  type RunIdentityRef,
  type RunTimeLedgerEntry,
  type RunTimeReportInput,
} from "@claw/protocol";
import { db, type Querier } from "../infra/db.js";

const logger = pino({ name: "run-time-ledger" });

/** How many times a merge may lose the compare-and-swap before giving up. */
const MAX_CAS_ATTEMPTS = 5;

// `queuedTotalMs` closes the open segment at read time, so it is complete the
// moment the row stops being queued, whichever statement ended it.
const READ_LEDGER_SQL = `
  SELECT metadata->'run_phase'->'ledger' AS ledger,
         ledger_version,
         status,
         attempt_id,
         attempt_generation,
         claim_count,
         delivery_seq,
         delivery_count,
         heartbeat_at,
         queued_at,
         completed_at,
         clock_timestamp() AS read_at,
         queued_ms_accrued + (CASE WHEN status = 'queued'
           THEN GREATEST(0, EXTRACT(EPOCH FROM (
                  COALESCE(completed_at, clock_timestamp()) - queued_at)) * 1000)
           ELSE 0 END)::bigint AS queued_total_ms
    FROM claw_tasks
   WHERE task_id = $1`;

export interface LedgerRow {
  entry: RunTimeLedgerEntry;
  ledgerVersion: number;
  status: string;
  /** The attempt the row currently holds, read with the entry it would write. */
  attemptId: string | null;
  attemptGeneration: number;
  claimCount: number;
  deliverySeq: number;
  deliveryCount: number;
  heartbeatAtDb: string | null;
  readAtDb: string;
  completedAtDb: string | null;
  queuedTotalMs: number;
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

function readRow(row: Record<string, unknown> | undefined, identity: RunIdentityRef): LedgerRow | null {
  if (!row) return null;
  const readAtDb = iso(row.read_at);
  // Every accounting instant is derived from this one. A row that cannot
  // supply it has no ledger to compute, and inventing one would put an
  // unparseable anchor into the entry rather than failing here.
  if (Number.isNaN(Date.parse(readAtDb))) return null;
  const queuedAtDb = row.queued_at ? iso(row.queued_at) : readAtDb;
  const stored = row.ledger as RunTimeLedgerEntry | null;
  return {
    entry: stored ?? newRunTimeLedgerEntry(identity, queuedAtDb),
    ledgerVersion: Number(row.ledger_version ?? 0),
    status: String(row.status ?? ""),
    attemptId: (row.attempt_id as string | null) ?? null,
    attemptGeneration: Number(row.attempt_generation ?? 0),
    claimCount: Number(row.claim_count ?? 0),
    deliverySeq: Number(row.delivery_seq ?? 0),
    deliveryCount: Number(row.delivery_count ?? 0),
    heartbeatAtDb: row.heartbeat_at ? iso(row.heartbeat_at) : null,
    readAtDb,
    completedAtDb: row.completed_at ? iso(row.completed_at) : null,
    queuedTotalMs: Number(row.queued_total_ms ?? 0),
  };
}

export async function readLedger(
  taskId: string,
  identity: RunIdentityRef,
  query: Querier = db.query,
): Promise<LedgerRow | null> {
  const r = await query(READ_LEDGER_SQL, [taskId]);
  return readRow(r.rows[0] as Record<string, unknown> | undefined, identity);
}

/** The same read, holding the row so a transition and its merge commit together. */
export async function readLedgerForUpdate(
  query: Querier,
  taskId: string,
  identity: RunIdentityRef,
): Promise<LedgerRow | null> {
  const r = await query(`${READ_LEDGER_SQL} FOR UPDATE`, [taskId]);
  return readRow(r.rows[0] as Record<string, unknown> | undefined, identity);
}

/**
 * Store an entry, refusing if anybody has written since it was read.
 *
 * @returns whether this writer won. A loser re-reads the entry, its version and
 *          a fresh read instant together, since the budget comes from the pair.
 */
export async function writeLedger(
  taskId: string,
  entry: RunTimeLedgerEntry,
  expectedVersion: number,
  query: Querier = db.query,
): Promise<boolean> {
  const next = { ...entry, ledgerVersion: expectedVersion + 1 };
  const r = await query(
    `UPDATE claw_tasks
        SET metadata = jsonb_set(
                         jsonb_set(COALESCE(metadata, '{}'::jsonb), '{run_phase}',
                                   COALESCE(metadata->'run_phase', '{}'::jsonb), true),
                         '{run_phase,ledger}', $2::jsonb, true),
            ledger_version = $3
      WHERE task_id = $1 AND ledger_version = $4`,
    [taskId, JSON.stringify(next), expectedVersion + 1, expectedVersion],
  );
  return (r.rowCount ?? 0) > 0;
}

/** What one banking step did to an entry, and whether it changed anything. */
type Step = (row: LedgerRow) => RunTimeLedgerEntry;

// Re-reads entry, version and read instant together on every lost race, so no
// write is computed against a value another writer has replaced.
export async function applyToLedger(
  taskId: string,
  identity: RunIdentityRef,
  step: Step,
): Promise<RunTimeLedgerEntry | null> {
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const row = await readLedger(taskId, identity);
    if (!row) return null;
    const merged = step(row);
    if (merged === row.entry) return row.entry;
    if (await writeLedger(taskId, merged, row.ledgerVersion)) return merged;
  }
  logger.warn({ taskId, attempts: MAX_CAS_ATTEMPTS }, "run_time.ledger_cas_exhausted");
  return null;
}

// The queued total comes from the row, not the report: no worker observes the
// queue, and a run that timed out in it never allocated an attempt to report
// under. Banking by difference needs no flag to be once-only.
export function bankReportAndQueue(row: LedgerRow, report?: RunTimeReportInput): RunTimeLedgerEntry {
  const queued = bankQueuedMs(row.entry, row.queuedTotalMs, row.readAtDb);
  if (!report || !isCoveringReport(report)) return queued;
  return mergeRunTimeReport(queued, report, row.readAtDb);
}

/**
 * Bank whatever queue time the row has measured and the entry has not.
 *
 * Its own entry point because two of the three observers -- the attempt's
 * allocating write and the sweeper's settle pass -- have no report to merge and
 * only ever need this half.
 */
export async function bankQueuedTime(taskId: string): Promise<RunTimeLedgerEntry | null> {
  return applyToLedger(taskId, { key: taskId, source: "task_id" }, (row) =>
    bankQueuedMs(row.entry, row.queuedTotalMs, row.readAtDb));
}

/**
 * Open this attempt's durable record, at the instant the row accepted it.
 *
 * The start instant is the attempt's own: the row's `started_at` is COALESCEd
 * across claims and names the first attempt's start for every later one.
 */
export async function openAttemptRecordFor(taskId: string, attemptId: string): Promise<void> {
  await applyToLedger(taskId, { key: taskId, source: "task_id" }, (row) => {
    // A late duplicate of the running event would otherwise open a second,
    // never-closed record on a run that has already ended.
    if (row.attemptId !== attemptId || isTerminal(row)) return row.entry;
    return beginAttemptRecord(
      bankQueuedMs(row.entry, row.queuedTotalMs, row.readAtDb),
      attemptId, row.attemptGeneration, row.readAtDb,
    );
  }).catch(() => null);
}

// One step, because all three things it decides -- does the row still hold this
// attempt, is its record open, what may its report bank -- need the same read.
export async function mergeRenewal(
  taskId: string,
  attemptId: string,
  report: RunTimeReportInput | undefined,
): Promise<"merged" | "stale" | "unavailable"> {
  let stale = false;
  const applied = await applyToLedger(taskId, { key: taskId, source: "task_id" }, (row) => {
    // A release or a takeover between the fenced UPDATE and this read leaves
    // the row holding somebody else's attempt; the coverage is not this
    // ledger's any more.
    // A release moves the row to `queued` and a takeover replaces the attempt;
    // the first leaves `attempt_id` where it was, so status is half the answer.
    if (row.attemptId !== attemptId || !RENEWABLE_STATUSES.has(row.status)) {
      stale = true;
      return row.entry;
    }
    const opened = beginAttemptRecord(
      bankQueuedMs(row.entry, row.queuedTotalMs, row.readAtDb),
      attemptId, row.attemptGeneration, row.readAtDb,
    );
    const renewed = noteAttemptRenewal(opened, attemptId, row.heartbeatAtDb ?? row.readAtDb);
    return report && reportIsCurrent(row, report)
      ? mergeRunTimeReport(renewed, report, row.readAtDb)
      : renewed;
  });
  if (stale) return "stale";
  return applied ? "merged" : "unavailable";
}

/** What an attempt boundary settles, beyond moving the row's status. */
export interface RunSettlement {
  /** The attempt's last word on its own time, if it sent one. */
  report?: RunTimeReportInput;
  /**
   * Close the attempt's open record and compute what it lost.
   *
   * Named only when the caller knows which attempt it is settling; a release
   * that carries no report closes whichever attempt the row still holds, so an
   * attempt does not end with its record open and no instant on it.
   */
  closeAttempt?: boolean;
}

/**
 * Whether the row still holds the attempt a report was produced under.
 *
 * `lease_owner` cannot say: a claim restores a row to `preparing` under the
 * same pod name. Read in the same statement as the entry it would be banked to.
 */
/** The statuses a live attempt renews from; a release leaves all of them. */
const RENEWABLE_STATUSES = new Set(["preparing", "running", "cancelling"]);

/** Statuses a run can report time from. Anything else has already ended. */
const LIVE_STATUSES = new Set(["queued", "preparing", "running", "cancelling", "waiting_external", "waiting_deps"]);

/** Whether the row has ended, by its own status or its pinned terminal instant. */
export function isTerminal(row: LedgerRow): boolean {
  return row.completedAtDb !== null || !LIVE_STATUSES.has(row.status);
}

export function reportIsCurrent(row: LedgerRow, report: RunTimeReportInput): boolean {
  if (row.claimCount !== report.claimCount) return false;
  if (row.deliverySeq !== report.deliverySeq || row.deliveryCount !== report.deliveryCount) {
    return false;
  }
  // A null attempt id is a claim that has begun no attempt yet, which a report
  // claiming to be from one cannot be reconciled with.
  return row.attemptId === report.attemptId;
}

// Under a row lock rather than the optimistic retry: the merge and the row's
// transition commit together, or a superseded attempt's last report lands in a
// ledger that is no longer its own.
export type SettleOutcome =
  | { ok: true; entry: RunTimeLedgerEntry }
  | { ok: false; reason: "missing" | "stale_attempt" };

export async function settleRunTime(
  query: Querier,
  taskId: string,
  settlement: RunSettlement,
): Promise<SettleOutcome> {
  const identity = settlement.report
    ? { key: settlement.report.key, source: "task_id" as const }
    : { key: taskId, source: "task_id" as const };
  const row = await readLedgerForUpdate(query, taskId, identity);
  if (!row) return { ok: false, reason: "missing" };
  if (settlement.report && !reportIsCurrent(row, settlement.report)) {
    return { ok: false, reason: "stale_attempt" };
  }
  const banked = bankReportAndQueue(row, settlement.report);
  const closing = settlement.closeAttempt
    ? (settlement.report?.attemptId ?? row.attemptId)
    : null;
  const closed = closing ? endAttemptRecord(banked, closing, row.readAtDb) : banked;
  if (closed !== row.entry) await writeLedger(taskId, closed, row.ledgerVersion, query);
  return { ok: true, entry: closed };
}

/**
 * Pin a terminal run's entry once, and bank whatever the queue still owes it.
 *
 * Terminality is recognised rather than signalled, so a path with no reporter
 * at all still gets its instant pinned. What no report covered stays unbanked.
 */
export async function settleTerminalRuns(limit = 200): Promise<number> {
  const r = await db.query(
    `SELECT task_id FROM claw_tasks
      WHERE completed_at IS NOT NULL
        AND COALESCE((metadata->'run_phase'->'ledger'->>'settled')::boolean, false) = false
      ORDER BY completed_at DESC
      LIMIT $1`,
    [limit],
  );
  let settled = 0;
  for (const row of r.rows as Array<{ task_id: string }>) {
    const entry = await applyToLedger(row.task_id, { key: row.task_id, source: "task_id" }, (read) => {
      const banked = bankQueuedMs(read.entry, read.queuedTotalMs, read.readAtDb);
      // Clamped upward against the anchor: `completed_at` is written with a
      // transaction-start NOW(), so it can sit behind an anchor a later
      // transaction already advanced.
      const terminalAtDb = read.completedAtDb
        && Date.parse(read.completedAtDb) > Date.parse(banked.lastAcceptedInstantDb)
        ? read.completedAtDb
        : banked.lastAcceptedInstantDb;
      return { ...banked, terminalAtDb, settled: true };
    });
    if (entry) settled++;
  }
  return settled;
}
