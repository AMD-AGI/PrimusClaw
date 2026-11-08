// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * "On it", said by the server when a router turn starts a slow lookup with nothing said (`src/assistant/lookup-ack.ts`), and the
 * router's turn-cap and silent-turn answers (`router-turn-end.ts`, Brain's `report_at_turn_cap`), against a real Postgres with the
 * production schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   A1  a router turn answering the person that starts a web search or an MCP read with nothing said: one line, in their language, as a
 *       system message of that turn (fallback, turn_message_id), once however many lookups follow
 *   A2  not when the router said or started a say, an item's start notice was said, the turn may hand a review off, a report started the
 *       turn, the turn ended, the session is a worker's, or the tool is the assistant's own read or a say
 *   A3  the line the router writes during the grace wins: the server says nothing
 *   A4  the turn's answer takes the line's place (`replaces`), as it takes the router's own first line's, in a channel and in the
 *       session of a person with no channel subscribed
 *   A5  a turn answering the person that looked things up and ended with no word and no text is told so once, in its language; not one
 *       that said something, started an item, made no lookup, or that a report started
 *   A6  the router's turn asks Brain for a text reply at its turn cap (`report_at_turn_cap`)
 *   A7  the event consumer says it for a lookup's start event from Brain, and stores the event as before
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant lookup ack and silent turns", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let ack: typeof import("../src/assistant/lookup-ack.js");
  let seq = 0;

  before(async () => {
    w = await startWorld();
    ack = await import("../src/assistant/lookup-ack.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_notification_subscriptions, claw_assistant_messages, claw_session_events CASCADE");
    w.events.length = 0;
    ack.resetLookupAckCacheForTest();
    alice = await w.user("alice");
  });

  /** A live router turn answering `content`, with the person's message stored as the inbound route stores it. */
  async function turn(content: string, context: Record<string, unknown> = {}) {
    const t = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() WHERE task_id = $1", [t.task_id, content]);
    await w.q(
      "INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, channel_context) VALUES ($1, $2, 'alice', $3, $4::jsonb)",
      [alice.routerSid, t.mid, content, JSON.stringify(context)],
    );
    return t;
  }
  const start = (mid: string, tool: string) => ({ type: "toolUsed", status: "start", tool, message_id: mid, actionId: `a${++seq}` });
  const stored = async (sessionId: string, mid: string, tool: string, status = "start") => {
    seq += 1;
    await w.q(
      "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, 'toolUsed', $3)",
      [`claw-ack-${seq}`, sessionId, JSON.stringify({ type: "toolUsed", message_id: mid, tool, status })],
    );
  };
  const run = (sessionId: string, event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ack.ackBeforeLookup(sessionId, event, { ...w.sayDeps, graceMs: 0, enabled: true, ...extra });
  const says = async () => w.q("SELECT text, fallback, say_id::text AS say_id FROM claw_assistant_says ORDER BY created_at");

  test("A1 a slow lookup with nothing said: one line in the person's language, of that turn, once", async () => {
    const zh = await turn("帮我查一下 SaFE 上有哪些空闲节点");
    assert.equal(await run(alice.routerSid, start(zh.mid, "mcp__safe__node_list")), "said");
    assert.equal(await run(alice.routerSid, start(zh.mid, "web_search")), "spoke", "the line is said: the turn has spoken");
    const rows = await says();
    assert.equal(rows.length, 1, "once per turn");
    assert.equal(rows[0].text, "收到，我查一下。");
    assert.equal(rows[0].fallback, true, "the system's words: not counted as the turn having answered");
    assert.equal(rows[0].say_id, ack.lookupAckSayId("alice", zh.mid));
    const event = w.events.find((e) => e.type === "AssistantSay");
    assert.equal(event?.turn_message_id, zh.mid, "a reader of the session sees it as this turn's");

    await w.q("TRUNCATE claw_assistant_says");
    const en = await turn("what's new on the web about MI355X?");
    assert.equal(await run(alice.routerSid, start(en.mid, "web_search")), "said");
    assert.deepEqual((await says()).map((s) => s.text), ["On it: searching the web now."]);
  });

  test("A2 nothing when the turn spoke, may hand off, is a report's, ended, is a worker's, or the tool is fast", async () => {
    // The router said something already.
    const a = await turn("SaFE 上有几个 workspace");
    await w.q("INSERT INTO claw_assistant_says (say_id, user_id, text, fallback) VALUES (gen_random_uuid(), 'alice', '查一下。', false)");
    assert.equal(await run(alice.routerSid, start(a.mid, "mcp__safe__workspace_list")), "spoke");
    await w.q("TRUNCATE claw_assistant_says");
    // An item's start notice was said (a fallback says something too).
    const b = await turn("开个 PR 改一下 README，然后查下 CI");
    await w.q("INSERT INTO claw_assistant_says (say_id, user_id, text, fallback) VALUES (gen_random_uuid(), 'alice', '#1 改 README 开始了。', true)");
    assert.equal(await run(alice.routerSid, start(b.mid, "mcp__github__checks_list")), "spoke");
    await w.q("TRUNCATE claw_assistant_says");
    // The router started a say (its start event is stored, the say is not yet).
    const c = await turn("board 上有我的 topic 吗");
    await stored(alice.routerSid, c.mid, "mcp__assistant__say");
    assert.equal(await run(alice.routerSid, start(c.mid, "mcp__agent-board__list_issues")), "saying");
    // A turn that may hand a review over to the channel: the channel answers it in one message.
    const d = await turn("让 weilei 审一下 #291", { handoffs: ["review_for_other"], people: [{ name: "weilei", user_id: "weilei" }] });
    assert.equal(await run(alice.routerSid, start(d.mid, "mcp__github__pr_get")), "may_hand_off");
    // A report started the turn.
    const e = await turn("[work_event] #1 (item_id: kwi_x) ready v1: Opened PR 12");
    assert.equal(await run(alice.routerSid, start(e.mid, "mcp__github__pr_get")), "report_turn");
    // The turn ended.
    const f = await turn("查一下 autopilot 状态");
    await w.closeRun(f.task_id, "completed", undefined, 0);
    assert.equal(await run(alice.routerSid, start(f.mid, "mcp__autopilot__get_status")), "turn_ended");
    // The assistant's own read, a say, a non-start event, and a session that is not a router's.
    const g = await turn("我的事项都怎么样了");
    assert.equal(await run(alice.routerSid, start(g.mid, "mcp__assistant__work_recall")), "not_a_lookup");
    assert.equal(await run(alice.routerSid, start(g.mid, "mcp__assistant__say")), "not_a_lookup");
    assert.equal(await run(alice.routerSid, { ...start(g.mid, "web_search"), status: "success" }), "not_a_start");
    assert.equal(await run("not-a-router-session", start(g.mid, "web_search")), "not_a_router");
    assert.equal(await run(alice.routerSid, start(g.mid, "web_search"), { enabled: false }), "off");
    assert.equal((await says()).length, 0, "nothing said by any of these");
  });

  test("A3 a line the router writes during the grace wins", async () => {
    const t = await turn("SaFE 上有哪些 flavor");
    const out = await ack.ackBeforeLookup(alice.routerSid, start(t.mid, "mcp__safe__flavor_list"), {
      ...w.sayDeps, enabled: true, graceMs: 5,
      sleep: async () => {
        await w.q("INSERT INTO claw_assistant_says (say_id, user_id, text, fallback) VALUES (gen_random_uuid(), 'alice', '查一下 SaFE 的 flavor。', false)");
      },
    });
    assert.equal(out, "spoke");
    assert.deepEqual((await says()).map((s) => s.text), ["查一下 SaFE 的 flavor。"], "only the router's own line");
  });

  test("A4 the turn's answer takes the line's place in a channel", async () => {
    await w.subscribe("alice");
    const t = await turn("SaFE 上有几台空闲节点");
    assert.equal(await run(alice.routerSid, start(t.mid, "mcp__safe__node_list")), "said");
    const began = (await w.q("SELECT started_at FROM claw_tasks WHERE task_id = $1", [t.task_id]))[0].started_at;
    await w.mod.outbound.recordAssistantSay({
      userId: "alice", sessionId: alice.routerSid, text: "有 3 台空闲节点。", turnMessageId: t.mid, turnBegan: began,
    }, w.sayDeps);
    const answer = (await w.q("SELECT payload FROM claw_notification_outbox WHERE payload->>'text' = '有 3 台空闲节点。'"))[0];
    assert.equal(answer.payload.replaces, ack.lookupAckSayId("alice", t.mid), "the answer replaces the server's line");
    // A person with no channel subscribed reads the session: the answer there takes the line's place all the same.
    await w.q("DELETE FROM claw_notification_subscriptions");
    w.events.length = 0;
    const web = await turn("SaFE 上有几个 workspace");
    assert.equal(await run(alice.routerSid, start(web.mid, "mcp__safe__workspace_list")), "said");
    const webBegan = (await w.q("SELECT started_at FROM claw_tasks WHERE task_id = $1", [web.task_id]))[0].started_at;
    await w.mod.outbound.recordAssistantSay({
      userId: "alice", sessionId: alice.routerSid, text: "有 2 个 workspace。", turnMessageId: web.mid, turnBegan: webBegan,
    }, w.sayDeps);
    const shown = w.events.filter((e) => e.type === "AssistantSay");
    assert.deepEqual(shown.map((e) => e.text), ["收到，我查一下。", "有 2 个 workspace。"]);
    assert.equal(shown[1].replaces, ack.lookupAckSayId("alice", web.mid), "the session's copy replaces the line");
  });

  test("A5 a turn that looked things up and ended with no word and no text is told so, once", async () => {
    const end = (t: { task_id: string; mid: string }, extra: Record<string, unknown> = {}) =>
      w.mod.routerTurnEnd.deliverUnsaidAnswer({ sessionId: alice.routerSid, runIds: [t.task_id], messageId: t.mid, failed: false, interrupted: false, ...extra } as never, w.sayDeps);
    // bczh-202: lookups, then nothing.
    const t = await turn("帮我查一下最近关于 MI355X 的新闻");
    for (let i = 0; i < 3; i += 1) await stored(alice.routerSid, t.mid, "web_search", "success");
    await w.closeRun(t.task_id, "completed", undefined, 0);
    const family = w.h.app.metrics.registry.getSingleMetric("claw_assistant_router_unsaid_total");
    const silentCount = async () => ((await family!.get()).values.find((v) => v.labels.outcome === "silent_notice")?.value ?? 0);
    const before = await silentCount();
    assert.equal(await end(t), "said");
    assert.deepEqual((await says()).map((s) => [s.text, s.fallback]), [["我查了一些资料，但这次没能整理出答复。请再问我一次，或者把问题说得具体一点。", true]]);
    assert.equal(await silentCount(), before + 1, "counted (claw_assistant_router_unsaid_total{outcome=silent_notice})");
    assert.equal(await end(t), "skipped", "a redelivered completion stores nothing new");
    assert.equal(await silentCount(), before + 1, "and counted once");
    assert.equal((await says()).length, 1);
    // After the server's own "on it", still told: that line answered nothing.
    await w.q("TRUNCATE claw_assistant_says");
    const en = await turn("search the web for the latest ROCm release");
    assert.equal(await run(alice.routerSid, start(en.mid, "web_search")), "said");
    await stored(alice.routerSid, en.mid, "web_search", "success");
    await w.closeRun(en.task_id, "completed", undefined, 0);
    assert.equal(await end(en), "said");
    assert.deepEqual((await says()).map((s) => s.text), ["On it: searching the web now.", "I looked into it but could not put an answer together this time. Please ask me again, or narrow the question down."]);
    // The router said something: its turn answered.
    await w.q("TRUNCATE claw_assistant_says");
    const spoke = await turn("查一下 ROCm 版本");
    await w.q("INSERT INTO claw_assistant_says (say_id, user_id, text, fallback) VALUES (gen_random_uuid(), 'alice', 'ROCm 7.2。', false)");
    await stored(alice.routerSid, spoke.mid, "web_search", "success");
    await w.closeRun(spoke.task_id, "completed", undefined, 0);
    assert.equal(await end(spoke), "skipped");
    // No lookup: nothing to say for it (T4 of router-turn-end).
    await w.q("TRUNCATE claw_assistant_says");
    const none = await turn("你好");
    await w.closeRun(none.task_id, "completed", undefined, 0);
    assert.equal(await end(none), "skipped");
    // A report's turn may end silent on purpose.
    const report = await turn("[work_event] #1 (item_id: kwi_x) ready v1: Opened PR 12");
    await stored(alice.routerSid, report.mid, "web_search", "success");
    await w.closeRun(report.task_id, "completed", undefined, 0);
    assert.equal(await end(report), "skipped");
    // A turn that started an item: its start notice is the reply.
    const item = await turn("开个事项查一下 CI 为什么挂");
    await stored(alice.routerSid, item.mid, "mcp__github__checks_list", "success");
    await w.createItem(alice, "CI 为什么挂");
    await w.q("TRUNCATE claw_assistant_says");
    await w.closeRun(item.task_id, "completed", undefined, 0);
    assert.equal(await end(item), "skipped");
    assert.equal((await says()).length, 0);
  });

  test("A7 the event consumer says it for a lookup's start event from Brain", async (t0) => {
    const t = await turn("SaFE 上有几个 workspace");
    // No NATS here: no session of this world is a deleted one.
    const realTombstone = { ...w.mod.consumer.tombstoneReader };
    Object.assign(w.mod.consumer.tombstoneReader, { has: async () => false });
    t0.after(() => { Object.assign(w.mod.consumer.tombstoneReader, realTombstone); });
    const verdicts: string[] = [];
    await w.mod.consumer.consumeEventDelivery({
      subject: `events.${alice.routerSid}`,
      data: new TextEncoder().encode(JSON.stringify({ ...start(t.mid, "mcp__safe__workspace_list"), ts: Date.now() })),
      seq: 9_000 + seq,
      ack: () => { verdicts.push("ack"); },
      nak: (ms?: number) => { verdicts.push(`nak:${ms ?? ""}`); },
    } as never);
    assert.deepEqual(verdicts, ["ack"], "the event is stored and acked as before");
    const deadline = Date.now() + 5_000;
    let rows = await says();
    while (!rows.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await says();
    }
    assert.deepEqual(rows.map((s) => s.text), ["收到，我查一下。"]);
  });

  test("A6 a router turn asks Brain for a text reply at its turn cap", async () => {
    const t = await turn("帮我查一下最近关于 MI355X 的新闻");
    const task: Record<string, unknown> = { task_id: t.task_id, message_id: t.mid, prompt: "帮我查一下最近关于 MI355X 的新闻" };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    assert.equal(task.report_at_turn_cap, true);
    assert.ok(Number(task.max_turns) > 0, "a router turn has a cap to report at");
  });

  test("A8 a turn whose own text is being shown has started to answer: no line over it; once taken back, the line comes", async (t0) => {
    const t = await turn("下个月 Kestrel 的冻结期从哪天开始？");
    const realTombstone = { ...w.mod.consumer.tombstoneReader };
    Object.assign(w.mod.consumer.tombstoneReader, { has: async () => false });
    t0.after(() => { Object.assign(w.mod.consumer.tombstoneReader, realTombstone); });
    // From Brain, through the consumer: the deltas are not stored, and the run is marked once.
    const deliver = async (event: Record<string, unknown>) => {
      const verdicts: string[] = [];
      await w.mod.consumer.consumeEventDelivery({
        subject: `events.${alice.routerSid}`, data: new TextEncoder().encode(JSON.stringify({ ...event, message_id: t.mid, ts: Date.now() })),
        seq: 9_500 + ++seq, ack: () => { verdicts.push("ack"); }, nak: () => { verdicts.push("nak"); },
      } as never);
      assert.deepEqual(verdicts, ["ack"]);
    };
    const delta = { type: "toolTextDelta", tool: "mcp__assistant__say", actionId: "text-1-0", text: "下个月冻结期", source: "text" };
    await deliver(delta);
    const stored = await w.q("SELECT count(*)::int AS n FROM claw_session_events WHERE session_id = $1", [alice.routerSid]);
    assert.equal(stored[0].n, 0, "a preview is never stored");
    assert.equal(await run(alice.routerSid, start(t.mid, "web_search")), "writing");
    assert.equal(await ack.ackFirstReply(alice.routerSid, t.mid, { ...w.sayDeps, enabled: true, users: "alice" }), "writing");
    // A say's own preview (no source) marks nothing: that is the stored say start's to tell.
    const other = await turn("还有别的吗");
    await w.mod.consumer.consumeEventDelivery({
      subject: `events.${alice.routerSid}`, seq: 9_600,
      data: new TextEncoder().encode(JSON.stringify({ type: "toolTextDelta", tool: "mcp__assistant__say", actionId: "toolu_1", text: "还", message_id: other.mid })),
      ack: () => {}, nak: () => {},
    } as never);
    const marked = await w.q("SELECT metadata ? 'text_preview' AS marked FROM claw_tasks WHERE task_id = $1", [other.task_id]);
    assert.equal(marked[0].marked, false);
    // Taken back (a tool call followed it): the turn has said nothing after all, and a late delta does not mark it again.
    await deliver({ type: "toolTextVoid", tool: "mcp__assistant__say", actionId: "text-1-0", reason: "tool_call", source: "text" });
    ack.resetLookupAckCacheForTest();
    await deliver({ ...delta, text: "下个月冻结期从" });
    assert.equal(await run(alice.routerSid, start(t.mid, "web_search")), "said");
    assert.deepEqual((await says()).map((r) => r.text), ["收到，我上网查一下。"]);
  });

  test("A9 a router turn has its own text streamed only for the people who have it, and only when it answers them", async (t0) => {
    const speed = await import("../src/assistant/router-speed.js");
    const saved = { ...speed.streamTextSettings };
    t0.after(() => { Object.assign(speed.streamTextSettings, saved); });
    const ask = async (prompt: string) => {
      const t = await turn(prompt);
      const task: Record<string, unknown> = { task_id: t.task_id, message_id: t.mid, prompt };
      await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
      return task;
    };
    Object.assign(speed.streamTextSettings, { all: false, users: new Set(["someone-else"]) });
    assert.equal((await ask("下个月冻结期从哪天开始？")).stream_text_as, undefined, "not named: as before");
    Object.assign(speed.streamTextSettings, { all: false, users: new Set(["alice"]) });
    const task = await ask("下个月冻结期从哪天开始？");
    assert.equal(task.stream_text_as, "mcp__assistant__say");
    assert.deepEqual(task.stream_tool_text, ["mcp__assistant__say"]);
    assert.equal((await ask("[work_event] #1 (item_id: kwi_x) ready v1: done")).stream_text_as, undefined, "a report's text is not the person's");
    Object.assign(speed.streamTextSettings, { all: true, users: new Set() });
    assert.equal((await ask("hi")).stream_text_as, "mcp__assistant__say", "on for everyone");
  });
});

