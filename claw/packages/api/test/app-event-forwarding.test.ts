// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The API's half of event forwarding (hosting design 5.7), on PGlite running the
 * production statements: the consumer stores an application's progress event
 * once however often Brain publishes it, the live and replayed streams show it
 * once, and the cursor Brain writes after a publish is validated and stored.
 *
 * The consumer's de-duplication is a unique index, so the index under test is
 * the one initDb builds (`APP_EVENT_UNIQUE_INDEX_SQL`), not a copy.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { APP_EVENT_ID, APP_EVENT_SEGMENT_NAME } from "@claw/protocol";
import { consumeEventDelivery, tombstoneReader } from "../src/events/consumer.js";
import { APP_EVENT_UNIQUE_INDEX_SQL } from "../src/infra/db.js";
import { appEventIdentity, appEventKey } from "../src/events/app-events.js";
import { historySegment, isRepeatOfStoredAppEvent } from "../src/routes/events.js";
import { parseAppRunPatch } from "../src/routes/internal-apps.js";
import { patchAppRun, readAppRun } from "../src/tasks/app-run-state.js";
import { startHarness, type Harness } from "./scenario-harness.js";

let harness: Harness;
let originalHas: typeof tombstoneReader.has;

before(async () => {
  harness = await startHarness();
  originalHas = tombstoneReader.has;
  tombstoneReader.has = async () => false;
  await harness.sql(APP_EVENT_UNIQUE_INDEX_SQL);
});
beforeEach(async () => { await harness.reset(); });
after(async () => {
  tombstoneReader.has = originalHas;
  await harness.close();
});

const appEvent = (task: string, id: string, data: Record<string, unknown> = {}) => ({
  type: "appEvent", app_task_id: task,
  event: { specversion: "1.0", id, source: "app/run", type: "x.y", data },
});

async function deliver(event: Record<string, unknown>, seq: number, session = "s1"): Promise<string[]> {
  const verdicts: string[] = [];
  await consumeEventDelivery({
    subject: `events.${session}`,
    data: new TextEncoder().encode(JSON.stringify(event)),
    seq,
    ack: () => { verdicts.push("ack"); },
    nak: (ms?: number) => { verdicts.push(`nak:${ms ?? "none"}`); },
  });
  return verdicts;
}

const rows = () => harness.sql("SELECT event_id, session_id, event, data FROM claw_session_events ORDER BY id");

test("the same app event published twice, under two stream sequences, is stored once", async () => {
  assert.deepEqual(await deliver(appEvent("t1", "7"), 100), ["ack"]);
  assert.deepEqual(await deliver(appEvent("t1", "7"), 205), ["ack"], "the repeat is acked, not retried");
  const stored = await rows();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.event_id, "claw-100", "the first delivery is the one kept");
});

test("a redelivery of the very same message is also one row", async () => {
  await deliver(appEvent("t1", "7"), 100);
  await deliver(appEvent("t1", "7"), 100);
  assert.equal((await rows()).length, 1);
});

test("what is not the same stays separate: another id, another app run, another session", async () => {
  await deliver(appEvent("t1", "7"), 100);
  await deliver(appEvent("t1", "8"), 101);
  await deliver(appEvent("t2", "7"), 102);
  await deliver(appEvent("t1", "7"), 103, "s2");
  assert.equal((await rows()).length, 4);
});

test("ordinary events are not touched by the de-duplication", async () => {
  await deliver({ type: "toolUsed", tool: "bash" }, 1);
  await deliver({ type: "toolUsed", tool: "bash" }, 2);
  await deliver({ type: "appStatus", app_task_id: "t1", state: "running", restarts: 0, last_exit: null }, 3);
  await deliver({ type: "appStatus", app_task_id: "t1", state: "running", restarts: 0, last_exit: null }, 4);
  assert.equal((await rows()).length, 4, "appStatus carries no id: every one is kept");
});

test("an appEvent without an identity is stored like any other event", async () => {
  await deliver({ type: "appEvent", app_task_id: "t1", event: { note: "no id" } }, 1);
  await deliver({ type: "appEvent", app_task_id: "t1", event: { note: "no id" } }, 2);
  assert.equal((await rows()).length, 2);
});

test("appEventIdentity reads the envelope and nothing in data", () => {
  assert.deepEqual(appEventIdentity(appEvent("t1", "7", { id: "decoy" })), { appTaskId: "t1", eventId: "7" });
  for (const bad of [
    { type: "toolUsed" },
    { type: "appEvent", event: { id: "7" } },
    { type: "appEvent", app_task_id: "t1" },
    { type: "appEvent", app_task_id: "t1", event: { id: 7 } },
    { type: "appEvent", app_task_id: "", event: { id: "7" } },
  ]) assert.equal(appEventKey(bad as Record<string, unknown>), null);
});

test("a replayed stream shows an app event once even when two rows carry it", () => {
  const row = (id: string, task: string, eid: string) => ({ event_id: id, data: appEvent(task, eid) });
  const seg = historySegment(
    [row("claw-1", "t1", "7"), row("claw-9", "t1", "7"), row("claw-10", "t1", "8"), row("claw-11", "t2", "7")],
    { foldSubagents: false },
  );
  assert.deepEqual(seg.seenIds, ["claw-1", "claw-10", "claw-11"]);
});

