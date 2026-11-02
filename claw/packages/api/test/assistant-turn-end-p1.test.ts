// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A worker turn that ends without telling the assistant, and an item that needs the user with nobody having
 * said so. Real Postgres, production schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   E1  a turn that ends with no report is recorded as ready, with the worker's last words
 *   E2  a run that failed is recorded as failed, never as ready
 *   E3  the same completion delivered twice is one record and one wake
 *   E4  a turn that already told the assistant something it must act on is not recorded again
 *   E5  an interrupted turn, a turn with another queued behind it and a run of no item are left alone
 *   E6  the completion handler does it: an exec_complete for a worker session ends in the record
 *   S1  the sweep records a run whose completion was lost, once, and not one that is still young or still running
 *   S2  an item that needs the user with no delivered message is announced once, after the threshold and not before
 *   S3  L1-6: a say whose delivery fails does not count; the sweep sends one fallback and only one
 *   S4  a delivered message about the current need is enough; a new need is a new announcement
 *   S5  the orphan drain finds a wake nobody drained
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant turn ends and sweeps", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let item: { itemId: string; seq: number; workerSid: string };

  before(async () => { w = await startWorld(); });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_notification_subscriptions CASCADE");
    w.drains.length = 0;
    alice = await w.user("alice");
    item = await w.createItem(alice, "Fix the build");
  });

  /** A worker run that ended, as the completion handler sees it. */
  async function endedRun(opts: { status?: "completed" | "failed" | "cancelled"; reason?: string; agoSeconds?: number } = {}) {
    const turn = await w.workerTurn(item.itemId);
    await w.closeRun(turn.task_id, opts.status ?? "completed", opts.reason, opts.agoSeconds ?? 5);
    return turn;
  }
  const end = (turn: { task_id: string }, extra: Record<string, unknown> = {}) =>
    w.mod.turnEnd.recordWorkerTurnEnd({ sessionId: item.workerSid, runIds: [turn.task_id], failed: false, interrupted: false, ...extra } as never);
  const turnEnds = async () => (await w.itemEvents(item.itemId)).filter((e) => e.source === "turn_end");
  const routerWakes = async () => (await w.pending(alice.routerSid)).length;

  test("E1 a turn that ends with no report is recorded as ready, with the worker's last words", async () => {
    const turn = await endedRun();
    await end(turn, { finalText: "Opened PR 12; unit tests pass." });
    const row = await w.item(item.itemId);
    assert.equal(row.board_state, "needs_you");
    assert.equal(row.last_report_kind, "ready");
    assert.equal(row.result_version, 1);
    assert.equal(row.summary, "Opened PR 12; unit tests pass.");
    const [record] = await turnEnds();
    assert.equal(record.kind, "ready");
    assert.equal(record.run_id, turn.task_id);
    assert.equal(record.generation, turn.gen);
    assert.equal(await routerWakes(), 1);
    assert.match((await w.pending(alice.routerSid))[0].content, /^\[work_event\] #1 ready v1: Opened PR 12/);
  });

  test("E1b with nothing to say the record says so, and points at the worker's session", async () => {
    await end(await endedRun(), { finalText: "   " });
    assert.match((await turnEnds())[0].summary, /finished without a report or a final message/);
  });

  test("E2 a run that failed is recorded as failed, with why", async () => {
    const turn = await endedRun({ status: "failed" });
    await end(turn, { failed: true, failureReason: "sandbox_lost", finalText: "I think it is fine" });
    const row = await w.item(item.itemId);
    assert.equal(row.last_report_kind, "failed");
    assert.equal(row.result_version, 0, "a failed run leaves nothing to accept");
    assert.match((await turnEnds())[0].summary, /sandbox_lost/);
    assert.doesNotMatch((await turnEnds())[0].summary, /I think it is fine/);
  });

  test("E3 the same completion delivered twice is one record and one wake", async () => {
    const turn = await endedRun();
    await end(turn, { finalText: "done" });
    await end(turn, { finalText: "done" });
    await end(turn, { finalText: "done" });
    assert.equal((await turnEnds()).length, 1);
    assert.equal(await routerWakes(), 1);
    assert.equal((await w.item(item.itemId)).attention_seq, 1);
  });

  test("E3b two deliveries at the same instant are one record", async () => {
    const turn = await endedRun();
    await Promise.all([1, 2, 3].map(() => end(turn, { finalText: "done" })));
    assert.equal((await turnEnds()).length, 1);
    assert.equal(await routerWakes(), 1);
  });

  test("E4 a turn that already told the assistant something it must act on adds nothing", async () => {
    for (const args of [
      { kind: "ready", summary: "done" }, { kind: "blocked", summary: "stuck" }, { kind: "failed", summary: "no" },
      { kind: "dropped", summary: "n/a" }, { kind: "waiting", summary: "w", question: "q?" },
    ]) {
      await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_pending_messages, claw_tasks CASCADE");
      item = await w.createItem(alice, "Fix the build");
      const turn = await w.workerTurn(item.itemId);
      await w.mod.tools.report(turn, args);
      await w.closeRun(turn.task_id, "completed", undefined, 5);
      const wakes = await routerWakes();
      await end(turn, { finalText: "all done" });
      assert.equal((await turnEnds()).length, 0, JSON.stringify(args));
      assert.equal(await routerWakes(), wakes);
    }
  });

  test("E4b a worker that only made progress reports is recorded as ready when it stops", async () => {
    const turn = await w.workerTurn(item.itemId);
    await w.mod.tools.report(turn, { kind: "progress", summary: "halfway" });
    await w.mod.tools.report(turn, { kind: "waiting", summary: "waiting on CI" });
    await w.closeRun(turn.task_id, "completed", undefined, 5);
    await end(turn, { finalText: "tests are green" });
    assert.equal((await turnEnds()).length, 1);
    assert.equal((await w.item(item.itemId)).last_report_kind, "ready");
  });

  test("E5 an interrupted turn, a turn with another behind it and a run of no item are left alone", async () => {
    const interrupted = await endedRun({ status: "cancelled" });
    await end(interrupted, { interrupted: true });
    assert.equal((await turnEnds()).length, 0);

    const first = await endedRun();
    await w.q("INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, 'alice', 'one more thing')", [item.workerSid]);
    await end(first, { finalText: "done" });
    assert.equal((await turnEnds()).length, 0, "a queued instruction means the item is not at rest");
    assert.equal((await w.item(item.itemId)).board_state, "in_progress");
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [item.workerSid]);

    const second = await w.workerTurn(item.itemId);
    await end(first, { finalText: "done" });
    assert.equal((await turnEnds()).length, 0, "nor is one whose session is running another turn");
    await w.closeRun(second.task_id, "completed", undefined, 5);

    await w.mod.turnEnd.recordWorkerTurnEnd({ sessionId: alice.routerSid, runIds: ["ktsk_router_run"], failed: false, interrupted: false });
    await w.mod.turnEnd.recordWorkerTurnEnd({ sessionId: item.workerSid, runIds: ["ktsk_unknown"], failed: false, interrupted: false });
    assert.equal((await turnEnds()).length, 0, "a run that never carried an assistant role is nobody's to report");
  });

  test("E5b a run the item has moved on from is fenced out of recording its end", async () => {
    const old = await endedRun();
    const router = await w.routerTurn(alice);
    await w.mod.tools.workStop(router, { item_id: item.itemId, reason: "no longer needed" });
    await end(old, { finalText: "done" });
    assert.equal((await turnEnds()).length, 0);
    assert.equal((await w.item(item.itemId)).outcome, "stopped");
  });

  test("E6 the completion handler records the end of a worker's turn", async () => {
    const turn = await w.workerTurn(item.itemId);
    const { consumeEventDelivery, completionPorts, tombstoneReader } = w.mod.consumer;
    const { sc } = await import("../src/infra/nats.js");
    const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
    // Without a KV the tombstone read is "unknown" and the delivery naks before it reaches the handler.
    const originalTombstone = { ...tombstoneReader };
    Object.assign(tombstoneReader, { has: async () => false });
    resetDeletedSessionCache();
    const original = completionPorts.recordWorkerTurnEnd;
    const seen: Array<{ sessionId: string; runIds: string[]; finalText?: string }> = [];
    completionPorts.recordWorkerTurnEnd = async (e) => { seen.push(e); return original(e); };
    const acked: string[] = [];
    try {
      await consumeEventDelivery({
        subject: `events.${item.workerSid}`,
        data: sc.encode(JSON.stringify({
          type: "exec_complete", session_id: item.workerSid, user_id: "alice", message_id: turn.mid,
          task_id: turn.task_id, prompt: "work", final_text: "Merged the fix.", failed: false, error_count: 0, skills_used: {},
        })),
        seq: 1,
        ack: () => { acked.push("ack"); }, nak: (ms?: number) => { acked.push(`nak ${ms}`); },
      });
    } finally {
      completionPorts.recordWorkerTurnEnd = original;
      Object.assign(tombstoneReader, originalTombstone);
      resetDeletedSessionCache();
    }
    assert.equal(seen.length, 1, `the handler asked for the record (${acked.join(", ")})`);
    assert.equal(seen[0].sessionId, item.workerSid);
    assert.deepEqual(seen[0].runIds, [turn.task_id]);
    assert.equal(seen[0].finalText, "Merged the fix.");
    assert.equal((await w.item(item.itemId)).board_state, "needs_you");
    assert.equal((await turnEnds()).length, 1);
  });

  async function ageRun(taskId: string, seconds: number) {
    await w.q("UPDATE claw_tasks SET completed_at = NOW() - make_interval(secs => $2::int) WHERE task_id = $1", [taskId, seconds]);
  }

  test("S1 the sweep records a run whose completion was lost, once", async () => {
    const lost = await endedRun({ agoSeconds: 600 });
    assert.equal(await w.mod.turnEnd.reconcileWorkerRuns(), 1);
    const [record] = await turnEnds();
    assert.equal(record.source, "turn_end");
    assert.equal(record.run_id, lost.task_id);
    assert.equal(record.kind, "ready");
    assert.equal(await routerWakes(), 1);
    assert.equal(await w.mod.turnEnd.reconcileWorkerRuns(), 0, "nothing left to record");
    assert.equal(await routerWakes(), 1);
  });

  test("S1b failed and cancelled runs are recorded as failed, and the handler's own record is not doubled", async () => {
    const failed = await endedRun({ status: "failed", reason: "worker_lost", agoSeconds: 600 });
    await w.mod.turnEnd.reconcileWorkerRuns();
    assert.match((await turnEnds())[0].summary, /worker_lost/);
    assert.equal((await w.item(item.itemId)).last_report_kind, "failed");

    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_pending_messages, claw_tasks CASCADE");
    item = await w.createItem(alice, "Fix the build");
    const cancelled = await endedRun({ status: "cancelled", agoSeconds: 600 });
    await w.mod.turnEnd.reconcileWorkerRuns();
    assert.match((await turnEnds())[0].summary, /interrupted/);
    assert.notEqual(failed.task_id, cancelled.task_id);

    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_pending_messages, claw_tasks CASCADE");
    item = await w.createItem(alice, "Fix the build");
    const handled = await endedRun({ agoSeconds: 600 });
    await end(handled, { finalText: "done" });
    assert.equal(await w.mod.turnEnd.reconcileWorkerRuns(), 0);
    assert.equal((await turnEnds()).length, 1);
  });

  test("S1c a young run, a running one and a closed item are not the sweep's", async () => {
    const young = await endedRun({ agoSeconds: 5 });
    assert.equal(await w.mod.turnEnd.reconcileWorkerRuns(), 0, "the completion handler has a minute");
    await ageRun(young.task_id, 600);
    await w.workerTurn(item.itemId);
    assert.equal(await w.mod.turnEnd.reconcileWorkerRuns(), 0, "a newer run is running: the old end is not the item's state");
    const router = await w.routerTurn(alice);
    await w.mod.tools.workStop(router, { item_id: item.itemId, reason: "no" });
    assert.equal(await w.mod.turnEnd.reconcileWorkerRuns(), 0);
    assert.equal((await turnEnds()).length, 0);
  });

  /** An item that needs the user, its need `agoSeconds` old. */
  async function needsYou(agoSeconds: number, args: Record<string, unknown> = { kind: "ready", summary: "PR 12 opened" }) {
    const turn = await w.workerTurn(item.itemId);
    await w.mod.tools.report(turn, args);
    await w.closeRun(turn.task_id, "completed", undefined, 5);
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - make_interval(secs => $2::int) WHERE item_id = $1", [item.itemId, agoSeconds]);
    return turn;
  }
  const says = async () => w.q("SELECT * FROM claw_assistant_says ORDER BY created_at");
  const outboxRows = async () => w.q("SELECT event_id, payload FROM claw_notification_outbox ORDER BY id");

  test("S2 an item that needs the user with no message about it is announced once, after the threshold", async () => {
    await w.subscribe("alice");
    await needsYou(10 * 60);
    assert.equal(await w.mod.silent.tellSilentItems(300), 1);
    const [fallback] = await says();
    assert.equal(fallback.fallback, true);
    assert.equal(fallback.item_id, item.itemId);
    assert.equal(fallback.item_attention_seq, 1);
    assert.match(fallback.text, /#1 "Fix the build" is ready for your review \(v1\)/);
    const [row] = await outboxRows();
    assert.equal(row.payload.type, "work_item.needs_you");
    assert.equal(row.payload.fallback, true);
    assert.equal(row.payload.item.can_accept, true);
    assert.equal(await w.mod.silent.tellSilentItems(300), 0, "once per need");
    assert.equal((await says()).length, 1);
    assert.equal((await outboxRows()).length, 1);
  });

  test("S2b not before the threshold, not for an item that does not need the user", async () => {
    await needsYou(60);
    assert.equal(await w.mod.silent.tellSilentItems(300), 0);
    assert.equal(await w.mod.silent.tellSilentItems(30), 1, "the threshold is the setting, not a constant");
    await w.q("TRUNCATE claw_assistant_says");
    await w.q("UPDATE claw_work_items SET board_state = 'in_progress' WHERE item_id = $1", [item.itemId]);
    assert.equal(await w.mod.silent.tellSilentItems(30), 0);
  });

  test("S3 a say whose delivery fails does not count; the sweep sends one fallback and only one", async () => {
    await w.subscribe("alice");
    w.mod.outbound.registerAssistantDeliveryHook();
    await needsYou(10 * 60);
    const out = await w.mod.tools.say(await w.routerTurn(alice), { text: "PR 12 is ready, please review.", item_id: item.itemId }, w.sayDeps);
    assert.equal(out.subscribers, 1);
    const sent: number[] = [];
    const failing = { transport: async () => { sent.push(500); return 500; }, resolve: async () => [{ address: "93.184.216.34", family: 4 }], allowedHosts: new Set<string>() };
    await w.mod.outbox.deliverDue(failing);
    assert.deepEqual(sent, [500]);
    const [spoken] = await says();
    assert.equal(spoken.delivered_at, null, "a message nobody received is not a message sent");
    assert.equal(spoken.item_attention_seq, 1);

    assert.equal(await w.mod.silent.tellSilentItems(300), 1);
    assert.equal(await w.mod.silent.tellSilentItems(300), 0);
    assert.equal((await says()).filter((s) => s.fallback).length, 1);
    assert.equal((await outboxRows()).filter((r) => r.payload.type === "work_item.needs_you").length, 1);
  });

  test("S4 a delivered message about the current need is enough; a new need is a new announcement", async () => {
    await w.subscribe("alice");
    w.mod.outbound.registerAssistantDeliveryHook();
    await needsYou(10 * 60);
    await w.mod.tools.say(await w.routerTurn(alice), { text: "PR 12 is ready.", item_id: item.itemId }, w.sayDeps);
    const ok = { transport: async () => 200, resolve: async () => [{ address: "93.184.216.34", family: 4 }], allowedHosts: new Set<string>() };
    await w.mod.outbox.deliverDue(ok);
    assert.notEqual((await says())[0].delivered_at, null);
    assert.equal(await w.mod.silent.tellSilentItems(300), 0, "the user was told");

    // The item goes back to work, then needs the user again: a different need.
    await w.mod.workItems.reopenWorkItem({ query: (t: string, p?: unknown[]) => w.h.app.db.db.query(t, p) }, { userId: "alice", itemId: item.itemId, text: "also fix the lint" });
    await needsYou(10 * 60, { kind: "blocked", summary: "lint needs a decision", question: "disable rule X?" });
    assert.equal((await w.item(item.itemId)).attention_seq, 2);
    assert.equal(await w.mod.silent.tellSilentItems(300), 1);
    const fallback = (await says()).filter((s) => s.fallback);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].item_attention_seq, 2);
    assert.match(fallback[0].text, /disable rule X\?/);
  });

  test("S5 the orphan drain finds a wake nobody drained", async () => {
    const turn = await w.workerTurn(item.itemId);
    await w.mod.tools.report(turn, { kind: "ready", summary: "done" });
    // The process died between the commit and the drain: the row is queued, the router idle, nothing coming.
    w.drains.length = 0;
    assert.equal((await w.pending(alice.routerSid)).length, 1);
    await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [alice.routerSid]);
    await w.q("UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE session_id = $1", [alice.routerSid]);
    const real = w.mod.sweeper.sweeperPorts.drainPendingMessage;
    const asked: Array<[string, string]> = [];
    w.mod.sweeper.sweeperPorts.drainPendingMessage = async (sid: string, uid: string) => { asked.push([sid, uid]); };
    try {
      assert.ok(await w.mod.sweeper.drainOrphanedPendingMessages() >= 1);
    } finally { w.mod.sweeper.sweeperPorts.drainPendingMessage = real; }
    assert.deepEqual(asked.filter(([sid]) => sid === alice.routerSid), [[alice.routerSid, "alice"]]);
  });
});
