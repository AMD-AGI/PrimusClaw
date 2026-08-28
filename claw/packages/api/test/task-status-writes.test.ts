// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * That a task's status can only be changed by a compare-and-set.
 *
 * More than one actor can be touching a row at once -- a sweeper deciding it is
 * stale, a late `agent_done` from a run that was cancelled meanwhile, a
 * redelivered execution message -- so every status change states which statuses
 * it is legal to arrive from and does nothing if the row has moved on. The
 * generic patch helper could write any column, `status` included, and an
 * unconditional write from there would win those races silently while also
 * skipping the timestamps and the deadline that a transition stamps.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import { updateTask, transitionStatus } from "../src/tasks/db.js";

interface SeenQuery { sql: string; params: unknown[] }

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

function stubDb(): SeenQuery[] {
  const seen: SeenQuery[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    seen.push({ sql: text.replace(/\s+/g, " ").trim(), params });
    return { rows: [{ task_id: "ktsk_1" }], rowCount: 1 };
  }) as typeof db.query;
  return seen;
}

test("the generic patch helper refuses to write status", async () => {
  const seen = stubDb();
  await assert.rejects(
    () => updateTask("ktsk_1", { status: "completed" }),
    /use transitionStatus/,
  );
  assert.deepEqual(seen, [], "and refuses before touching the database");
});

test("it still refuses when status is smuggled in beside legitimate columns", async () => {
  const seen = stubDb();
  await assert.rejects(
    () => updateTask("ktsk_1", { output: "done", status: "completed" }),
    /use transitionStatus/,
  );
  assert.deepEqual(seen, []);
});

test("patching other columns is unaffected", async () => {
  const seen = stubDb();
  await updateTask("ktsk_1", { output: "hello", workspace_id: "ws-1" });
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /^UPDATE claw_tasks SET output = \$1, workspace_id = \$2/);
});

test("a transition states the statuses it may arrive from", async () => {
  const seen = stubDb();
  await transitionStatus("ktsk_1", ["preparing"], "running");

  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /WHERE task_id = \$\d+ AND status = ANY\(\$\d+\)/);
  assert.deepEqual(seen[0].params[seen[0].params.length - 1], ["preparing"]);
});

test("starting a run stamps its clocks without resetting them on re-entry", async () => {
  const seen = stubDb();
  await transitionStatus("ktsk_1", ["preparing"], "running");

  // Both COALESCE, so a row passing preparing -> running keeps the moment work
  // began and does not collect a second budget on the way through.
  assert.match(seen[0].sql, /started_at = COALESCE\(started_at, NOW\(\)\)/);
  assert.match(seen[0].sql, /deadline_at = COALESCE\( deadline_at/);
});