// ---------------------------------------------------------------------------
// the cursor on the row
// ---------------------------------------------------------------------------

test("parseAppRunPatch takes a cursor of the three fields and refuses the rest", () => {
  const base = { brain_id: "b1", claim_count: 1 };
  const ok = [
    {},
    { segment: "0000000001.jsonl", offset: 0, last_id: "0" },
    { segment: "0000000042.jsonl", offset: 4194304, last_id: "18446744073709551615" },
    { offset: 10 },
  ];
  for (const cursor of ok) {
    const parsed = parseAppRunPatch({ ...base, events_cursor: cursor });
    assert.equal(parsed.ok, true, JSON.stringify(cursor));
    if (parsed.ok) assert.deepEqual(parsed.patch.events_cursor, cursor);
  }
  const bad = [
    null, [], "x", { segment: "events.jsonl" }, { segment: "../0000000001.jsonl" }, { segment: "0000000001.jsonl/x" },
    { offset: -1 }, { offset: 1.5 }, { offset: "3" }, { last_id: 7 }, { last_id: "12a" }, { last_id: "" },
    { last_id: "1".repeat(21) }, { extra: 1 },
  ];
  for (const cursor of bad) {
    assert.deepEqual(parseAppRunPatch({ ...base, events_cursor: cursor }), { ok: false, error: "events_cursor_invalid" }, JSON.stringify(cursor));
  }
});

test("the lease holder's cursor write is stored and read back; another worker's is refused", async () => {
  await harness.sql(`CREATE TABLE IF NOT EXISTS claw_app_runs (
    task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, restarts INT NOT NULL DEFAULT 0,
    last_exit JSONB, events_cursor JSONB NOT NULL DEFAULT '{}'::jsonb, state_dir TEXT, sandbox_workload_id TEXT,
    manifest JSONB NOT NULL, grant_id TEXT, grant_limits JSONB, grant_expires_at TIMESTAMPTZ, grant_revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await harness.sql("DELETE FROM claw_app_runs");
  await harness.sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, lease_owner, lease_expires_at, claim_count)
     VALUES ('t1', 's1', 'app', 'running', 'brain-1', NOW() + INTERVAL '1 minute', 3)`,
  );
  await harness.sql(`INSERT INTO claw_app_runs (task_id, session_id, state, manifest) VALUES ('t1', 's1', 'running', '{}')`);

  assert.deepEqual((await readAppRun("t1"))!.events_cursor, {}, "a new run has an empty cursor");

  const cursor = { segment: "0000000002.jsonl", offset: 512, last_id: "41" };
  const held = await patchAppRun("t1", { brainId: "brain-1", claimCount: 3 }, { events_cursor: cursor });
  assert.equal(held.ok, true);
  assert.deepEqual((await readAppRun("t1"))!.events_cursor, cursor);

  const stale = await patchAppRun("t1", { brainId: "brain-1", claimCount: 2 }, { events_cursor: { offset: 1 } });
  assert.deepEqual(stale, { ok: false, reason: "not_holder", current: "running" });
  const other = await patchAppRun("t1", { brainId: "brain-2", claimCount: 3 }, { events_cursor: { offset: 1 } });
  assert.equal(other.ok, false);
  assert.deepEqual((await readAppRun("t1"))!.events_cursor, cursor, "a refused write changes nothing");
});

test("an appEvent the identity check rejects but the index still keys is absorbed, not nak'd for ever", async () => {
  // A numeric id and an empty app_task_id: appEventIdentity says null, the index has keys for both.
  const numeric = { type: "appEvent", app_task_id: "t1", event: { id: 42 } };
  const emptyTask = { type: "appEvent", app_task_id: "", event: { id: "42" } };
  for (const e of [numeric, emptyTask]) {
    assert.deepEqual(await deliver(e, 1), ["ack"]);
    assert.deepEqual(await deliver(e, 2), ["ack"], "the second copy is acked, not retried");
  }
  assert.equal((await rows()).length, 2, "one row each");
});

test("a live app event is a repeat when the database holds it under another stream sequence", async () => {
  await deliver(appEvent("t1", "42"), 90);
  const evt = appEvent("t1", "42");
  assert.equal(await isRepeatOfStoredAppEvent("s1", evt, "claw-130"), true, "published again after a takeover");
  assert.equal(await isRepeatOfStoredAppEvent("s1", evt, "claw-90"), false, "the kept copy itself is shown");
  assert.equal(await isRepeatOfStoredAppEvent("s1", appEvent("t1", "43"), "claw-131"), false);
  assert.equal(await isRepeatOfStoredAppEvent("s2", evt, "claw-130"), false, "another session's history is not this one's");
  assert.equal(await isRepeatOfStoredAppEvent("s1", { type: "toolUsed" }, "claw-1"), false);
});

test("the shared cursor shapes are the protocol's", () => {
  assert.equal(APP_EVENT_SEGMENT_NAME.test("0000000001.jsonl"), true);
  assert.equal(APP_EVENT_SEGMENT_NAME.test("1.jsonl"), false);
  assert.equal(APP_EVENT_ID.test("18446744073709551615"), true);
  assert.equal(APP_EVENT_ID.test("1".repeat(21)), false);
});
