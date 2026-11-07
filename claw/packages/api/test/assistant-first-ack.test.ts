// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * "On it", said by the server when a router turn answering the person has said nothing `CLAW_ASSISTANT_FIRST_ACK_MS` after it began
 * (`src/assistant/lookup-ack.ts`, `ackFirstReply`), against a real Postgres with the production schema. Skipped without DATABASE_URL,
 * and a skip is not a pass.
 *
 *   F1  a turn opened by `openChatRun` that thinks for 4 s hears the line at 3.5 s, once; its answer takes the line's place, so the
 *       channel shows one message
 *   F2  a turn that spoke within 3 s hears nothing from the server
 *   F3  not for a person the setting does not name, a turn a report started, one that may hand a review off, one that ended, a worker's
 *       session, or with the setting off; the lookup line and this one are one line per turn, whichever comes first
 *   F4  a turn whose run waited in the queue: the line said while it waited is still the one its answer replaces
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant first ack by the clock", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let ack: typeof import("../src/assistant/lookup-ack.js");
  let chatRun: typeof import("../src/tasks/chat-run.js");
  let seq = 0;

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_FIRST_ACK_USERS: "alice, carol", CLAW_ASSISTANT_FIRST_ACK_MS: "3500" });
    ack = await import("../src/assistant/lookup-ack.js");
    chatRun = await import("../src/tasks/chat-run.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_notification_subscriptions, claw_assistant_messages, claw_session_events CASCADE");
    w.events.length = 0;
    ack.resetLookupAckCacheForTest();
    alice = await w.user("alice");
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const says = async () => w.q("SELECT text, fallback, say_id::text AS say_id, created_at FROM claw_assistant_says ORDER BY created_at");
  const message = (sessionId: string, mid: string, content: string, userId = "alice", context: Record<string, unknown> = {}) => w.q(
    "INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, channel_context) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [sessionId, mid, userId, content, JSON.stringify(context)],
  );

  /** A router turn the way the dispatcher opens one: `openChatRun`, and the person's message as the inbound route stores it. */
  async function opened(content: string) {
    seq += 1;
    const mid = `claw-first-${seq}`;
    const run = await chatRun.openChatRun({
      dispatch: "fat", sessionId: alice.routerSid, userId: "alice", messageId: mid, prompt: content, recordWorkspaceUse: false,
    });
    assert.ok(run, "the run row is open");
    await message(alice.routerSid, mid, content);
    const row = (await w.q("SELECT created_at, started_at FROM claw_tasks WHERE task_id = $1", [run.taskId]))[0];
    return { mid, taskId: run.taskId, created: new Date(row.created_at), began: row.started_at as Date };
  }
  /** A live router turn opened directly (no timer), for the checks that call `ackFirstReply` themselves. */
  async function turn(content: string, context: Record<string, unknown> = {}, status = "running") {
    const t = await w.openRun(alice.routerSid, { status });
    await w.q("UPDATE claw_tasks SET prompt = $2, started_at = CASE WHEN $3 = 'queued' THEN NULL ELSE NOW() END WHERE task_id = $1", [t.taskId, content, status]);
    await message(alice.routerSid, t.messageId, content, "alice", context);
    return { mid: t.messageId, taskId: t.taskId };
  }
  const first = (sessionId: string, mid: string, extra: Record<string, unknown> = {}) =>
    ack.ackFirstReply(sessionId, mid, { ...w.sayDeps, enabled: true, users: "alice", ...extra });

  test("F1 a turn that thinks for 4 s hears the line at 3.5 s, and its answer takes the line's place", async () => {
    await w.subscribe("alice");
    const t = await opened("帮我把上周的进展整理成三句话");
    await sleep(3_000);
    assert.equal((await says()).length, 0, "nothing before the deadline");
    await sleep(1_000);
    const rows = await says();
    assert.equal(rows.length, 1, "one line at the deadline");
    assert.equal(rows[0].text, "收到，我看一下。");
    assert.equal(rows[0].fallback, true, "the system's words: not taken for the turn having answered");
    assert.equal(rows[0].say_id, ack.lookupAckSayId("alice", t.mid));
    const at = new Date(rows[0].created_at).getTime() - t.created.getTime();
    assert.ok(at >= 3_500 && at < 4_000, `said at ${at} ms after the turn began`);
    // The answer, at 4 s: it takes the line's place in the channel.
    await w.mod.outbound.recordAssistantSay({
      userId: "alice", sessionId: alice.routerSid, text: "上周：合入 3 个 PR，发布 v0.9，修了登录超时。", turnMessageId: t.mid, turnBegan: t.began,
    }, w.sayDeps);
    const out = await w.q("SELECT event_id, payload FROM claw_notification_outbox ORDER BY created_at, event_id");
    const answer = out.find((o) => o.payload.text?.startsWith("上周"));
    assert.equal(answer?.payload.replaces, ack.lookupAckSayId("alice", t.mid), "the answer edits the line: one message in the channel");
    assert.equal(out.filter((o) => !o.payload.replaces).length, 1, "only the line is a new message; the answer replaces it");
    assert.equal(await first(alice.routerSid, t.mid), "spoke", "said once per turn");
  });

  test("F2 a turn that spoke within 3 s hears nothing from the server", async () => {
    await w.subscribe("alice");
    const t = await opened("SaFE 上有几个 workspace");
    await sleep(1_000);
    await w.mod.outbound.recordAssistantSay({
      userId: "alice", sessionId: alice.routerSid, text: "有 2 个 workspace。", turnMessageId: t.mid, turnBegan: t.began,
    }, w.sayDeps);
    await sleep(3_000);
    assert.deepEqual((await says()).map((s) => [s.text, s.fallback]), [["有 2 个 workspace。", false]], "only the router's own line");
  });

  test("F3 not for whom it is not, nor a turn that must stay quiet; one line per turn with the lookup's", async () => {
    // English, and the lookup line after it is the same line: nothing more.
    const en = await turn("summarize what I did last week");
    assert.equal(await first(alice.routerSid, en.mid), "said");
    assert.deepEqual((await says()).map((s) => s.text), ["On it: looking into it now."]);
    assert.equal(await ack.ackBeforeLookup(alice.routerSid, { type: "toolUsed", status: "start", tool: "web_search", message_id: en.mid }, {
      ...w.sayDeps, graceMs: 0, enabled: true,
    }), "spoke");
    // And the other way round: the lookup's line came first.
    await w.q("TRUNCATE claw_assistant_says");
    const lk = await turn("帮我查一下 MI355X 的新闻");
    assert.equal(await ack.ackBeforeLookup(alice.routerSid, { type: "toolUsed", status: "start", tool: "web_search", message_id: lk.mid }, {
      ...w.sayDeps, graceMs: 0, enabled: true,
    }), "said");
    assert.equal(await first(alice.routerSid, lk.mid), "spoke");
    assert.equal((await says()).length, 1);
    await w.q("TRUNCATE claw_assistant_says");
    // Someone the setting does not name.
    const a = await turn("你好");
    assert.equal(await first(alice.routerSid, a.mid, { users: "bob" }), "not_named");
    assert.equal(await first(alice.routerSid, a.mid, { users: "" }), "not_named");
    assert.equal(await first(alice.routerSid, a.mid, { users: "*" }), "said", "* names everyone");
    await w.q("TRUNCATE claw_assistant_says");
    // A report started the turn; it may end silent on purpose.
    const r = await turn("[work_event] #1 (item_id: kwi_x) ready v1: Opened PR 12");
    assert.equal(await first(alice.routerSid, r.mid), "report_turn");
    // A turn that may hand a review to the person's channel.
    const h = await turn("让 weilei 审一下 #291", { handoffs: ["review_for_other"], people: [{ name: "weilei", user_id: "weilei" }] });
    assert.equal(await first(alice.routerSid, h.mid), "may_hand_off");
    // The turn ended before the deadline.
    const e = await turn("几点了");
    await w.closeRun(e.taskId, "completed", undefined, 0);
    assert.equal(await first(alice.routerSid, e.mid), "turn_ended");
    // A session that is not a router's, and the setting off.
    assert.equal(await first("not-a-router-session", a.mid), "not_a_router");
    assert.equal(await first(alice.routerSid, a.mid, { enabled: false }), "off");
    assert.equal((await says()).length, 0, "nothing said by any of these");
    // Pure parts.
    assert.equal(ack.firstAckFor("alice", " alice , carol"), true);
    assert.equal(ack.firstAckFor("bob", "alice,carol"), false);
    assert.equal(ack.firstAckFor("bob", ""), false);
    assert.equal(ack.firstAckText("帮我看看"), "收到，我看一下。");
  });

  test("F4 a turn whose run waited in the queue: the answer still replaces the line said while it waited", async () => {
    await w.subscribe("alice");
    const t = await turn("把这份报告发到我的 Teams", {}, "queued");
    assert.equal(await first(alice.routerSid, t.mid), "said");
    await sleep(50);
    // A worker claims the run now: the turn begins after the line.
    await w.q("UPDATE claw_tasks SET status = 'running', started_at = NOW() WHERE task_id = $1", [t.taskId]);
    const began = (await w.q("SELECT started_at FROM claw_tasks WHERE task_id = $1", [t.taskId]))[0].started_at;
    await w.mod.outbound.recordAssistantSay({
      userId: "alice", sessionId: alice.routerSid, text: "已发到你的 Teams。", turnMessageId: t.mid, turnBegan: began,
    }, w.sayDeps);
    const answer = (await w.q("SELECT payload FROM claw_notification_outbox WHERE payload->>'text' = '已发到你的 Teams。'"))[0];
    assert.equal(answer.payload.replaces, ack.lookupAckSayId("alice", t.mid), "one message: the answer edits the line");
  });
});
