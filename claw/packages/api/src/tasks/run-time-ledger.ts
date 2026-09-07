// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a run's time ledger lives on the row, and how a report reaches it.
 *
 * The merge rule itself is in @claw/protocol -- pure, total, and shared with
 * the worker that produces the reports. What is here is everything that makes
 * applying it safe against the row: reading the stored entry, its version and
 * a database-clock instant in one statement, and writing back only if nobody
 * else has written since.
 *
 * Every instant is `clock_timestamp()`, never `NOW()`. `NOW()` is fixed at
 * transaction start, so a transaction that began earlier and commits later can
 * pair its own older instant with an anchor a later transaction already
 * advanced -- a negative coverage budget, or a terminal instant behind the
 * anchor.
 */
import pino from "pino";

import {
  appendAttemptRecord,
  bankQueuedMs,
  isCoveringReport,
  mergeRunTimeReport,
  newRunTimeLedgerEntry,
  recoveryLossForAttempt,
  type AttemptRecord,
  type RunIdentityRef,
  type RunTimeLedgerEntry,
  type RunTimeReportInput,
} from "@claw/protocol";
import { db, type Querier } from "../infra/db.js";

const logger = pino({ name: "run-time-ledger" });

/** How many times a merge may lose the compare-and-swap before giving up. */
const MAX_CAS_ATTEMPTS = 5;

/**
 * The row's own view of a run's time, read in one statement.
 *
 * `queuedTotalMs` closes the open segment at read time, so it is complete the
 * moment the row stops being queued and needs no knowledge of which statement
 * ended it.
 */
const READ_LEDGER_SQL = `
  SELECT metadata->'run_phase'->'ledger' AS ledger,
         ledger_version,
         status,
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
  readAtDb: string;
  completedAtDb: string | null;
  queuedTotalMs: number;
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

function readRow(row: Record<string, unknown> | undefined, identity: RunIdentityRef): LedgerRow | null {
  if (!row) return null;
  const readAtDb = iso(row.read_at);
  const queuedAtDb = row.queued_at ? iso(row.queued_at) : readAtDb;
  const stored = row.ledger as RunTimeLedgerEntry | null;
  return {
    entry: stored ?? newRunTimeLedgerEntry(identity, queuedAtDb),
    ledgerVersion: Number(row.ledger_version ?? 0),
    status: String(row.status ?? ""),
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
 * @returns whether this writer won. A loser must re-read the entry, its
 *          version and a fresh read instant together -- the coverage budget is
 *          computed from that pair -- rather than retrying the same merge.
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

/**
 * Apply a step under compare-and-swap, re-reading on every lost race.
 *
 * The re-read takes the entry, the version and the read instant in one
 * statement again, so no write is ever computed against a value another writer
 * has already replaced.
 */
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

/**
 * Bank whatever a report covers, plus whatever queue time is still outstanding.
 *
 * The queued total comes from the row rather than from the report: no worker
 * observes the queue, and a run that timed out in it never allocated an attempt
 * to report under. Banking by difference makes whichever observer arrives first
 * the one that banks, with no flag to coordinate.
 */
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

/** What an attempt boundary settles, beyond moving the row's status. */
export interface RunSettlement {
  /** The attempt's last word on its own time, if it sent one. */
  report?: RunTimeReportInput;
  /** The attempt being closed; its recovery loss is computed here. */
  attempt?: Omit<AttemptRecord, "recoveryLoss" | "endedAtDb">;
}

/**
 * Bank an attempt's final report and close its record, holding the row.
 *
 * Under a row lock rather than the optimistic retry: the merge and the row's
 * own transition have to commit together, or a superseded attempt's last report
 * lands in a ledger that no longer belongs to it.
 */
export async function settleRunTime(
  query: Querier,
  taskId: string,
  settlement: RunSettlement,
): Promise<RunTimeLedgerEntry | null> {
  const identity = settlement.report
    ? { key: settlement.report.key, source: "task_id" as const }
    : { key: taskId, source: "task_id" as const };
  const row = await readLedgerForUpdate(query, taskId, identity);
  if (!row) return null;
  const banked = bankReportAndQueue(row, settlement.report);
  const closed = settlement.attempt
    ? appendAttemptRecord(banked, {
        ...settlement.attempt,
        endedAtDb: row.readAtDb,
        recoveryLoss: recoveryLossForAttempt(
          { ...settlement.attempt, recoveryLoss: { computable: false, lossMs: null } },
          row.readAtDb,
        ),
      })
    : banked;
  if (closed === row.entry) return row.entry;
  await writeLedger(taskId, closed, row.ledgerVersion, query);
  return closed;
}

/**
 * Pin a terminal run's entry once, and bank whatever the queue still owes it.
 *
 * Terminality is recognised rather than signalled: no terminal statement is
 * hooked, so a path with no reporter at all -- a queue-timeout reap, a
 * cancellation, a session deletion -- still gets its instant pinned and its
 * queue time banked. What no report covered stays unbanked, which is the honest
 * answer: nobody said what the run was doing, not that it was unknowable.
 */
export async function settleTerminalRuns(limit = 200): Promise<number> {
  const r = await db.query(
    `SELECT task_id FROM claw_tasks
      WHERE completed_at IS NOT NULL
        AND COALESCE((metadata->'run_phase'->'ledger'->>'settled')::boolean, false) = false
        AND metadata->'run_phase' IS NOT NULL
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
