// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The unreleased record, run against a real Postgres rather than a stand-in.
 *
 * Every other test of this feature replaces `unreleasedRecord` with an
 * in-memory Map, which is the right shape for asserting what the teardown does
 * with the answer -- and exactly the wrong thing to trust about the record
 * itself. A Map cannot disagree with its own implementation. These statements
 * can: they are hand-written jsonb merges against a column shared with
 * everything else a task keeps, and the failure they would have is silent.
 * A `mark` that overwrote `metadata` would wipe `derived.handle_last_user` and
 * take the DAG's whole teardown plan with it; a `clear` that missed would
 * leave a DAG permanently unconfirmed; an `any` that read the wrong path would
 * answer `nothing_held` for a leak, which is the one answer this must never
 * invent.
 *
 * PGlite is Postgres compiled to WASM and the schema is `clawTasksSchemaSql()`,
 * the same DDL the cluster gets -- so `||`, `-` and `jsonb_build_object`
 * behave here as they will there. See SCENARIOS.md.
 *
 * Coverage:
 *   U1 a mark is readable, and leaves the rest of `metadata` alone
 *   U2 marks accumulate per handle instead of replacing one another
 *   U3 clearing one handle leaves the others outstanding
 *   U4 clearing the last one makes the DAG answer "nothing outstanding"
 *   U5 clearing a handle that was never marked is a no-op, not a throw
 *   U6 the record is written to the DAG ROOT row, not to a node that shares the id
 *   U7 a DAG root that does not exist is an unknown, not "nothing outstanding"
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const { unreleasedRecord } = await import("../src/tasks/sandbox-stopper.js");

/** A DAG root carrying the metadata a real root carries. */
async function seedDagRoot(taskId = "t-root"): Promise<void> {
  await seedSession(h, "s-1");
  await seedRun(h, taskId, "s-1");
  await h.sql(
    `UPDATE claw_tasks
        SET dag_node_id = '__dag_root__',
            dag_root_task_id = $1,
            metadata = metadata || '{"derived":{"handle_last_user":{"main":"n-2"}}}'::jsonb
      WHERE task_id = $1`,
    [taskId],
  );
}

async function metadata(taskId = "t-root"): Promise<Record<string, unknown>> {
  const rows = await h.sql(`SELECT metadata FROM claw_tasks WHERE task_id = $1`, [taskId]);
  return rows[0].metadata as Record<string, unknown>;
}

beforeEach(async () => { await h.reset(); });

test("U1 a mark is readable, and leaves the rest of metadata alone", async () => {
  await seedDagRoot();
  assert.equal(await unreleasedRecord.any("t-root"), false, "nothing outstanding to begin with");

  await unreleasedRecord.mark("t-root", "main", "w-1");

  assert.equal(await unreleasedRecord.any("t-root"), true);
  const meta = await metadata();
  // The part that would be silent: `metadata` is shared, and the teardown plan
  // for this very DAG lives one key over from what was just written.
  assert.deepEqual(
    (meta.derived as Record<string, unknown>)?.handle_last_user, { main: "n-2" },
    "a write to sandbox_release must not take the rest of the row's metadata with it",
  );
  const entry = ((meta.sandbox_release as Record<string, unknown>)
    ?.unreleased as Record<string, { workload_id: string; at: string }>)?.main;
  assert.equal(entry.workload_id, "w-1", "and the workload id is kept, not just the fact");
  assert.ok(Date.parse(entry.at) > 0, "with a timestamp an operator can age the leak by");
});

test("U2 marks accumulate per handle instead of replacing one another", async () => {
  await seedDagRoot();
  await unreleasedRecord.mark("t-root", "a", "w-a");
  await unreleasedRecord.mark("t-root", "b", "w-b");

  const outstanding = (await metadata()).sandbox_release as { unreleased: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(outstanding.unreleased).sort(), ["a", "b"],
    "a DAG can leak more than one sandbox, and the second must not erase the first",
  );
});

test("U3 clearing one handle leaves the others outstanding", async () => {
  await seedDagRoot();
  await unreleasedRecord.mark("t-root", "a", "w-a");
  await unreleasedRecord.mark("t-root", "b", "w-b");

  await unreleasedRecord.clear("t-root", "a");

  assert.equal(await unreleasedRecord.any("t-root"), true, "b is still unreleased");
  const outstanding = (await metadata()).sandbox_release as { unreleased: Record<string, unknown> };
  assert.deepEqual(Object.keys(outstanding.unreleased), ["b"]);
});

test("U4 clearing the last one makes the DAG answer nothing outstanding", async () => {
  // The record must not be a latch. A DAG that leaked once, and whose later
  // teardown succeeded, has to be able to say so -- otherwise every cancel of
  // it reports `unconfirmed` forever and the field stops meaning anything.
  await seedDagRoot();
  await unreleasedRecord.mark("t-root", "a", "w-a");
  await unreleasedRecord.clear("t-root", "a");

  assert.equal(await unreleasedRecord.any("t-root"), false);
});

test("U5 clearing a handle that was never marked is a no-op", async () => {
  await seedDagRoot();
  await unreleasedRecord.clear("t-root", "never-marked");

  assert.equal(await unreleasedRecord.any("t-root"), false);
  assert.deepEqual(
    ((await metadata()).derived as Record<string, unknown>)?.handle_last_user, { main: "n-2" },
    "and it still does not disturb the rest of the row",
  );
});

test("U6 the record is written to the DAG root row, not to a node of the same DAG", async () => {
  // Both rows carry `dag_root_task_id = 't-root'`; only one is the root. The
  // predicate that separates them is the whole reason `any` can read back what
  // `mark` wrote, and a statement missing it would write to whichever row the
  // planner reached first.
  await seedDagRoot();
  await seedRun(h, "t-node", "s-1");
  await h.sql(
    `UPDATE claw_tasks SET dag_node_id = 'n-2', dag_root_task_id = 't-root' WHERE task_id = 't-node'`,
  );

  await unreleasedRecord.mark("t-root", "main", "w-1");

  assert.equal(
    JSON.stringify(await metadata("t-node")).includes("sandbox_release"), false,
    "a node row is not where a caller of GET /v1/tasks/<dag root> would look",
  );
  assert.equal(await unreleasedRecord.any("t-root"), true);
});

test("U7 a DAG root that does not exist is an unknown, not nothing outstanding", async () => {
  // `any` backs the one answer that must never be invented. With no row there
  // is no record to read, which is not the same as a record that is empty, and
  // the teardown turns this throw into `unconfirmed`.
  await assert.rejects(() => unreleasedRecord.any("t-nonexistent"));
});
