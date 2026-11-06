// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The watchdog (`assistant/watchdog.ts`): an item that is in progress in name only is put in front of its owner, with
 * the reason, within the threshold. Real Postgres with the production schema. Skipped without DATABASE_URL, and a skip
 * is not a pass.
 *
 *   WD1  a running worker with no sign of life past the threshold: needs you, why, and the assistant is woken; one inside the threshold is left alone
 *   WD2  the reason says which way it is stuck: a run with no heartbeat, an instruction no run took up, or no progress
 *   WD3  surfaced once: the next sweep adds nothing; a worker that reports again is back in progress and its clock starts over
 *   WD4  the run's own end is still recorded after the watchdog spoke
 *   WD5  asked again under the item's lock: an item that came back to life between the select and the write is not touched
 *   WD6  nothing for review items, for items the other sweeps own, or with the threshold at 0
 *   WD7  never silent: an item it surfaced that nobody announced is announced by the silent sweep
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const THRESHOLD = 600;

describe("assistant watchdog", { skip }, () => {
  let w: World;
  let wd: typeof import("../src/assistant/watchdog.js");
  let sweep: typeof import("../src/assistant/sweep.js");
  let alice: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_WATCHDOG_SEC: String(THRESHOLD) });
    wd = await import("../src/assistant/watchdog.js");
    sweep = await import("../src/assistant/sweep.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox CASCADE");
    w.drains.length = 0;
    alice = await w.user("alice");
  });

  /** Move the item's every sign of life `seconds` into the past. */
  async function quietFor(itemId: string, seconds: number): Promise<void> {
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - make_interval(secs => $2::int) WHERE item_id = $1", [itemId, seconds]);
    await w.q("UPDATE claw_work_item_events SET created_at = NOW() - make_interval(secs => $2::int) WHERE item_id = $1", [itemId, seconds]);
  }
  /** A worker that started and is still running, quiet for `seconds`. */
  async function runningItem(title: string, seconds: number) {
    const item = await w.createItem(alice, title);
    const turn = await w.workerTurn(item.itemId);
    await w.q("UPDATE claw_tasks SET lease_expires_at = NOW() + interval '45 seconds' WHERE task_id = $1", [turn.task_id]);
    await quietFor(item.itemId, seconds);
    return { ...item, turn };
  }
  const routerWakes = async () => (await w.pending(alice.routerSid)).filter((p) => String(p.content).startsWith("[work_event]"));

  test("WD1 a worker with no sign of life past the threshold needs the user, says why, and wakes the assistant", async () => {
    const stuck = await runningItem("Fix the build", THRESHOLD + 1);
    const fresh = await runningItem("Write the notes", THRESHOLD - 60);
    await sweep.sweepAssistant();

    const item = await w.item(stuck.itemId);
    assert.equal(item.board_state, "needs_you");
    assert.equal(item.last_report_kind, "blocked");
    assert.match(item.summary, /No progress for more than 10 minutes/);
    assert.match(item.pending_question, /Keep waiting/);
    assert.equal(item.attention_seq, 1);
    const events = await w.itemEvents(stuck.itemId);
    const last = events.at(-1)!;
    assert.deepEqual({ kind: last.kind, source: last.source, run_id: last.run_id }, { kind: "blocked", source: "watchdog", run_id: null });
    const wakes = await routerWakes();
    assert.equal(wakes.length, 1, "the assistant was not woken");
    assert.match(String(wakes[0].content), new RegExp(`#${stuck.seq} .*blocked`));

    const untouched = await w.item(fresh.itemId);
    assert.equal(untouched.board_state, "in_progress", "an item inside the threshold was surfaced");
    assert.equal(untouched.attention_seq, 0);
  });

  test("WD2 the reason says which way it is stuck", async () => {
    const lost = await runningItem("Lost worker", THRESHOLD + 1);
    await w.q("UPDATE claw_tasks SET lease_expires_at = NOW() - interval '5 minutes' WHERE task_id = $1", [lost.turn.task_id]);

    const waiting = await w.createItem(alice, "Never started");
    await w.mod.messages.queueServerMessage({ query: (t: string, p?: unknown[]) => w.h.app.db.db.query(t, p) } as never, {
      sessionId: waiting.workerSid, userId: "alice", content: "do it", dedupeKey: `start-again:${waiting.itemId}`,
    });
    await w.q("UPDATE claw_pending_messages SET created_at = NOW() - make_interval(secs => $2::int) WHERE session_id = $1", [waiting.workerSid, THRESHOLD + 1]);
    await quietFor(waiting.itemId, THRESHOLD + 1);

    // A message that has waited less than the threshold is the drain's, not stuck.
    const queuedNow = await w.createItem(alice, "Just queued");
    await w.mod.messages.queueServerMessage({ query: (t: string, p?: unknown[]) => w.h.app.db.db.query(t, p) } as never, {
      sessionId: queuedNow.workerSid, userId: "alice", content: "do it", dedupeKey: `start-again:${queuedNow.itemId}`,
    });
    await quietFor(queuedNow.itemId, THRESHOLD + 1);

    assert.equal(await wd.surfaceStuckItems(THRESHOLD), 2);
    assert.match((await w.item(lost.itemId)).summary, /stopped answering: its run has had no heartbeat/);
    assert.match((await w.item(waiting.itemId)).summary, /has not reached a worker/);
    assert.equal((await w.item(queuedNow.itemId)).board_state, "in_progress");
  });

  test("WD3 surfaced once; a worker that reports again is back in progress and its clock starts over", async () => {
    const stuck = await runningItem("Fix the build", THRESHOLD + 1);
    assert.equal(await wd.surfaceStuckItems(THRESHOLD), 1);
    const events = (await w.itemEvents(stuck.itemId)).length;
    await quietFor(stuck.itemId, THRESHOLD * 3);
    assert.equal(await wd.surfaceStuckItems(THRESHOLD), 0, "an item waiting for the user was picked again");
    assert.equal((await w.itemEvents(stuck.itemId)).length, events);

    const reported = await w.mod.tools.report(stuck.turn, { kind: "progress", summary: "still compiling" });
    assert.equal(reported.item_state, "in_progress");
    assert.equal(await wd.surfaceStuckItems(THRESHOLD), 0, "fresh progress was taken for none");
    assert.equal((await w.item(stuck.itemId)).board_state, "in_progress");
  });

  test("WD4 the run's own end is still recorded after the watchdog spoke", async () => {
    const stuck = await runningItem("Fix the build", THRESHOLD + 1);
    assert.equal(await wd.surfaceStuckItems(THRESHOLD), 1);
    await w.closeRun(stuck.turn.task_id, "completed", undefined, 0);
    await w.mod.turnEnd.recordWorkerTurnEnd({
      sessionId: stuck.workerSid, runIds: [stuck.turn.task_id], failed: false, interrupted: false, finalText: "Fixed: the lockfile was stale.",
    });
    const item = await w.item(stuck.itemId);
    assert.equal(item.last_report_kind, "ready", "the watchdog's record hid the run's end");
    assert.equal(item.result_version, 1);
    assert.match(item.summary, /lockfile/);
  });

  test("WD5 an item that came back to life between the select and the write is not touched", async () => {
    const stuck = await runningItem("Fix the build", THRESHOLD + 1);
    const real = w.mod.reports.ingestReport;
    const ports = wd.watchdogPorts;
    const original = ports.ingestReport;
    // The worker reports after the sweep chose the item, before the sweep writes.
    ports.ingestReport = (async (...args: Parameters<typeof real>) => {
      await w.q(
        "INSERT INTO claw_work_item_events (item_id, kind, source, generation, run_id, summary) SELECT item_id, 'progress', 'worker', generation, $2, 'alive' FROM claw_work_items WHERE item_id = $1",
        [stuck.itemId, stuck.turn.task_id],
      );
      return original(...args);
    }) as typeof original;
    try {
      assert.equal(await wd.surfaceStuckItems(THRESHOLD), 0);
    } finally { ports.ingestReport = original; }
    assert.equal((await w.item(stuck.itemId)).board_state, "in_progress");
    assert.equal((await w.itemEvents(stuck.itemId)).filter((e) => e.source === "watchdog").length, 0);
  });

  test("WD6 nothing for review items, for items the other sweeps own, or with the threshold at 0", async () => {
    const review = await runningItem("A review", THRESHOLD + 1);
    await w.q("UPDATE claw_work_items SET kind = 'review' WHERE item_id = $1", [review.itemId]);
    // Nothing open behind it: the orphan sweep's.
    const orphan = await w.createItem(alice, "Nothing running");
    await quietFor(orphan.itemId, THRESHOLD + 1);
    // Its run ended: `reconcileWorkerRuns`'s.
    const ended = await runningItem("Ended", THRESHOLD + 1);
    await w.closeRun(ended.turn.task_id, "completed", undefined, 0);

    assert.equal(await wd.surfaceStuckItems(THRESHOLD), 0);
    const stuck = await runningItem("Stuck", THRESHOLD + 1);
    assert.equal(await wd.surfaceStuckItems(0), 0, "the watchdog ran with its threshold at 0");
    assert.equal((await w.item(stuck.itemId)).board_state, "in_progress");
    for (const id of [review.itemId, orphan.itemId, ended.itemId]) {
      assert.equal((await w.itemEvents(id)).filter((e) => e.source === "watchdog").length, 0, id);
    }
  });

  test("WD7 an item the watchdog surfaced that nobody announced is announced by the silent sweep", async () => {
    const stuck = await runningItem("Fix the build", THRESHOLD + 1);
    assert.equal(await wd.surfaceStuckItems(THRESHOLD), 1);
    const told: string[] = [];
    const real = w.mod.silent.silentSweepPorts.recordNeedsYouFallback;
    w.mod.silent.silentSweepPorts.recordNeedsYouFallback = async ({ itemId }: { itemId: string }) => { told.push(itemId); return null; };
    try {
      await w.q("UPDATE claw_work_items SET updated_at = NOW() - interval '1 hour' WHERE item_id = $1", [stuck.itemId]);
      await w.mod.silent.tellSilentItems(300);
    } finally { w.mod.silent.silentSweepPorts.recordNeedsYouFallback = real; }
    assert.deepEqual(told, [stuck.itemId]);
  });
});
