// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { RunTimeLedgerEntry } from "@claw/protocol";

import { settleTerminalRuns } from "../src/tasks/run-time-ledger.js";
import { startHarness, seedRun, seedSession, runRow, type Harness } from "./scenario-harness.js";

const SESSION = "terminal-backfill";
const EPOCH = "2026-01-01T00:00:00.000Z";
let h: Harness;

before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });
beforeEach(async () => { await h.reset(); await seedSession(h, SESSION); });

async function seedTerminalRun(taskId: string, completedSeconds: number): Promise<void> {
  await seedRun(h, taskId, SESSION, { status: "failed", dispatch: "fat" });
  await h.sql(
    `UPDATE claw_tasks
        SET queued_at = $2::timestamptz, run_time_epoch_at = $2::timestamptz,
            queued_ms_accrued = 100,
            completed_at = $2::timestamptz + ($3::int * INTERVAL '1 second')
      WHERE task_id = $1`,
    [taskId, EPOCH, completedSeconds],
  );
}

async function settledTaskIds(): Promise<string[]> {
  const rows = await h.sql(
    `SELECT task_id FROM claw_tasks
      WHERE metadata->'run_phase'->'ledger'->>'settled' = 'true'
      ORDER BY completed_at ASC, task_id ASC`,
  );
  return rows.map((row) => String(row.task_id));
}

test("a terminal backfill tick settles at most 200 rows by default", async () => {
  const ids = Array.from({ length: 205 }, (_, i) => `run-${String(i).padStart(3, "0")}`);
  for (let i = ids.length - 1; i >= 0; i--) await seedTerminalRun(ids[i]!, i + 1);

  assert.equal(await settleTerminalRuns(), 200);
  assert.deepEqual(await settledTaskIds(), ids.slice(0, 200));
  assert.equal(await settleTerminalRuns(), 5);
  assert.deepEqual(await settledTaskIds(), ids);

  const before = await h.sql("SELECT task_id, ledger_version, metadata FROM claw_tasks ORDER BY task_id");
  h.statements.length = 0;
  assert.equal(await settleTerminalRuns(), 0);
  assert.deepEqual(
    await h.sql("SELECT task_id, ledger_version, metadata FROM claw_tasks ORDER BY task_id"),
    before,
  );
  assert.deepEqual(h.statements.filter((sql) => sql.startsWith("UPDATE claw_tasks")), []);
});

test("bounded backfill passes drain older runs while new completions arrive", async () => {
  for (let i = 4; i >= 0; i--) await seedTerminalRun(`old-${i}`, i + 1);

  assert.equal(await settleTerminalRuns(2), 2);
  assert.deepEqual(await settledTaskIds(), ["old-0", "old-1"]);

  await seedTerminalRun("new-0", 100);
  await seedTerminalRun("new-1", 101);
  assert.equal(await settleTerminalRuns(2), 2);
  assert.deepEqual(await settledTaskIds(), ["old-0", "old-1", "old-2", "old-3"]);

  await seedTerminalRun("new-2", 102);
  assert.equal(await settleTerminalRuns(2), 2);
  assert.deepEqual(await settledTaskIds(), ["old-0", "old-1", "old-2", "old-3", "old-4", "new-0"]);
  assert.equal(await settleTerminalRuns(2), 2);
  assert.equal(await settleTerminalRuns(2), 0);
  assert.deepEqual(await settledTaskIds(), ["old-0", "old-1", "old-2", "old-3", "old-4", "new-0", "new-1", "new-2"]);
});

test("equal completion times use a stable order and include runs with no reporter", async () => {
  await seedTerminalRun("run-b", 1);
  await seedTerminalRun("run-a", 1);
  await seedRun(h, "run-live", SESSION, { status: "running" });
  assert.deepEqual(
    await h.sql("SELECT metadata->'run_phase' AS phase FROM claw_tasks ORDER BY task_id"),
    [{ phase: null }, { phase: null }, { phase: null }],
  );

  assert.equal(await settleTerminalRuns(1), 1);
  assert.deepEqual(await settledTaskIds(), ["run-a"]);
  const row = await runRow(h, "run-a");
  const entry = (row.metadata as { run_phase: { ledger: RunTimeLedgerEntry } }).run_phase.ledger;
  assert.equal(entry.settled, true);
  assert.equal(entry.epochInstantDb, EPOCH);
  assert.equal(entry.terminalAtDb, "2026-01-01T00:00:01.000Z");
  assert.equal(entry.knownMsByState.queued, 100);
  assert.deepEqual(entry.attempts, []);

  assert.equal(await settleTerminalRuns(1), 1);
  assert.deepEqual(await settledTaskIds(), ["run-a", "run-b"]);
  assert.equal(await settleTerminalRuns(1), 0);
  assert.equal((await runRow(h, "run-live")).ledger_version, 0);
});
