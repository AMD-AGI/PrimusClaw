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
 *   F5  a say the router started and that was refused does not hold the line back; one still being written does
 *   F6  a message the route queues behind a running turn hears the line 3.5 s after it came in, before its run opens, and the
 *       answer of the run that later carries it takes the line's place
 *   F7  a turn that starts an item after the line: the start notice takes the line's place, and the router's words after it are added
 *       to that same message (one message in the channel, as without the line); but never once the line's message shows something
 *       else: after the router's say took its place, or for a second item's notice, the notice is its own message, as without the line;
 *       two notices stored at once included
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
  /** The says once there is one, waiting up to `ms`: a loaded runner fires the timer late, never early. */
  const saysWithin = async (ms: number) => {
    const until = Date.now() + ms;
    let rows = await says();
    while (!rows.length && Date.now() < until) { await sleep(100); rows = await says(); }
    return rows;
  };
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
    const rows = await saysWithin(2_500);
    assert.equal(rows.length, 1, "one line at the deadline");
    assert.equal(rows[0].text, "收到，我看一下。");
    assert.equal(rows[0].fallback, true, "the system's words: not taken for the turn having answered");
    assert.equal(rows[0].say_id, ack.lookupAckSayId("alice", t.mid));
    const at = new Date(rows[0].created_at).getTime() - t.created.getTime();
    assert.ok(at >= 3_500 && at < 5_000, `said at ${at} ms after the turn began: from the deadline, within the 5 s target`);
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

  test("F5 a refused say does not hold the line back; a say still being written does", async () => {
    const say = (mid: string, status: string) => w.q(
      "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, 'toolUsed', $3)",
      [`claw-f5-${++seq}`, alice.routerSid, JSON.stringify({ type: "toolUsed", message_id: mid, tool: "mcp__assistant__say", status })],
    );
    const refused = await turn("我记住了哪些事");
    await say(refused.mid, "start");
    assert.equal(await first(alice.routerSid, refused.mid), "saying", "a say on its way");
    await say(refused.mid, "error");
    assert.equal(await first(alice.routerSid, refused.mid), "said", "the say was refused: nothing reached the person");
    await w.q("TRUNCATE claw_assistant_says");
    const again = await turn("我有哪些事项");
    await say(again.mid, "start");
    await say(again.mid, "error");
    await say(again.mid, "start");
    assert.equal(await first(alice.routerSid, again.mid), "saying", "written again and still on its way");
  });

  test("F6 a message queued behind a running turn hears the line 3.5 s after it came in, and its answer replaces it", async () => {
    await w.subscribe("alice");
    const Fastify = (await import("fastify")).default;
    const { registerSessionRoutes } = await import("../src/routes/sessions.js");
    // A turn is running (a worker's report being read): the person's message queues behind it.
    await w.openRun(alice.routerSid, { messageId: "claw-report-turn" });
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { userId: "alice", userName: "Alice", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
    });
    await registerSessionRoutes(app);
    await app.ready();
    let mid: string;
    const sent = Date.now();
    try {
      const res = await app.inject({ method: "POST", url: `/v1/sessions/${alice.routerSid}/messages`, payload: { content: "我的事项都怎么样了" } });
      const body = res.json() as { queued?: boolean; message_id?: string };
      assert.equal(body.queued, true, "queued behind the running turn");
      mid = body.message_id!;
    } finally { await app.close(); }
    assert.match(mid, /^claw-pending-\d+$/);
    await sleep(3_000);
    assert.equal((await says()).length, 0, "nothing before the deadline");
    const rows = await saysWithin(2_500);
    assert.deepEqual(rows.map((r) => [r.text, r.fallback]), [["收到，我看一下。", true]], "the line, with no run open yet");
    assert.equal(rows[0].say_id, ack.lookupAckSayId("alice", mid));
    const at = new Date(rows[0].created_at).getTime() - sent;
    assert.ok(at >= 3_400 && at < 5_000, `said ${at} ms after the message was sent: from its arrival, within the 5 s target`);
    // The report turn ends; the drain opens the message's run under its id, and the answer replaces the line.
    await w.q("UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE metadata->>'message_id' = 'claw-report-turn'");
    await w.q("DELETE FROM claw_pending_messages WHERE session_id = $1", [alice.routerSid]);
    const run = await chatRun.openChatRun({
      dispatch: "fat", sessionId: alice.routerSid, userId: "alice", messageId: mid, prompt: "我的事项都怎么样了", recordWorkspaceUse: false,
    });
    const began = (await w.q("SELECT started_at FROM claw_tasks WHERE task_id = $1", [run!.taskId]))[0].started_at;
    await w.mod.outbound.recordAssistantSay({
      userId: "alice", sessionId: alice.routerSid, text: "你有 2 个事项在进行。", turnMessageId: mid, turnBegan: began,
    }, w.sayDeps);
    const answer = (await w.q("SELECT payload FROM claw_notification_outbox WHERE payload->>'text' = '你有 2 个事项在进行。'"))[0];
    assert.equal(answer.payload.replaces, ack.lookupAckSayId("alice", mid), "one message: the answer edits the line");
    // The run's own timer, armed when it opened, finds the line said.
    assert.equal(await first(alice.routerSid, mid), "spoke");
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
  test("F7 an item started after the line: the start notice takes its place, and what the router adds goes to that message", async () => {
    await w.subscribe("alice");
    const turn = await w.routerTurn(alice);
    const content = "帮我新建一个任务：写一份 ROCm 7.2 升级说明";
    await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() WHERE task_id = $1", [turn.task_id, content]);
    await message(alice.routerSid, turn.mid, content);
    assert.equal(await first(alice.routerSid, turn.mid), "said");
    const ackId = ack.lookupAckSayId("alice", turn.mid);
    const created = await w.mod.tools.workCreate(turn as never, { title: "ROCm 7.2 升级说明", brief: "write it" }, w.sayDeps);
    assert.equal(created.announced, true);
    const notice = (await w.q("SELECT payload FROM claw_notification_outbox WHERE payload->>'text' LIKE '已开始：#%'"))[0];
    assert.equal(notice?.payload.replaces, ackId, "the start notice edits the line: one message");
    const added = await w.mod.tools.say(turn as never, { text: "顺便：会写清楚回滚步骤。" }, w.sayDeps);
    assert.equal(added.ok, true);
    const event = w.events.find((e) => e.type === "AssistantSay" && e.say_id === added.say_id);
    assert.equal(event?.amends, ackId, "added to the message the notice now is (the line's)");
    const out = await w.q("SELECT payload FROM claw_notification_outbox ORDER BY created_at, event_id");
    assert.equal(out.filter((o) => !o.payload.replaces && !o.payload.amends).length, 1, "one new message in the channel: the line");
    // Without the line, the notice is its own message and the addition names it, as before.
    await w.q("TRUNCATE claw_notification_outbox, claw_assistant_says");
    w.events.length = 0;
    const plain = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() WHERE task_id = $1", [plain.task_id, "帮我新建一个任务：整理发布说明"]);
    await message(alice.routerSid, plain.mid, "帮我新建一个任务：整理发布说明");
    const c2 = await w.mod.tools.workCreate(plain as never, { title: "整理发布说明", brief: "do it" }, w.sayDeps);
    assert.equal(c2.announced, true);
    const n2 = (await w.q("SELECT event_id, payload FROM claw_notification_outbox WHERE payload->>'text' LIKE '已开始：#%'"))[0];
    assert.equal(n2.payload.replaces, undefined);
    const a2 = await w.mod.tools.say(plain as never, { text: "顺便：按版本分组。" }, w.sayDeps);
    assert.equal(w.events.find((e) => e.type === "AssistantSay" && e.say_id === a2.say_id)?.amends, n2.event_id);
  });
  test("F7b the notice never overwrites what took the line's place: a router say before it, or the first item's notice", async () => {
    await w.subscribe("alice");
    const notices = async () => w.q("SELECT event_id, payload FROM claw_notification_outbox WHERE payload->>'text' LIKE '已开始：#%' ORDER BY created_at, event_id");
    // The line, the router's say (in the line's place), then the item: the notice is its own message, the say stays.
    const a = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() WHERE task_id = $1", [a.task_id, "帮我新建一个任务：整理周报"]);
    await message(alice.routerSid, a.mid, "帮我新建一个任务：整理周报");
    assert.equal(await first(alice.routerSid, a.mid), "said");
    const said = await w.mod.tools.say(a as never, { text: "好的，这就建一个整理周报的任务。" }, w.sayDeps);
    assert.equal(w.events.find((e) => e.type === "AssistantSay" && e.say_id === said.say_id)?.replaces, ack.lookupAckSayId("alice", a.mid));
    assert.equal((await w.mod.tools.workCreate(a as never, { title: "整理周报", brief: "do it" }, w.sayDeps)).announced, true);
    assert.equal((await notices())[0].payload.replaces, undefined, "the router's words stay in the line's place");
    // The line, then two items: the first notice takes the line's place, the second is its own message.
    await w.q("TRUNCATE claw_notification_outbox, claw_assistant_says");
    const b = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() WHERE task_id = $1", [b.task_id, "帮我建两个任务：修 CI 和写文档"]);
    await message(alice.routerSid, b.mid, "帮我建两个任务：修 CI 和写文档");
    assert.equal(await first(alice.routerSid, b.mid), "said");
    await w.mod.tools.workCreate(b as never, { title: "修 CI", brief: "fix it" }, w.sayDeps);
    await w.mod.tools.workCreate(b as never, { title: "写文档", brief: "write it" }, w.sayDeps);
    const two = await notices();
    assert.equal(two.length, 2);
    assert.equal(two[0].payload.replaces, ack.lookupAckSayId("alice", b.mid));
    assert.equal(two[1].payload.replaces, undefined, "the second item's notice does not overwrite the first's");
  });
  test("F7c two start notices of one turn stored at once: only one takes the line's place", async () => {
    await w.subscribe("alice");
    for (let round = 0; round < 8; round += 1) {
      await w.q("TRUNCATE claw_notification_outbox, claw_assistant_says");
      const t = await w.routerTurn(alice);
      await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() WHERE task_id = $1", [t.task_id, "帮我建两个任务"]);
      await message(alice.routerSid, t.mid, "帮我建两个任务");
      assert.equal(await first(alice.routerSid, t.mid), "said");
      const notice = (n: number) => w.mod.outbound.recordSystemNotice({
        userId: "alice", sessionId: alice.routerSid, text: `已开始：#${n} 任务 ${n}。`, key: `work_started:race-${round}-${n}`,
        turnMessageId: t.mid, replacesTurnAck: true,
      }, w.sayDeps);
      await Promise.all([notice(1), notice(2)]);
      const replacing = await w.q("SELECT 1 FROM claw_notification_outbox WHERE payload->>'replaces' = $1", [ack.lookupAckSayId("alice", t.mid)]);
      assert.equal(replacing.length, 1, `round ${round}: one notice in the line's place, the other its own message`);
    }
  });
});
