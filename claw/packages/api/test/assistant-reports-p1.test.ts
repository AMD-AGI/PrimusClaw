// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A worker's reports reaching the item and waking the assistant, against a real Postgres with the production
 * schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   F1  a run's generation is fixed once: the same run read twice, or delivered twice, is one generation
 *   F2  a report from a run that is no longer the item's current one changes nothing, wakes nobody, and is counted
 *   F3  a report of the current run applies; a report after the item is closed does not
 *   F4  a report whose turn has ended, or whose gate went to another turn, is refused
 *   D1  a worker's word-for-word repeat of its last report is a replay: no second version, no second wake
  W1  every kind of report moves the item as the state table says and wakes the router exactly when it must
 *   W2  the state change, its event and the wake are one transaction: a commit that fails leaves none of them
 *   W3  the wake is one queued message per report, carries the owner's credentials, and is drained after the commit;
      a router in the middle of a turn is left to drain its own queue
 *   W4  a router that cannot be woken does not lose the report
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { failNextCommit } from "./support/admission-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant worker reports", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let item: { itemId: string; seq: number; workerSid: string };

  before(async () => { w = await startWorld(); });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox CASCADE");
    w.drains.length = 0;
    alice = await w.user("alice");
    item = await w.createItem(alice, "Fix the build");
  });

  const report = (turn: Awaited<ReturnType<World["workerTurn"]>>, args: unknown) => w.mod.tools.report(turn, args);
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (err) { assert.ok(err instanceof w.mod.tools.ToolRefused, String(err)); return (err as { code: string }).code; }
    assert.fail("accepted");
  };

  test("F1 a run's generation is fixed once", async () => {
    const run = await w.openRun(item.workerSid);
    const first = await w.mod.runStarted.startWorkerRun(item.workerSid, run.taskId);
    const again = await w.mod.runStarted.startWorkerRun(item.workerSid, run.taskId);
    assert.equal(first?.generation, 1);
    assert.equal(again?.generation, 1, "a claim delivered twice must read the number the first one fixed");
    assert.equal((await w.item(item.itemId)).generation, 1);
    assert.equal((await w.itemEvents(item.itemId)).filter((e) => e.kind === "run_started").length, 1);

    const next = await w.openRun(item.workerSid);
    assert.equal((await w.mod.runStarted.startWorkerRun(item.workerSid, next.taskId))?.generation, 2);
    assert.equal((await w.mod.runStarted.startWorkerRun(item.workerSid, run.taskId))?.generation, 1, "the earlier run still reads its own");
    assert.equal(await w.mod.runStarted.startWorkerRun("not-a-worker-session", "ktsk_x"), null);
  });

  test("F1b two claims of one run at the same instant are one generation", async () => {
    const run = await w.openRun(item.workerSid);
    const both = await Promise.all([
      w.mod.runStarted.startWorkerRun(item.workerSid, run.taskId),
      w.mod.runStarted.startWorkerRun(item.workerSid, run.taskId),
      w.mod.runStarted.startWorkerRun(item.workerSid, run.taskId),
    ]);
    assert.deepEqual(both.map((s) => s?.generation), [1, 1, 1]);
    assert.equal((await w.item(item.itemId)).generation, 1);
  });

  test("F2 a stale run's report changes nothing, wakes nobody and is counted", async () => {
    const old = await w.workerTurn(item.itemId);
    await w.closeRun(old.task_id);
    const current = await w.workerTurn(item.itemId);
    assert.equal(old.gen, 1);
    assert.equal(current.gen, 2);
    const before = await w.item(item.itemId);
    const eventsBefore = (await w.itemEvents(item.itemId)).length;
    const counter = () => w.h.app.metrics.registry.getSingleMetricAsString("claw_work_item_stale_rejected_total");

    // The old run is no longer live, so its own turn check refuses it first; the fence is what stands behind that.
    // Make it live again without changing its generation, which is the case the fence exists for.
    await w.q("UPDATE claw_tasks SET status = 'running' WHERE task_id = $1", [old.task_id]);
    await w.q("UPDATE claw_sessions SET agent_gate_message_id = $2 WHERE session_id = $1", [item.workerSid, old.mid]);
    assert.equal(await refusal(report(old, { kind: "ready", summary: "late" })), "stale_run");

    const after = await w.item(item.itemId);
    assert.equal(after.board_state, "in_progress");
    assert.equal(after.summary, before.summary);
    assert.equal(after.last_report_kind, before.last_report_kind);
    assert.equal(after.result_version, 0);
    assert.equal(after.attention_seq, 0);
    assert.equal((await w.itemEvents(item.itemId)).length, eventsBefore);
    assert.equal((await w.pending(alice.routerSid)).length, 0);
    assert.match(await counter(), /claw_work_item_stale_rejected_total\{[^}]*source="worker"[^}]*\} 1/);
  });

  test("F3 the current run's report applies, and a closed item takes none", async () => {
    const turn = await w.workerTurn(item.itemId);
    assert.deepEqual(await report(turn, { kind: "ready", summary: "PR 12 opened" }), { ok: true, status: "recorded", item_state: "needs_you" });
    const row = await w.item(item.itemId);
    assert.equal(row.board_state, "needs_you");
    assert.equal(row.result_version, 1);
    assert.equal(row.attention_seq, 1);
    const ready = (await w.itemEvents(item.itemId)).find((e) => e.kind === "ready");
    assert.ok(ready, "the report is logged");
    assert.equal(ready.generation, 1);
    assert.equal(ready.run_id, turn.task_id);
    assert.equal(ready.result.run_id, turn.task_id, "a result is pinned to the run that made it");

    const stopper = await w.routerTurn(alice);
    await w.mod.tools.workStop(stopper, { item_id: item.itemId, reason: "not needed" });
    assert.equal(await refusal(report(turn, { kind: "progress", summary: "still going" })), "turn_not_live", "the stop cancelled the run");
    await w.q("UPDATE claw_tasks SET status = 'running' WHERE task_id = $1", [turn.task_id]);
    assert.equal(await refusal(report(turn, { kind: "progress", summary: "still going" })), "stale_run", "and if the run lived on, the item is closed to it");
    assert.equal((await w.item(item.itemId)).outcome, "stopped");
  });

  test("F3b a stopped item fences out the run that was working on it", async () => {
    const turn = await w.workerTurn(item.itemId);
    const router = await w.routerTurn(alice);
    await w.mod.tools.workStop(router, { item_id: item.itemId, reason: "changed my mind" });
    const row = await w.item(item.itemId);
    assert.equal(row.generation, turn.gen! + 1, "a stop moves the generation so the run it stopped is stale");
    // The interrupt did not reach the run (it is still live as far as its row goes): the fence is what refuses it.
    await w.q("UPDATE claw_tasks SET status = 'running' WHERE task_id = $1", [turn.task_id]);
    assert.equal(await refusal(report(turn, { kind: "ready", summary: "done anyway" })), "stale_run");
    assert.equal((await w.item(item.itemId)).board_state, "done");
  });

  test("F4 a turn that has ended, or lost its gate, cannot report", async () => {
    const ended = await w.workerTurn(item.itemId);
    await w.closeRun(ended.task_id);
    assert.equal(await refusal(report(ended, { kind: "progress", summary: "x" })), "turn_not_live");

    const live = await w.workerTurn(item.itemId);
    await w.q("UPDATE claw_sessions SET agent_gate_message_id = 'claw-someone-else' WHERE session_id = $1", [item.workerSid]);
    assert.equal(await refusal(report(live, { kind: "progress", summary: "x" })), "turn_superseded");
    await w.q("UPDATE claw_sessions SET agent_gate_message_id = NULL WHERE session_id = $1", [item.workerSid]);
    assert.equal((await report(live, { kind: "progress", summary: "x" })).status, "recorded", "an unnamed gate is a session from before gates had owners");

    assert.equal(await refusal(report({ ...live, role: "router" } as never, { kind: "progress", summary: "x" })), "not_allowed");
    assert.equal(await refusal(report(live, { kind: "ready" })), "invalid_report");
  });

  test("D1 a worker that repeats its last report word for word is not counted twice", async () => {
    const turn = await w.workerTurn(item.itemId);
    const ready = { kind: "ready", summary: "PR 12 opened", result: { refs: [{ type: "pr", url: "https://example.com/pr/12" }] } };
    assert.deepEqual(await report(turn, ready), { ok: true, status: "recorded", item_state: "needs_you" });
    assert.deepEqual(await report(turn, ready), { ok: true, status: "already_recorded", item_state: "unchanged" });
    assert.deepEqual(await report(turn, { ...ready, result: { refs: [{ url: "https://example.com/pr/12", type: "pr" }] } }), { ok: true, status: "already_recorded", item_state: "unchanged" }, "key order is not a difference");
    const row = await w.item(item.itemId);
    assert.deepEqual({ version: row.result_version, attention: row.attention_seq }, { version: 1, attention: 1 }, "the card the user has is still the current one");
    assert.equal((await w.itemEvents(item.itemId)).filter((e) => e.kind === "ready").length, 1);
    assert.equal((await w.pending(alice.routerSid)).length, 1, "and the router was woken once");

    // Anything else is heard: a different report, or the same one after something in between.
    assert.equal((await report(turn, { ...ready, summary: "PR 12 opened and rebased" })).status, "recorded");
    assert.equal((await report(turn, { kind: "progress", summary: "touching up" })).status, "recorded");
    assert.equal((await report(turn, { kind: "progress", summary: "touching up" })).status, "already_recorded");
    assert.equal((await report(turn, { ...ready, summary: "PR 12 opened and rebased" })).status, "recorded");
    assert.equal((await w.item(item.itemId)).result_version, 3);
  });

  test("D1b replays arriving together are one report", async () => {
    const turn = await w.workerTurn(item.itemId);
    const out = await Promise.all([1, 2, 3, 4].map(() => report(turn, { kind: "blocked", summary: "no access", question: "which org?" })));
    assert.deepEqual(out.map((o) => o.status).sort(), ["already_recorded", "already_recorded", "already_recorded", "recorded"]);
    assert.equal((await w.item(item.itemId)).attention_seq, 1);
    assert.equal((await w.pending(alice.routerSid)).length, 1);
  });

  type Row = [string, Record<string, unknown>, { state: string; wake: boolean; attention: number; version: number; kindOnRow: string; question: string | null }];
  const table: Row[] = [
    ["progress", { kind: "progress", summary: "halfway" }, { state: "in_progress", wake: false, attention: 0, version: 0, kindOnRow: "progress", question: null }],
    ["waiting, no question", { kind: "waiting", summary: "CI running" }, { state: "in_progress", wake: false, attention: 0, version: 0, kindOnRow: "waiting", question: null }],
    ["waiting with a question", { kind: "waiting", summary: "need a call", question: "merge or squash?" }, { state: "needs_you", wake: true, attention: 1, version: 0, kindOnRow: "waiting", question: "merge or squash?" }],
    ["blocked", { kind: "blocked", summary: "no access", question: "which org?" }, { state: "needs_you", wake: true, attention: 1, version: 0, kindOnRow: "blocked", question: "which org?" }],
    ["blocked, no question", { kind: "blocked", summary: "no access" }, { state: "needs_you", wake: true, attention: 1, version: 0, kindOnRow: "blocked", question: null }],
    ["ready", { kind: "ready", summary: "done, tests pass" }, { state: "needs_you", wake: true, attention: 1, version: 1, kindOnRow: "ready", question: null }],
    ["failed", { kind: "failed", summary: "build broke" }, { state: "needs_you", wake: true, attention: 1, version: 0, kindOnRow: "failed", question: null }],
    ["dropped", { kind: "dropped", summary: "not needed" }, { state: "done", wake: true, attention: 0, version: 0, kindOnRow: "dropped", question: null }],
  ];
  for (const [name, args, want] of table) {
    test(`W1 ${name}: the item is ${want.state}, the router ${want.wake ? "is" : "is not"} woken`, async () => {
      const turn = await w.workerTurn(item.itemId);
      await report(turn, args);
      const row = await w.item(item.itemId);
      assert.equal(row.board_state, want.state);
      assert.equal(row.attention_seq, want.attention);
      assert.equal(row.result_version, want.version);
      assert.equal(row.last_report_kind, want.kindOnRow);
      assert.equal(row.pending_question, want.question);
      assert.equal(row.outcome, want.state === "done" ? "dropped" : null);
      const queued = await w.pending(alice.routerSid);
      assert.equal(queued.length, want.wake ? 1 : 0);
      assert.equal(w.drains.filter((d) => d.sessionId === alice.routerSid).length, want.wake ? 1 : 0);
      const event = (await w.itemEvents(item.itemId)).find((e) => e.kind === args.kind);
      assert.ok(event, "the report is logged whether or not it wakes anyone");
      assert.equal(event.source, "worker");
      if (want.wake) {
        assert.match(queued[0].content, new RegExp(`^\\[work_event\\] #${item.seq} \\(item_id: ${item.itemId}\\) ${args.kind}`));
        assert.equal(queued[0].dedupe_key, `wi-evt:${event.id}`);
      }
    });
  }

  test("W2 the state change, its event and the wake are one transaction", async () => {
    const turn = await w.workerTurn(item.itemId);
    const before = await w.item(item.itemId);
    const restore = failNextCommit(w.h.app.db.db.pool);
    try {
      await assert.rejects(report(turn, { kind: "ready", summary: "done" }), /forced commit failure/);
    } finally { restore(); }
    const after = await w.item(item.itemId);
    assert.equal(after.board_state, before.board_state);
    assert.equal(after.result_version, 0);
    assert.equal((await w.itemEvents(item.itemId)).filter((e) => e.kind === "ready").length, 0);
    assert.equal((await w.pending(alice.routerSid)).length, 0, "no wake for a report that did not commit");
    assert.equal(w.drains.length, 0);
    assert.equal((await report(turn, { kind: "ready", summary: "done" })).status, "recorded", "and the worker can simply report again");
  });

  test("W3 a wake carries the owner's credentials and one report is one message", async () => {
    const turn = await w.workerTurn(item.itemId);
    await report(turn, { kind: "ready", summary: "done" });
    const [message] = await w.pending(alice.routerSid);
    assert.equal(message.user_id, "alice");
    assert.equal(message.platform_key, "pk-alice");
    assert.equal(message.llm_api_key, "vk-alice");
    assert.ok(message.credentials_blob, "sealed for the doorbell path the drain may take");
    // A queued row with the same key is not queued twice: the retry of a transaction, or a redelivery.
    const again = await w.mod.messages.queueServerMessage({ query: (t: string, p?: unknown[]) => w.h.app.db.db.query(t, p) }, {
      sessionId: alice.routerSid, userId: "alice", content: "[work_event] again", dedupeKey: message.dedupe_key,
    });
    assert.deepEqual(again, { ok: true, pendingId: null, deduplicated: true });
    assert.equal((await w.pending(alice.routerSid)).length, 1);
  });

  test("W3b a router that is busy is not drained: its own turn drains the queue when it ends", async () => {
    await w.openRun(alice.routerSid);
    const turn = await w.workerTurn(item.itemId);
    await report(turn, { kind: "ready", summary: "done" });
    assert.equal((await w.pending(alice.routerSid)).length, 1, "the wake is queued behind the turn in front of it");
    assert.equal(w.drains.filter((d) => d.sessionId === alice.routerSid).length, 0);
  });

  test("W4 a router that cannot be woken does not lose the report", async () => {
    await w.q("UPDATE claw_sessions SET config = '{}'::jsonb WHERE session_id = $1", [alice.routerSid]);
    const turn = await w.workerTurn(item.itemId);
    assert.equal((await report(turn, { kind: "ready", summary: "done" })).status, "recorded");
    assert.equal((await w.item(item.itemId)).board_state, "needs_you");
    assert.equal((await w.pending(alice.routerSid)).length, 0);
    assert.equal(w.drains.length, 0);
  });
});
