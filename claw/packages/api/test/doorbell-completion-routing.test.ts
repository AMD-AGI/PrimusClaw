// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which row a completion is allowed to close.
 *
 * Routing is by what the named row *is*, never by whether the field is present:
 * DAG and standalone execute requests have always carried `task_id`, so a rule
 * keyed on presence would either suppress their existing processing or
 * terminalize their rows before their own authoritative result applied. And an
 * event that names no row must refuse to guess whenever the guess could be
 * wrong, rather than redirect the close onto a sibling somebody else holds.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, runRow, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

test("a task id naming a DAG row is not a chat completion", async () => {
  const { resolveChatRunProvenance } = await import("../src/events/consumer.js");
  await seedSession(h, "s1");
  await seedRun(h, "dag-1", "s1", { status: "running", origin: "dag_node" });

  assert.equal(await resolveChatRunProvenance({ task_id: "dag-1" }), "foreign");
});

test("a task id naming no row at all is not a chat completion either", async () => {
  const { resolveChatRunProvenance } = await import("../src/events/consumer.js");
  assert.equal(await resolveChatRunProvenance({ task_id: "gone" }), "foreign");
});

test("a task id naming a chat row is the row that completion closes", async () => {
  const { resolveChatRunProvenance } = await import("../src/events/consumer.js");
  await seedSession(h, "s1");
  await seedRun(h, "chat-1", "s1", { status: "running", dispatch: "fat" });

  assert.equal(await resolveChatRunProvenance({ task_id: "chat-1" }), "chat-1");
  assert.equal(await resolveChatRunProvenance({}), null, "an event naming no task names none");
});

test("a completion closes the row it names and no sibling of it", async () => {
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "mine", "s1", { status: "running", dispatch: "fat", messageId: "m-1" });
  await seedRun(h, "other", "s1", { status: "running", dispatch: "fat", messageId: "m-2" });

  assert.deepEqual(await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "mine" }), ["mine"]);
  assert.equal((await runRow(h, "other")).status, "running");
});

test("a stale generation closes nothing, and the live one still can", async () => {
  // BRAIN_ID is a pod name, so after a same-pod takeover the previous attempt
  // is indistinguishable from its successor by owner alone. The generation is
  // what tells them apart.
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", {
    status: "running", dispatch: "fat", messageId: "m-1", leaseOwner: "brain-a",
    leaseExpiresInSec: 600, claimCount: 2,
  });

  assert.deepEqual(
    await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "t1", runClaim: 1 }),
    [],
    "the superseded attempt closes nothing",
  );
  assert.equal((await runRow(h, "t1")).status, "running");
  assert.deepEqual(
    await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "t1", runClaim: 2 }),
    ["t1"],
  );
});

test("an unfenced report cannot close a row a fenced holder took over", async () => {
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "running", dispatch: "fat", messageId: "m-1", claimCount: 1 });
  await h.sql(
    `UPDATE claw_tasks SET metadata = metadata || '{"lease_fenced":"true"}'::jsonb WHERE task_id = 't1'`,
  );

  assert.deepEqual(await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "t1" }), []);
  assert.equal((await runRow(h, "t1")).status, "running");
});

test("an unfenced holder is closed by a report that quotes no generation", async () => {
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "running", dispatch: "fat", messageId: "m-1", claimCount: 1 });

  assert.deepEqual(await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "t1" }), ["t1"]);
});

test("an unnamed completion refuses to guess once a row for its turn is terminal", async () => {
  // The event's own subject may be the row that is already closed, so choosing
  // the other one would close a turn nobody reported on.
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "done", "s1", { status: "completed", dispatch: "fat", messageId: "m-1" });
  await seedRun(h, "live", "s1", { status: "running", dispatch: "fat", messageId: "m-1" });

  assert.deepEqual(await closeChatRun("s1", "m-1", "completed"), []);
  assert.equal((await runRow(h, "live")).status, "running");
});

test("an unnamed completion refuses a fenced candidate, because a fenced holder names its task", async () => {
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "running", dispatch: "fat", messageId: "m-1" });
  await h.sql(
    `UPDATE claw_tasks SET metadata = metadata || '{"lease_fenced":"true"}'::jsonb WHERE task_id = 't1'`,
  );

  assert.deepEqual(await closeChatRun("s1", "m-1", "completed"), []);
});

test("a replayed dispatch's spare row is closed as the duplicate it is", async () => {
  // Never with the reporting run's outcome: this row executed nothing.
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "real", "s1", {
    status: "running", dispatch: "doorbell", messageId: "m-1", claimCount: 1,
  });
  await seedRun(h, "spare", "s1", { status: "queued", dispatch: "doorbell", messageId: "m-1" });

  assert.deepEqual(await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "real" }), ["real"]);
  const spare = await runRow(h, "spare");
  assert.equal(spare.status, "failed");
  assert.equal(spare.failure_reason, "duplicate_dispatch_row");
});

test("a sibling carrying holder evidence is left to its own holder", async () => {
  const { closeChatRun } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "real", "s1", { status: "running", dispatch: "doorbell", messageId: "m-1" });
  await seedRun(h, "held", "s1", {
    status: "preparing", dispatch: "doorbell", messageId: "m-1",
    leaseOwner: "brain-b", leaseExpiresInSec: 600, claimCount: 1,
  });

  await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "real" });
  assert.equal((await runRow(h, "held")).status, "preparing");
});
