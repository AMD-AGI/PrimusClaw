// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who owns a finished run's workspace, and by which record it is found.
 *
 * Both questions are about the rows a statement matches rather than the text it
 * sends, so they are asked against a real database. The reference and the
 * writer claim are separate records and either outlives the other, so a
 * resolution that reads one of them loses every claim recorded under the other.
 * And two passes now release the same references: the generic reconciler here
 * and the compensation finalizer in the sweeper. A row both act on is released
 * twice, once as changed, ahead of the verification the finalizer owes; a row
 * neither claims is released by nobody.
 */

import "./reconcile-on-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, type Harness } from "./scenario-harness.js";
import { releaseRefsOfFinishedRuns, releaseRunUseStrict } from "../src/workspace/store.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

async function seedWorkspace(
  workspaceId: string,
  opts: { writerRunId?: string; refOf?: string; refReleased?: boolean } = {},
): Promise<void> {
  await h.sql(
    `INSERT INTO claw_workspaces (workspace_id, session_id, writer_run_id) VALUES ($1, 's1', $2)`,
    [workspaceId, opts.writerRunId ?? null],
  );
  if (opts.refOf) {
    await h.sql(
      `INSERT INTO claw_workspace_refs (workspace_id, ref_kind, ref_id, released_at)
       VALUES ($1, 'run', $2, CASE WHEN $3::bool THEN NOW() ELSE NULL END)`,
      [workspaceId, opts.refOf, opts.refReleased ?? false],
    );
  }
}

async function writerOf(workspaceId: string): Promise<string | null> {
  const rows = await h.sql(
    `SELECT writer_run_id FROM claw_workspaces WHERE workspace_id = $1`, [workspaceId],
  );
  return (rows[0]?.writer_run_id ?? null) as string | null;
}

async function liveRefs(): Promise<string[]> {
  const rows = await h.sql(
    `SELECT ref_id FROM claw_workspace_refs WHERE released_at IS NULL ORDER BY ref_id`,
  );
  return rows.map((r) => r.ref_id as string);
}

test("a run whose reference was already released still lets go of the write side", async () => {
  // The live-reference lookup is exactly the record that is gone here, so a
  // resolution built on it leaves the claim standing for the rest of the
  // workspace's retention and no later pass can find it.
  await seedWorkspace("kws_a", { writerRunId: "t1", refOf: "t1", refReleased: true });

  assert.equal(await releaseRunUseStrict("t1", false), "released");
  assert.equal(await writerOf("kws_a"), null);
});

test("a claim recorded with no reference behind it is still found", async () => {
  // The other order: the acquire failed and the claim was taken anyway, which
  // is the state the fixed takeRunRef stops being created and this clears.
  await seedWorkspace("kws_a", { writerRunId: "t1" });

  assert.equal(await releaseRunUseStrict("t1", false), "released");
  assert.equal(await writerOf("kws_a"), null);
});

test("two workspaces answering for one run releases neither", async () => {
  await seedWorkspace("kws_a", { refOf: "t1", refReleased: true });
  await seedWorkspace("kws_b", { writerRunId: "t1" });

  assert.equal(await releaseRunUseStrict("t1", false), "ambiguous");
  assert.equal(await writerOf("kws_b"), "t1", "picking a side of a split is worse than reporting it");
});

test("a run nothing recorded is not a failure", async () => {
  assert.equal(await releaseRunUseStrict("t1", false), "none_held");
});

test("a reference the compensation finalizer owns is not released here", async () => {
  // Released here it would go as changed -- bumping the version for a run that
  // never executed -- and the finalizer would then be unable to prove the
  // cleanup it owes before marking the receipt complete.
  const { finalizeDispatchCompensations } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "failed", dispatch: "fat" });
  await h.sql(
    `UPDATE claw_tasks SET metadata = metadata || $2::jsonb WHERE task_id = $1`,
    ["t1", JSON.stringify({ dispatch_compensation: { version: 1, state: "armed", publish: "refused" } })],
  );
  await seedWorkspace("kws_a", { writerRunId: "t1", refOf: "t1" });

  assert.equal(await releaseRefsOfFinishedRuns(), 0);
  assert.deepEqual(await liveRefs(), ["t1"], "still held, by the pass that has to verify it let go");

  assert.equal(await finalizeDispatchCompensations(), 1, "and that pass does act on it");
  assert.deepEqual(await liveRefs(), []);
  const version = (await h.sql(`SELECT version FROM claw_workspaces WHERE workspace_id = 'kws_a'`))[0];
  assert.equal(Number(version.version), 0, "a never-held failed row wrote nothing");
});

test("a terminal fat row with no receipt at all is the finalizer's too", async () => {
  const { finalizeDispatchCompensations } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "failed", dispatch: "fat" });
  await seedWorkspace("kws_a", { writerRunId: "t1", refOf: "t1" });

  assert.equal(await releaseRefsOfFinishedRuns(), 0);
  assert.equal(await finalizeDispatchCompensations(), 1);
  assert.deepEqual(await liveRefs(), []);
});

test("a receipt no pass in this deployment can act on keeps this reconciler as its owner", async () => {
  // The finalizer refuses a contract it does not know and leaves the row byte
  // for byte. Excluding it here as well would leave the reference held by
  // nobody, which is the one state that stops the files ageing out at all.
  const { finalizeDispatchCompensations } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "failed", dispatch: "fat" });
  await h.sql(
    `UPDATE claw_tasks SET metadata = metadata || $2::jsonb WHERE task_id = $1`,
    ["t1", JSON.stringify({ dispatch_compensation: { version: 2, state: "armed", publish: "refused" } })],
  );
  await seedWorkspace("kws_a", { writerRunId: "t1", refOf: "t1" });

  assert.equal(await finalizeDispatchCompensations(), 0);
  assert.equal(await releaseRefsOfFinishedRuns(), 1);
  assert.deepEqual(await liveRefs(), []);
});

test("a row with holder evidence, and an ordinary doorbell row, are still released here", async () => {
  // The exclusion has to be the finalizer's set and no wider: a run that
  // executed is outside it on holder evidence alone, and a doorbell row carries
  // no receipt and is not a fat row.
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "completed", dispatch: "fat", leaseOwner: "brain-a", claimCount: 1,
  });
  await seedRun(h, "bell", "s1", { status: "completed", dispatch: "doorbell" });
  await seedWorkspace("kws_a", { refOf: "held" });
  await seedWorkspace("kws_b", { refOf: "bell" });

  assert.equal(await releaseRefsOfFinishedRuns(), 2);
  assert.deepEqual(await liveRefs(), []);
});
