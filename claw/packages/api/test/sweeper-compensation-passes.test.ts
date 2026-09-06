// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The three passes that reconcile a fat dispatch nobody finished, and the
 * containment that keeps one of them failing from costing the rest of a tick.
 *
 * Each is written against row state rather than statement text, because the
 * failures they exist for are predicates that are present and match the wrong
 * rows: the finalizer adopting a receipt it should refuse, the audit acting
 * where it must only report, a throw taking the tick's later work with it.
 */

import "./reconcile-on-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  startHarness, seedSession, seedRun, runRow, type Harness,
} from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

async function setReceipt(taskId: string, receipt: unknown): Promise<void> {
  await h.sql(
    "UPDATE claw_tasks SET metadata = metadata || jsonb_build_object('dispatch_compensation', $2::jsonb) WHERE task_id = $1",
    [taskId, JSON.stringify(receipt)],
  );
}

async function receiptOf(taskId: string): Promise<Record<string, unknown> | undefined> {
  const meta = (await runRow(h, taskId)).metadata as Record<string, unknown>;
  return meta.dispatch_compensation as Record<string, unknown> | undefined;
}

test("a terminal row whose terminalizer left an armed receipt is adopted and completed", async () => {
  // Existing terminal writers do not all know about the receipt, so the
  // finalizer owns adoption rather than each closer learning to write one.
  const { finalizeDispatchCompensations } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "failed", dispatch: "fat" });
  await h.sql("UPDATE claw_tasks SET failure_reason = 'cancelled', error_message = 'stopped' WHERE task_id = 't1'");
  await setReceipt("t1", { version: 1, state: "armed", publish: "refused" });

  assert.equal(await finalizeDispatchCompensations(), 1);
  assert.deepEqual(await receiptOf("t1"), {
    version: 1, state: "complete", failure_reason: "cancelled", error_message: "stopped",
  });
});

test("a receipt written by a contract this deployment does not know is left untouched", async () => {
  const { finalizeDispatchCompensations, auditRefusedCompensations } =
    await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "failed", dispatch: "fat" });
  const foreign = { version: 2, state: "armed", publish: "not_attempted" };
  await setReceipt("t1", foreign);

  assert.equal(await finalizeDispatchCompensations(), 0, "no writing pass may act on it");
  assert.deepEqual(await receiptOf("t1"), foreign, "and it is left byte for byte");
  assert.equal(await auditRefusedCompensations(), 1, "the write-free pass reports it instead");
});

test("the audit reports and changes nothing", async () => {
  const { auditRefusedCompensations } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "failed", dispatch: "fat" });
  await setReceipt("t1", { version: 1, state: "elsewhere" });
  const before = await runRow(h, "t1");

  assert.equal(await auditRefusedCompensations(), 1);
  assert.deepEqual(await runRow(h, "t1"), before);
});

test("a completed run releases its workspace as changed, a failed one as untouched", async () => {
  // The one outcome that is evidence work happened must not be recorded as a
  // run that wrote nothing, and the reverse must not bump a version for a run
  // that never started. Read off the writer release's own parameter rather
  // than a stub, so what is asserted is the statement the database sees.
  const { finalizeDispatchCompensations } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  for (const [taskId, status] of [["done", "completed"], ["gone", "failed"]] as const) {
    await seedRun(h, taskId, "s1", { status, dispatch: "fat", messageId: `m-${taskId}` });
    await setReceipt(taskId, {
      version: 1, state: "terminal", failure_reason: null, error_message: null,
    });
    await h.sql(
      `INSERT INTO claw_workspaces (workspace_id, session_id, writer_run_id) VALUES ($1, 's1', $2)`,
      [`kws_${taskId}`, taskId],
    );
    await h.sql(
      `INSERT INTO claw_workspace_refs (workspace_id, ref_kind, ref_id) VALUES ($1, 'run', $2)`,
      [`kws_${taskId}`, taskId],
    );
  }

  await finalizeDispatchCompensations();

  const versions = Object.fromEntries((await h.sql(
    "SELECT workspace_id, version FROM claw_workspaces",
  )).map((row) => [row.workspace_id, Number(row.version)]));
  assert.equal(versions.kws_done, 1, "a completed run's release bumps the version");
  assert.equal(versions.kws_gone, 0, "a run that never started leaves it alone");
});

test("a throw from one pass leaves the rest of the tick, and the key prune, alone", async () => {
  // Each pass is contained independently; the final idempotency-key delete is
  // the one that must survive whatever the passes before it did.
  const { sweeperTick } = await import("../src/tasks/sweeper.js");
  const { db } = await import("../src/infra/db.js");
  const real = db.query;
  const seen: string[] = [];
  db.query = (async (text: string, params?: unknown[]) => {
    seen.push(text.replace(/\s+/g, " ").trim());
    if (/dispatch_reconcile_at IS NOT NULL\s+AND dispatch_reconcile_at < NOW\(\)/.test(text)) {
      throw new Error("reconcile pass exploded");
    }
    return (real as never as (a: string, b?: unknown[]) => Promise<unknown>)(text, params);
  }) as typeof db.query;
  try {
    await sweeperTick();
  } finally {
    db.query = real;
  }
  assert.ok(
    seen.some((sql) => /DELETE FROM claw_idempotency_keys/.test(sql)),
    "the tick's last statement still ran",
  );
  assert.ok(
    seen.some((sql) => /status IN \('preparing','running','cancelling'\)/.test(sql)),
    "and the passes after the throw still ran",
  );
});
