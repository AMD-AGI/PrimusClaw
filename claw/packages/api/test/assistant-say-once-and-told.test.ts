// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One message per turn, and each waiting thing brought up once, on a real Postgres. Skipped without DATABASE_URL.
 *
 *   T1  a later say of a turn takes the place of the turn's first one (`replaces`, on the delivery and the session event); the first
 *       say of a turn, and a say of another turn, replace nothing (2026-11-06 gate: an answer, then "更正上一条…" as a second message)
 *  T1b a turn that hands a review over carries only the last of a say and those that took its place (`dropHeldSays`)
 *  T1c only what the user can still see tells: not a message whose deliveries were all dropped, nor one a later say replaced
 *   T2  a scheduled task's card is told once its message has gone out; the router's state marks it told, and a card never told is not
 *   T3  a write held for confirmation is told only by a message after it began that names its ref (whole, not as a longer token's start); the review state marks it told
 *   T4  what a worker holds is told by a message about its item under the hold's attention, not under an earlier one
 *   T5  the router's prompts say it: one message a turn, a repeated question compared, a told line not brought up, a review stopped by
 *       its requester
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("say once a turn, and tell each waiting thing once", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let told: typeof import("../src/assistant/told.js");
  let prompts: typeof import("../src/assistant/prompts.js");

  before(async () => {
    w = await startWorld();
    told = await import("../src/assistant/told.js");
    prompts = await import("../src/assistant/prompts.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_notification_outbox, claw_notification_subscriptions,
      claw_pending_messages, claw_tasks, claw_assistants, claw_sessions CASCADE`);
    w.events.length = 0;
    alice = await w.user("alice");
  });

  const turnFor = async (prompt: string) => {
    const turn = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2, started_at = NOW() - INTERVAL '1 second' WHERE task_id = $1", [turn.task_id, prompt]);
    return turn;
  };
  const payloads = async () => (await w.q("SELECT event_id, payload FROM claw_notification_outbox ORDER BY id")).map((r) => r.payload);
  const sayAt = (text: string, agoSec: number, extra: { itemId?: string; seq?: number } = {}) => w.q(
    `INSERT INTO claw_assistant_says (say_id, user_id, item_id, item_attention_seq, text, fallback, created_at)
     VALUES (gen_random_uuid(), 'alice', $1, $2, $3, false, NOW() - make_interval(secs => $4::int))`,
    [extra.itemId ?? null, extra.seq ?? null, text, agoSec],
  );

  test("T1 a later say of a turn takes the first one's place; a first say, or another turn's, replaces nothing", async () => {
    await w.subscribe(alice.userId);
    const first = await turnFor("我开着几个 PR？");
    const quick = await w.mod.tools.say(first as never, { text: "查一下。" }, w.sayDeps);
    const answer = await w.mod.tools.say(first as never, { text: "你开着 38 个 PR。" }, w.sayDeps);
    const fix = await w.mod.tools.say(first as never, { text: "你开着 38 个 PR，其中 PrimusClaw 21 个。" }, w.sayDeps);
    const second = await turnFor("再数一次");
    const again = await w.mod.tools.say(second as never, { text: "还是 38 个，和刚才一样。" }, w.sayDeps);

    const byId = new Map((await payloads()).map((p) => [p.event_id, p]));
    assert.equal(byId.get(quick.say_id)?.replaces, undefined, "a turn's first say replaces nothing");
    assert.equal(byId.get(quick.say_id)?.turn_message_id, first.mid);
    assert.equal(byId.get(answer.say_id)?.replaces, quick.say_id, "the answer takes the quick line's place");
    assert.equal(byId.get(fix.say_id)?.replaces, quick.say_id, "a correction takes the place of the turn's one message, not a second one");
    assert.equal(byId.get(again.say_id)?.replaces, undefined, "another turn's say is a message of its own");
    const said = w.events.filter((e) => e.type === "AssistantSay");
    assert.deepEqual(said.map((e) => e.replaces ?? null), [null, quick.say_id, quick.say_id, null], "a web client is told too");
  });

  test("T1b a turn that hands a review over carries only the last of a say and those that took its place", async () => {
    await w.subscribe(alice.userId);
    const turn = await turnFor("请 Bob 审 AMD-AGI/PrimusClaw#1，另外我开着几个 PR？");
    const quick = await w.mod.tools.say(turn as never, { text: "查一下。" }, w.sayDeps);
    const answer = await w.mod.tools.say(turn as never, { text: "你开着 38 个 PR。" }, w.sayDeps);
    const held = (await import("../src/assistant/say-hold.js")).heldStatus(turn.mid);
    await w.q("UPDATE claw_notification_outbox SET last_status = $1", [held]);
    const byId = new Map((await payloads()).map((p) => [p.event_id, p]));
    assert.equal(byId.get(answer.say_id)?.replaces, quick.say_id);
    const texts = await (await import("../src/assistant/say-hold.js")).dropHeldSays((t, p) => w.h.app.db.db.query(t, p), turn.mid);
    assert.deepEqual(texts, ["你开着 38 个 PR。"], "the quick line is not carried beside the answer that took its place");
    // What the handoff carried was told, though its deliveries were dropped; what it did not carry was not.
    await w.q("UPDATE claw_assistant_says SET text = text || ' #abc123' WHERE say_id = $1", [answer.say_id]);
    await w.q("UPDATE claw_assistant_says SET text = text || ' #abc124' WHERE say_id = $1", [quick.say_id]);
    const q = (t: string, p?: unknown[]) => w.h.app.db.db.query(t, p);
    const since = new Date(Date.now() - 60_000);
    assert.deepEqual([...(await told.toldRefs(q, "alice", [{ ref: "abc123", since }, { ref: "abc124", since }])).keys()], ["abc123"]);
  });

  test("T1c only a message the user can still see tells: not one whose deliveries were all dropped, nor one a later say replaced", async () => {
    await w.subscribe(alice.userId);
    const q = (t: string, p?: unknown[]) => w.h.app.db.db.query(t, p);
    const since = new Date(Date.now() - 60_000);
    const dropped = await turnFor("请 Bob 审 #1");
    const gone = await w.mod.tools.say(dropped as never, { text: "顺便：#d00d01 还在等你" }, w.sayDeps);
    await w.q("UPDATE claw_notification_outbox SET dropped_at = NOW() WHERE event_id = $1", [gone.say_id]);
    const fixed = await turnFor("还有什么等我");
    await w.mod.tools.say(fixed as never, { text: "#e0e0e1 在等你" }, w.sayDeps);
    await w.mod.tools.say(fixed as never, { text: "没有别的了。" }, w.sayDeps);
    const shown = await turnFor("再说一次");
    await w.mod.tools.say(shown as never, { text: "#f00f01 在等你" }, w.sayDeps);
    const map = await told.toldRefs(q, "alice", ["d00d01", "e0e0e1", "f00f01"].map((ref) => ({ ref, since })));
    assert.deepEqual([...map.keys()], ["f00f01"], "a dropped message and a replaced one told nothing");
    assert.equal((await told.toldRefs(q, "alice", [{ ref: "F00F01", since }])).size, 1, "a ref is read in either case");
  });

  test("T2 a scheduled task's card is told once its message went out; one never told is not marked", async () => {
    await w.q(
      `INSERT INTO claw_assistant_confirmations (confirmation_id, user_id, session_id, message_id, kind, params, dedupe_key, status, created_at, expires_at)
       VALUES ('6e3fb011-0000-4000-8000-000000000001', 'alice', $3, 'm-1', 'trigger_create', $1::jsonb, 'd-1', 'pending', NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '1 hour'),
              ('a1b2c311-0000-4000-8000-000000000002', 'alice', $3, 'm-2', 'trigger_create', $2::jsonb, 'd-2', 'pending', NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '1 hour')`,
      [JSON.stringify({ name: "tomli 查询", schedule: "21 17 6 11 *", timezone: "UTC" }), JSON.stringify({ name: "PR 早报", schedule: "0 9 * * *", timezone: "UTC" }), alice.routerSid],
    );
    // A message before the card began does not tell it, even with the same characters in it.
    await sayAt("旧消息 #6e3fb0", 3600);
    await sayAt("定时任务 tomli 查询 等你确认：回复 批准 #6e3fb0", 590);
    const state = await (await import("../src/assistant/schedules.js")).renderScheduleState("alice");
    const [tomli, daily] = state.split("\n").filter((l) => l.startsWith("- ref"));
    assert.match(tomli, /^- ref #6e3fb0 .*\| told: the user was told of this at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    assert.doesNotMatch(daily, /told/, "a card never named in a message to the user is not told");
  });

  test("T3 a write held for confirmation is told only by a message after it began that names its ref", async () => {
    const since = new Date(Date.now() - 60_000);
    await sayAt("#c0ffee 还在等你", 120);
    let map = await told.toldRefs((t, p) => w.h.app.db.db.query(t, p), "alice", [{ ref: "c0ffee", since }, { ref: "beef00", since }]);
    assert.equal(map.size, 0, "a message before it began tells nothing");
    await sayAt("别的 #c0ffee00 不是它", 40);
    assert.equal((await told.toldRefs((t, p) => w.h.app.db.db.query(t, p), "alice", [{ ref: "c0ffee", since }])).size, 0,
      "a longer token that starts with the ref does not name it");
    await sayAt("合入 AMD-AGI/PrimusClaw#335 等你确认：批准 #c0ffee", 30);
    await sayAt("bob's #beef00", 10);
    await w.q("UPDATE claw_assistant_says SET user_id = 'bob' WHERE text = $1", ["bob's #beef00"]);
    map = await told.toldRefs((t, p) => w.h.app.db.db.query(t, p), "alice", [{ ref: "c0ffee", since }, { ref: "beef00", since }]);
    assert.deepEqual([...map.keys()], ["c0ffee"], "told by a message of the user's naming it; another user's message tells nothing");
    const line = prompts.renderReviewState({
      confirmations: [
        { id: "c0ffee00-1111-4000-8000-000000000000", repo: "AMD-AGI/PrimusClaw", pr: 335, kind: "merge", expires_at: new Date(), told_at: map.get("c0ffee") },
        { id: "beef0000-1111-4000-8000-000000000000", repo: "AMD-AGI/PrimusClaw", pr: 336, kind: "merge", expires_at: new Date(), told_at: null },
      ],
      reviewMode: "high_risk_confirm", people: [], actions: [], repos: [],
    });
    assert.match(line, /ref #c0ffee .*\| told: the user was told of this at /);
    assert.doesNotMatch(line.split("\n").find((l) => l.includes("#beef00")) ?? "", /told/);
  });

  test("T4 what a worker holds is told under the hold's attention, and untold again when that moves on", async () => {
    await sayAt("#7 部署 等你批准", 60, { itemId: "kwi_held", seq: 3 });
    const q = (t: string, p?: unknown[]) => w.h.app.db.db.query(t, p);
    const map = await told.toldNeeds(q, "alice", [{ itemId: "kwi_held", attentionSeq: 3 }, { itemId: "kwi_held", attentionSeq: 4 }]);
    assert.ok(told.toldNeedAt(map, { itemId: "kwi_held", attentionSeq: 3 }));
    assert.equal(told.toldNeedAt(map, { itemId: "kwi_held", attentionSeq: 4 }), undefined, "a new attention is a new thing to tell");
    assert.equal((await told.toldNeeds(q, "bob", [{ itemId: "kwi_held", attentionSeq: 3 }])).size, 0, "only the user's own messages");
  });

  test("T5 the router is told: one message a turn, a repeated question compared, a told line left alone, a review stopped by its requester", () => {
    assert.match(prompts.ROUTER_PROMPT, /a say later in the turn takes the place of your earlier say/);
    assert.match(prompts.ROUTER_PROMPT, /never a second message that corrects or adds to the first/);
    assert.match(prompts.ROUTER_PROMPT, /how it compares with your last one/);
    assert.match(prompts.ROUTER_PROMPT, /a line marked told was already told to the user/);
    assert.match(prompts.ROUTER_REVIEW_PROMPT, /The user can always stop a review they asked someone else to do, from here/);
    assert.match(prompts.ROUTER_REVIEW_PROMPT, /Never tell them a review they asked for cannot be stopped from here/);
  });
});
