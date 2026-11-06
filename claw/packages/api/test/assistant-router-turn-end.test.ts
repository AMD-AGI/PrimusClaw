// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A router turn that ends with words and no message (`src/assistant/router-turn-end.ts`), against a real Postgres
 * with the production schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   T1  a turn that answers the user in plain text and says nothing: the text is delivered through say, once, naming the turn
 *   T2  a turn that said something is left alone, whatever else it wrote; a message of the system's own does not count as having spoken
 *   T3  a turn that a worker's report started may end silent on purpose: what it wrote is not delivered
 *   T4  a turn that failed, was interrupted or was written by the sweeper delivers none of its words, only the system's notice, once;
 *       a turn that wrote nothing delivers nothing
 *   T5  a text too long for say is cut to fit; a refusal (the hourly cap) is not a fault and stores none of the model's
 *       words, and the user has the cap's notice instead of nothing
 *   T6  only an assistant's router session is looked at
 *   T7  the completion handler asks for it when a router turn ends, and the user's say is there afterwards
 *   T8  a fault delivering it (the database failing over) is tried again by the completion handler, not given up
 *   T9  a turn whose every say came before its last lookup answered ("查一下 Autopilot 的状态。", then the lookup, then the answer in
 *       plain text: the parity run's K2; a lookup that failed as well) has its text delivered as the answer, once; a say after the lookup, a refused say, or no
 *       lookup at all leaves the turn alone as in T2
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant router turn end", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let item: { itemId: string; seq: number; workerSid: string };

  before(async () => { w = await startWorld(); });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_notification_subscriptions CASCADE");
    w.drains.length = 0;
    w.events.length = 0;
    alice = await w.user("alice");
    item = await w.createItem(alice, "Fix the build");
  });

  /** A router turn of alice that has ended, started by `prompt`. */
  async function endedTurn(prompt: string) {
    const turn = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() WHERE task_id = $1", [turn.task_id, prompt]);
    await w.closeRun(turn.task_id, "completed", undefined, 1);
    return turn;
  }
  const end = (turn: { task_id: string }, extra: Record<string, unknown> = {}, sessionId = alice.routerSid) =>
    w.mod.routerTurnEnd.deliverUnsaidAnswer({ sessionId, runIds: [turn.task_id], failed: false, interrupted: false, ...extra } as never, w.sayDeps);
  const says = async () => w.q("SELECT * FROM claw_assistant_says ORDER BY created_at");
  const REPORT = "[work_event] #1 (item_id: kwi_x) ready v1: Opened PR 12";

  test("T1 a turn that answers in plain text and says nothing: the text is delivered through say, once", async () => {
    await w.subscribe("alice");
    const turn = await endedTurn("How is the build going?");
    assert.equal(await end(turn, { finalText: "  The build is still running; no failures so far.  " }), "said");
    const [said] = await says();
    assert.deepEqual([said.user_id, said.text, said.fallback, said.item_id], ["alice", "The build is still running; no failures so far.", false, null]);
    assert.equal(w.events.length, 1, "the web client sees it in the assistant's session");
    assert.equal(w.events[0].type, "AssistantSay");
    assert.equal(w.events[0].session_id, alice.routerSid);
    assert.equal(w.events[0].turn_message_id, undefined, "a completion that names no turn names none");
    assert.equal((await w.q("SELECT 1 FROM claw_notification_outbox")).length, 1, "and a subscriber is told");
    // A completion delivered again finds the message and adds nothing.
    assert.equal(await end(turn, { finalText: "The build is still running; no failures so far." }), "skipped");
    assert.equal((await says()).length, 1);
    // The ended turn's message id goes on the session's event: it is what says which message this answers.
    const next = await endedTurn("And the tests?");
    assert.equal(await end(next, { finalText: "All green.", messageId: next.mid }), "said");
    assert.equal(w.events.at(-1)?.turn_message_id, next.mid);
  });

  test("T2 a turn that said something is left alone, and a message of the system's own is not the turn's", async () => {
    const turn = await endedTurn("How is the build going?");
    // The model's own message, made while the turn ran.
    await w.q("INSERT INTO claw_assistant_says (say_id, user_id, text, fallback) VALUES (gen_random_uuid(), 'alice', 'Still running.', false)");
    assert.equal(await end(turn, { finalText: "Done." }), "skipped");
    assert.deepEqual((await says()).map((s) => s.text), ["Still running."], "the closing words after a say are not a second message");

    await w.q("TRUNCATE claw_assistant_says");
    const other = await endedTurn("And now?");
    await w.q("INSERT INTO claw_assistant_says (say_id, user_id, text, fallback) VALUES (gen_random_uuid(), 'alice', 'Item #1 needs you.', true)");
    assert.equal(await end(other, { finalText: "Still running." }), "said", "the system's own message is not the model speaking");
    assert.deepEqual((await says()).map((s) => s.text).sort(), ["Item #1 needs you.", "Still running."]);

    // A say from before this turn began does not count as this turn's.
    await w.q("TRUNCATE claw_assistant_says");
    await w.q("INSERT INTO claw_assistant_says (say_id, user_id, text, fallback, created_at) VALUES (gen_random_uuid(), 'alice', 'Earlier.', false, NOW() - interval '1 hour')");
    assert.equal(await end(await endedTurn("Again?"), { finalText: "Still running." }), "said");
  });

  test("T3 a turn that a worker's report started may end silent on purpose", async () => {
    const turn = await endedTurn(REPORT);
    assert.equal(await end(turn, { finalText: "Nothing the user needs to decide; I will stay quiet." }), "skipped");
    assert.equal((await says()).length, 0);
  });

  test("T4 a turn that failed, was interrupted or was written by the sweeper delivers none of its words, only the system's notice; one that wrote nothing delivers nothing", async () => {
    const turn = await endedTurn("How is the build going?");
    for (const extra of [{ finalText: "" }, { finalText: "   \n " }, {}]) assert.equal(await end(turn, extra), "skipped", JSON.stringify(extra));
    assert.equal((await says()).length, 0);
    for (const extra of [
      { failed: true, finalText: "partial" }, { interrupted: true, finalText: "partial" }, { fromSweeper: true, finalText: "[Task timed out]" },
    ]) {
      await w.q("TRUNCATE claw_assistant_says");
      const lost = await endedTurn("How is the build going?");
      assert.equal(await end(lost, extra), "said", JSON.stringify(extra));
      assert.equal(await end(lost, extra), "skipped", `once: ${JSON.stringify(extra)}`);
      const [notice, ...more] = await says();
      assert.equal(more.length, 0);
      assert.equal(notice.fallback, true, "the system's words, not the model's");
      assert.match(notice.text, /did not go through/);
    }
  });

  test("T5 a text too long for say is cut to fit, and a refusal is not a fault and leaves the user the cap's notice", async () => {
    const long = "x".repeat(9500);
    assert.equal(await end(await endedTurn("Tell me everything"), { finalText: long }), "said");
    const [said] = await says();
    assert.equal(said.text.length, 9000);
    assert.ok(said.text.endsWith("x…"));
    // What say counts is UTF-16 units, so a text of two-unit characters is cut sooner, and never in the middle of one.
    await w.q("TRUNCATE claw_assistant_says");
    assert.equal(await end(await endedTurn("Tell me more"), { finalText: "😀".repeat(4600) }), "said");
    const emoji = (await says())[0].text as string;
    assert.ok(emoji.length <= 9000 && emoji.length >= 8998, String(emoji.length));
    assert.ok(emoji.endsWith("😀…"));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji), "no half of a character");

    await w.q("TRUNCATE claw_assistant_says");
    const capped = await w.mod.routerTurnEnd.deliverUnsaidAnswer(
      { sessionId: alice.routerSid, runIds: [(await endedTurn("Hello")).task_id], failed: false, interrupted: false, finalText: "Hi" },
      { ...w.sayDeps, maxPerHour: 0 },
    );
    assert.equal(capped, "skipped");
    assert.deepEqual((await says()).map((s) => [s.text, s.fallback]), [[w.mod.outbound.sayCapNotice("Hi"), true]], "the system's words, not the model's");
  });

  test("T6 only an assistant's router session is looked at", async () => {
    const worker = await w.workerTurn(item.itemId);
    await w.q("UPDATE claw_tasks SET prompt = 'work' WHERE task_id = $1", [worker.task_id]);
    await w.closeRun(worker.task_id, "completed", undefined, 1);
    assert.equal(await end(worker, { finalText: "Opened PR 12." }, item.workerSid), "skipped");
    await w.q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('plain', 'a chat', 'alice', 'claw')");
    assert.equal(await end({ task_id: "ktsk_none" }, { finalText: "hi" }, "plain"), "skipped");
    assert.equal(await end({ task_id: "ktsk_none" }, { finalText: "hi" }), "skipped", "a run that is not the router's own");
    assert.equal((await says()).length, 0);
  });

  test("T7 the completion handler asks for it when a router turn ends", async () => {
    const turn = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = 'What is the weather like on the build farm?' WHERE task_id = $1", [turn.task_id]);
    const { completionPorts, consumeEventDelivery, tombstoneReader } = w.mod.consumer;
    const realDeliver = completionPorts.deliverUnsaidAnswer;
    const ended: Array<{ messageId?: string }> = [];
    completionPorts.deliverUnsaidAnswer = (async (end: { messageId?: string }, deps?: unknown) => {
      ended.push(end);
      return realDeliver(end as never, deps as never);
    }) as typeof completionPorts.deliverUnsaidAnswer;
    const { sc } = await import("../src/infra/nats.js");
    const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
    const originalTombstone = { ...tombstoneReader };
    Object.assign(tombstoneReader, { has: async () => false });
    resetDeletedSessionCache();
    const acked: string[] = [];
    try {
      await consumeEventDelivery({
        subject: `events.${alice.routerSid}`,
        data: sc.encode(JSON.stringify({
          type: "exec_complete", session_id: alice.routerSid, user_id: "alice", message_id: turn.mid,
          task_id: turn.task_id, prompt: "What is the weather like on the build farm?", final_text: "Sunny, and the build is green.", failed: false, error_count: 0, skills_used: {},
        })),
        seq: 1,
        ack: () => { acked.push("ack"); }, nak: (ms?: number) => { acked.push(`nak ${ms}`); },
      });
    } finally {
      Object.assign(tombstoneReader, originalTombstone);
      completionPorts.deliverUnsaidAnswer = realDeliver;
      resetDeletedSessionCache();
    }
    assert.deepEqual((await says()).map((s) => s.text), ["Sunny, and the build is green."], `delivered by the handler (${acked.join(", ")})`);
    assert.deepEqual(ended.map((e) => e.messageId), [turn.mid], "the say is the ended turn's: its message id goes with it");
  });

  test("T8 a fault delivering the unsaid answer is tried again by the completion handler", async () => {
    const turn = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = 'Is the build green?' WHERE task_id = $1", [turn.task_id]);
    const { completionPorts, consumeEventDelivery, tombstoneReader, setUnsaidAnswerRetryDelayForTest } = w.mod.consumer;
    const realDeliver = completionPorts.deliverUnsaidAnswer;
    let calls = 0;
    // The first attempt meets the database mid-failover, as the Router's own say did.
    completionPorts.deliverUnsaidAnswer = (async (end: never, deps?: never) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" });
      return realDeliver(end, deps);
    }) as typeof completionPorts.deliverUnsaidAnswer;
    const { sc } = await import("../src/infra/nats.js");
    const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
    const originalTombstone = { ...tombstoneReader };
    Object.assign(tombstoneReader, { has: async () => false });
    resetDeletedSessionCache();
    setUnsaidAnswerRetryDelayForTest(5);
    try {
      await consumeEventDelivery({
        subject: `events.${alice.routerSid}`,
        data: sc.encode(JSON.stringify({
          type: "exec_complete", session_id: alice.routerSid, user_id: "alice", message_id: turn.mid,
          task_id: turn.task_id, prompt: "Is the build green?", final_text: "Yes, all green.", failed: false, error_count: 0, skills_used: {},
        })),
        seq: 2,
        ack: () => {}, nak: () => {},
      });
    } finally {
      Object.assign(tombstoneReader, originalTombstone);
      completionPorts.deliverUnsaidAnswer = realDeliver;
      setUnsaidAnswerRetryDelayForTest(2_000);
      resetDeletedSessionCache();
    }
    assert.equal(calls, 2, "tried again after the fault");
    assert.deepEqual((await says()).map((s) => s.text), ["Yes, all green."]);
  });
  test("T9 a turn that said only a line before its lookup answered gets its plain-text answer delivered, once", async () => {
    const SAY_TOOL = "mcp__assistant__say";
    let seq = 0;
    /** The turn's toolUsed events, in the order Brain emitted them, as the event consumer stores them. */
    const emitted = async (mid: string, events: Array<{ tool: string; status: string; is_error?: boolean; description?: string }>) => {
      for (const e of events) {
        seq += 1;
        await w.q(
          "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, 'toolUsed', $3)",
          [`claw-t9-${seq}`, alice.routerSid, JSON.stringify({ type: "toolUsed", message_id: mid, ...e })],
        );
      }
    };
    const LINE = "查一下 Autopilot 的状态。";
    const ANSWER = "三个节点都 unhealthy，是因为节点池不可用：crsuse2-m2m-v3-173 在退避中，18:30 UTC 恢复。";
    const said = async (text: string) =>
      w.q("INSERT INTO claw_assistant_says (say_id, user_id, text, fallback) VALUES (gen_random_uuid(), 'alice', $1, false)", [text]);

    // K2: the line, then the lookup, then the answer written as plain text.
    const k2 = await endedTurn("为什么我在autopilot页面看这3个节点都是unhealthy");
    await said(LINE);
    await emitted(k2.mid, [
      { tool: SAY_TOOL, status: "start" }, { tool: SAY_TOOL, status: "success", description: '{"ok":true,"say_id":"s1"}' },
      { tool: "mcp__autopilot__get_status", status: "start" }, { tool: "mcp__autopilot__get_status", status: "success", description: "{}" },
    ]);
    assert.equal(await end(k2, { finalText: ANSWER, messageId: k2.mid }), "said", "the person had only the line");
    assert.deepEqual((await says()).map((s) => s.text), [LINE, ANSWER]);
    // A completion delivered again finds the answer it stored.
    assert.equal(await end(k2, { finalText: ANSWER, messageId: k2.mid }), "skipped");
    assert.equal((await says()).length, 2);

    // The answer said after the lookup: the turn answered, and its closing words are not a second message.
    await w.q("TRUNCATE claw_assistant_says");
    const answered = await endedTurn("autopilot 有几台节点");
    await said("3 台。");
    await emitted(answered.mid, [
      { tool: "mcp__autopilot__get_status", status: "success", description: "{}" },
      { tool: SAY_TOOL, status: "success", description: '{"ok":true}' },
    ]);
    assert.equal(await end(answered, { finalText: "Done.", messageId: answered.mid }), "skipped");

    // A say refused after the lookup is not one the person got, so the line before it is all they hold.
    await w.q("TRUNCATE claw_assistant_says");
    const refused = await endedTurn("autopilot 有几台节点");
    await said("查一下。");
    await emitted(refused.mid, [
      { tool: SAY_TOOL, status: "success", description: '{"ok":true}' },
      { tool: "web_search", status: "success", description: "results" },
      { tool: SAY_TOOL, status: "success", description: '{"ok":false,"error":"refused"}' },
    ]);
    assert.equal(await end(refused, { finalText: "节点池里有 3 台。", messageId: refused.mid }), "said");

    // A lookup that failed ended as well: the turn's text after it (that it could not find out) is its answer.
    await w.q("TRUNCATE claw_assistant_says");
    const failedLookup = await endedTurn("autopilot 有几台节点");
    await said("查一下。");
    await emitted(failedLookup.mid, [
      { tool: SAY_TOOL, status: "success", description: '{"ok":true}' },
      { tool: "mcp__autopilot__get_status", status: "success", is_error: true, description: "node pool unavailable" },
    ]);
    assert.equal(await end(failedLookup, { finalText: "我现在查不到 Autopilot 的状态，稍后再试。", messageId: failedLookup.mid }), "said");

    // No lookup in the turn (or one of another turn): a say is its answer, as in T2.
    await w.q("TRUNCATE claw_assistant_says");
    const plain = await endedTurn("你好");
    await said("你好！");
    await emitted(plain.mid, [{ tool: SAY_TOOL, status: "success", description: '{"ok":true}' }]);
    await emitted("claw-another-turn", [{ tool: "mcp__autopilot__get_status", status: "success", description: "{}" }]);
    assert.equal(await end(plain, { finalText: "Greeted.", messageId: plain.mid }), "skipped");

    // Through a channel: the line was a real say of the turn, so the answer delivered at its end takes that line's place (`replaces`,
    // AMD-AGI/PrimusClaw#360), one message, instead of a second one beside it.
    await w.q("TRUNCATE claw_assistant_says, claw_notification_outbox");
    await w.subscribe("alice");
    const live = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() - INTERVAL '1 second' WHERE task_id = $1", [live.task_id, "为什么这3个节点都是unhealthy"]);
    const line = await w.mod.tools.say(live as never, { text: LINE }, w.sayDeps);
    await w.closeRun(live.task_id, "completed", undefined, 1);
    await emitted(live.mid, [
      { tool: SAY_TOOL, status: "success", description: JSON.stringify({ ok: true, say_id: line.say_id }) },
      { tool: "mcp__autopilot__get_status", status: "success", description: "{}" },
    ]);
    assert.equal(await end(live, { finalText: ANSWER, messageId: live.mid }), "said");
    const payloads = (await w.q("SELECT payload FROM claw_notification_outbox ORDER BY id")).map((r) => r.payload);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[1].text, ANSWER);
    assert.equal(payloads[1].replaces, line.say_id, "the answer takes the line's place");
  });
});
