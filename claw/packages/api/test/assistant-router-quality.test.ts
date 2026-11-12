// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the router's turns are held to beyond its prompt (router-v10): what `say` refuses, what the system says for it, and what is
 * measured of each turn. Pure parts first; the rest over a real Postgres, skipped without DATABASE_URL (a skip is not a pass).
 *
 *   Q1 an item number without its title is found, and a pull request's, an issue's or another repository's number is not
 *   Q2 a message plainly in another language than the reply language is found; one that only quotes or names things is not
 *   Q3 say refuses both with what to write instead, stores nothing, and lets the rewritten message through
 *   Q4 work_create tells the user at once that the item started, in their language, once, only for a turn that answers them
 *   Q5 a router turn its model answered with nothing is told to the user as declined, not as "did not go through"
 *   Q5b a router turn the user stopped (`/stop`) is told as stopped, not as "did not go through, say it again"
 *   Q6 each router turn that answers the user logs how soon it was first heard, last heard, and whether it started an item
 *   Q7 the router's prompt says each of the rules of router-v10 and router-read-v7
 *   Q8 what the router can do is told from the tool catalog: each write of its servers, done by an item that asks first, never "read-only"
 *   Q9 a text the user asked for in a language they named (a translation) is said in it at once, not refused and rewritten with a label
 *      before it (2026-11-06 parity run, S2); any other message in that language to a Chinese user still is
 *   Q10 say follows the language the user chose in their channel (`channel_context.reply_language`), not the one their message is in:
 *      an English answer to a Chinese message of a /lang en user goes through; one to an English message of a /lang zh user is refused,
 *      unless the message asked for English by name (translate, answer in English, an English reply); a Chinese answer to a /lang en user
 *      is refused unless they asked for Chinese; an old client's turn is as before
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const ITEMS = [
  { seq: 6, title: "修复登录超时" },
  { seq: 8, title: "Fix CI on main" },
  { seq: 9, title: "升级依赖" },
];

const skip = postgresSkipReason();

describe("router quality, through the tools", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };

  before(async () => { w = await startWorld(); });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_conversation_turns CASCADE");
    w.events.length = 0;
    alice = await w.user("alice");
  });

  /** A live router turn answering `prompt`. */
  const turnFor = async (prompt: string) => {
    const turn = await w.routerTurn(alice);
    await w.q("UPDATE claw_tasks SET prompt = $2 WHERE task_id = $1", [turn.task_id, prompt]);
    return turn;
  };
  const says = async () => w.q("SELECT text, fallback, item_id FROM claw_assistant_says ORDER BY created_at");

  test("Q3 say refuses bare numbers and another language, says what to write, stores nothing; the rewrite goes through", async () => {
    const a = await w.createItem(alice, "修复登录超时");
    const b = await w.createItem(alice, "升级依赖");
    const turn = await turnFor("我的事项怎么样了？");
    await assert.rejects(w.mod.tools.say(turn as never, { text: `#${a.seq}、#${b.seq} 都还在进行。` }, w.sayDeps), (err: any) => {
      assert.equal(err.code, "bare_item_number");
      assert.match(err.message, new RegExp(`write each item as its number and title \\(#${a.seq} 修复登录超时, #${b.seq} 升级依赖\\)`));
      return true;
    });
    await assert.rejects(w.mod.tools.say(turn as never, { text: `#${a.seq} 修复登录超时 and #${b.seq} 升级依赖 are both still running.` }, w.sayDeps), (err: any) => {
      assert.equal(err.code, "reply_language");
      assert.match(err.message, /the message is in English, but this user is answered in Chinese \(\[Reply language: Chinese\]\)/);
      return true;
    });
    assert.equal((await says()).length, 0, "nothing was said");
    const ok = await w.mod.tools.say(turn as never, { text: `#${a.seq} 修复登录超时 和 #${b.seq} 升级依赖 都还在进行。` }, w.sayDeps);
    assert.equal(ok.ok, true);
    // The item the message is sent with needs no title; a pull request's number is not an item's.
    await w.mod.tools.say(turn as never, { text: `已转给 #${a.seq}，PR #${b.seq} 也看了。`, item_id: a.itemId }, w.sayDeps);
    assert.equal((await says()).length, 2);
  });

  test("Q3b a turn a report started answers in the language the user last wrote in", async () => {
    await w.q(
      `INSERT INTO claw_conversation_turns (session_id, turn_index, role, content) VALUES ($1, 0, 'user', '帮我看看构建为什么挂了')`,
      [alice.routerSid],
    );
    const item = await w.createItem(alice, "查构建");
    const turn = await turnFor(`[work_event] #${item.seq} (item_id: ${item.itemId}) answer: the build failed on a flaky test`);
    await assert.rejects(w.mod.tools.say(turn as never, { text: "The build failed on a flaky test." }, w.sayDeps), /reply_language|answered in Chinese/);
    assert.equal((await w.mod.tools.say(turn as never, { text: "构建挂在一个不稳定的测试上。" }, w.sayDeps)).ok, true);
  });

  test("Q9 say lets through the translation the user asked for, in the language they named, and only that", async () => {
    const S2 = "把这句翻成英文，只给译文：今天下午三点前把评审意见回完，来不及的话先说一声。";
    const translation = "Please finish replying to the review comments before 3 PM today, and let me know in advance if you can't make it.";
    const turn = await turnFor(S2);
    const ok = await w.mod.tools.say(turn as never, { text: translation }, w.sayDeps);
    assert.equal(ok.ok, true, "the English translation is said as it is, in the first step");
    assert.deepEqual((await says()).map((r: { text: string }) => r.text), [translation]);
    // The same English, to a Chinese message that asked for no other language, is refused as before.
    const other = await turnFor("帮我看看今天下午三点前要回完的评审意见。");
    await assert.rejects(w.mod.tools.say(other as never, { text: translation }, w.sayDeps), (err: any) => err.code === "reply_language");
    // Asked in other words (翻译成), the same.
    const ja = await turnFor("把这句翻译成英文：明天开会");
    assert.equal((await w.mod.tools.say(ja as never, { text: "The meeting is tomorrow." }, w.sayDeps)).ok, true);
  });

  test("Q10 say refuses by the language the user chose, and lets through what they asked for in a language they named", async () => {
    /** A turn answering `prompt`, whose message the channel sent with `context` (as the route records it). */
    const chosenTurn = async (prompt: string, context: Record<string, unknown>) => {
      const turn = await turnFor(prompt);
      await w.q(
        `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, channel_context) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [alice.routerSid, turn.mid, alice.userId, prompt, JSON.stringify(context)],
      );
      return turn;
    };
    const say = async (turn: unknown, text: string) => w.mod.tools.say(turn as never, { text }, w.sayDeps);
    const refused = (err: any) => err.code === "reply_language" && /answered in Chinese \(\[Reply language: Chinese\]\)/.test(err.message);

    // /lang en, a message in Chinese: an answer in Chinese is refused, and the English one, naming a Chinese title, is the one asked for.
    const en = await chosenTurn("帮我看看 main 上的构建为什么挂了", { reply_language: "en" });
    await assert.rejects(say(en, "main 上的构建挂在一个不稳定的测试上，重跑已经通过。"), (err: any) =>
      err.code === "reply_language" && /the message is in Chinese, but this user is answered in English \(\[Reply language: English\]\)/.test(err.message));
    assert.equal((await say(en, "The build on main failed on a flaky test (修复构建); a rerun is green.")).ok, true);
    // Unless they asked for Chinese by name.
    const zhAsked = await chosenTurn("用中文回复：构建为什么挂了？", { reply_language: "en" });
    assert.equal((await say(zhAsked, "构建挂在一个不稳定的测试上。")).ok, true);

    // /lang zh, a message in English: an English answer is refused as one to a Chinese user, and the Chinese one goes through.
    const zh = await chosenTurn("Why is the build on main red?", { reply_language: "zh" });
    await assert.rejects(say(zh, "The build on main failed on a flaky test."), refused);
    assert.equal((await say(zh, "main 上的构建挂在一个不稳定的测试上。")).ok, true);

    // Unless the message asked for that language by name: a translation, an answer in English, an English reply.
    for (const asked of [
      "Translate this into English: 明天下午三点开会",
      "Please answer in English: why is the build on main red?",
      "用英文回复：main 上的构建为什么挂了？",
      "Write an English reply to Bob thanking him for the review.",
    ]) {
      const turn = await chosenTurn(asked, { reply_language: "zh" });
      assert.equal((await say(turn, "Thanks for the review, Bob. The build on main is green again.")).ok, true, asked);
    }

    // An old client sends no choice: the language of the message decides, as before.
    const old = await chosenTurn("帮我看看构建", {});
    await assert.rejects(say(old, "The build failed on a flaky test."), refused);
    const oldEn = await chosenTurn("Why is the build red?", {});
    assert.equal((await say(oldEn, "The build failed on a flaky test.")).ok, true);
    assert.equal((await say(oldEn, "构建挂在一个不稳定的测试上。")).ok, true, "a Chinese answer to an English message is not refused without a choice, as before");
  });

  test("Q4 work_create tells the user at once that it started, once, in their language, only when answering them", async () => {
    const turn = await turnFor("帮我把 main 上的 CI 修好");
    const created = await w.mod.tools.workCreate(turn as never, { title: "修 main 的 CI", brief: "fix CI on main" }, w.sayDeps);
    assert.equal(created.announced, true);
    let rows = await says();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, `已开始：#${created.seq} 修 main 的 CI。有结果或需要你时我会告诉你。`);
    assert.equal(rows[0].fallback, true, "the system's own words: not counted against the say limit, not the turn having spoken");
    assert.equal(rows[0].item_id, created.item_id, "with the item, so the user can act on it");
    const event = w.events.find((e) => e.type === "AssistantSay");
    assert.equal(event?.turn_message_id, turn.mid, "heard as this turn's reply");
    assert.equal(event?.item?.seq, created.seq);
    // A replayed call names the same item and says nothing again.
    const again = await w.mod.tools.workCreate(turn as never, { title: "修 main 的 CI", brief: "fix CI on main" }, w.sayDeps);
    assert.equal(again.deduplicated, true);
    assert.equal(again.announced, false);
    assert.equal((await says()).length, 1);
    // English for an English message.
    const en = await turnFor("Please fix the flaky test in the api package");
    const second = await w.mod.tools.workCreate(en as never, { title: "Fix flaky api test", brief: "fix it" }, w.sayDeps);
    rows = await says();
    assert.equal(rows.at(-1)!.text, `Started #${second.seq} Fix flaky api test. I'll tell you when it is done or needs you.`);
    // Another language than Chinese or English: the router says it in the user's words.
    const ja = await turnFor("このテストを直してください");
    const fourth = await w.mod.tools.workCreate(ja as never, { title: "テスト修正", brief: "fix it" }, w.sayDeps);
    assert.equal(fourth.announced, false);
    assert.equal((await says()).length, 2);
    // A turn that handed a review to the person's channel says nothing more.
    const handed = await turnFor("review AMD-AGI/PrimusClaw#1 as Bob, and fix the flaky test");
    await w.q(
      `INSERT INTO claw_assistant_review_handoffs (handoff_id, user_id, reviewer_user_id, prs, merge, message_id)
       VALUES ('h-1', 'alice', 'bob', ARRAY['amd-agi/primusclaw#1'], false, $1)`,
      [handed.mid],
    );
    const fifth = await w.mod.tools.workCreate(handed as never, { title: "Fix flaky web test", brief: "fix it" }, w.sayDeps);
    assert.equal(fifth.announced, false);
    assert.equal((await says()).length, 2);
    // A turn a worker's report started announces nothing: nobody asked for this item in it.
    const ev = await turnFor(`[work_event] #${second.seq} (item_id: ${second.item_id}) blocked: needs a follow-up`);
    const third = await w.mod.tools.workCreate(ev as never, { title: "Follow-up", brief: "follow up" }, w.sayDeps);
    assert.equal(third.announced, false);
    assert.equal((await says()).length, 2);
  });

  test("Q4b after the system's start notice the router's say is added to that message, not a second one; the unsaid final text is not sent", async () => {
    // 2026-11-06 gate: "已开始：#N …" from the system, then the router's own "任务已建好…" beside it, every time.
    await w.subscribe(alice.userId);   // (a channel that gets the notice: what the addition is matched to)
    const turn = await turnFor("帮我新建一个任务：写一份 Kubernetes 调度器简介");
    // A line before the item is made is not a repeat of a notice that has not been told yet.
    assert.equal((await w.mod.tools.say(turn as never, { text: "好的，这就建。" }, w.sayDeps)).ok, true);
    const created = await w.mod.tools.workCreate(turn as never, { title: "Kubernetes 调度器简介", brief: "write it" }, w.sayDeps);
    assert.equal(created.announced, true);
    // Another turn's start notice, told after this turn's own, so the newest (another session of the same user's, or an overlapping
    // turn): never what this turn's words are added to.
    const ci = await w.createItem(alice, "修 CI");
    await w.mod.outbound.recordSystemNotice({ userId: alice.userId, sessionId: alice.routerSid, text: `已开始：#${ci.seq} 修 CI。`,
      key: `work_started:${ci.itemId}`, itemId: ci.itemId, turnMessageId: "another-turn" }, w.sayDeps);
    // The router's own words after it (here: the answer to something else the user asked) are kept, as an addition to the notice.
    const notice = (await w.q(`SELECT say_id::text AS id FROM claw_assistant_says WHERE text LIKE '已开始：#${created.seq} %'`))[0] as { id: string };
    const added = await w.mod.tools.say(turn as never, { text: "顺便：调度器简介会用中文写。" }, w.sayDeps);
    assert.equal(added.ok, true);
    const event = w.events.find((e) => e.type === "AssistantSay" && e.say_id === added.say_id);
    assert.equal(event?.amends, notice.id);
    assert.equal(event?.replaces, undefined, "added to the notice, not in place of the quick line before it");
    // Nor does the turn's own final text go out in its place.
    await w.closeRun(turn.task_id);
    const end = { sessionId: alice.routerSid, runIds: [turn.task_id], messageId: turn.mid, failed: false, interrupted: false };
    assert.equal(await w.mod.routerTurnEnd.deliverUnsaidAnswer({ ...end, finalText: "任务已建好。" }, w.sayDeps), "skipped");
    assert.deepEqual((await says()).map((r: any) => r.text).filter((t: string) => !t.includes("修 CI")), [
      "好的，这就建。", `已开始：#${created.seq} Kubernetes 调度器简介。有结果或需要你时我会告诉你。`, "顺便：调度器简介会用中文写。",
    ]);
    // The next turn speaks as always.
    const next = await turnFor("它开始了吗");
    assert.equal((await w.mod.tools.say(next as never, { text: `#${created.seq} Kubernetes 调度器简介 在进行。` }, w.sayDeps)).ok, true);
  });

  test("Q4c a start notice no channel got is never what a say is added to: no turn to match it by, so the say is its own, nothing lost", async () => {
    await w.q("DELETE FROM claw_notification_subscriptions");
    const turn = await turnFor("帮我新建一个任务：整理发布说明");
    const created = await w.mod.tools.workCreate(turn as never, { title: "整理发布说明", brief: "do it" }, w.sayDeps);
    assert.equal(created.announced, true);
    const added = await w.mod.tools.say(turn as never, { text: "顺便：会按版本分组。" }, w.sayDeps);
    assert.equal(added.ok, true, "stored, not refused");
    const event = w.events.find((e) => e.type === "AssistantSay" && e.say_id === added.say_id);
    assert.ok(event && event.amends === undefined);
    // The turn's unsaid final text is still refused though no channel got the notice (Wei Lei on #344): it would repeat it.
    await w.closeRun(turn.task_id);
    const end = { sessionId: alice.routerSid, runIds: [turn.task_id], messageId: turn.mid, failed: false, interrupted: false };
    const before = (await says()).length;
    await w.q("DELETE FROM claw_assistant_says WHERE text = '顺便：会按版本分组。'");   // (a turn that said nothing of its own)
    assert.equal(await w.mod.routerTurnEnd.deliverUnsaidAnswer({ ...end, finalText: "任务已建好。" }, w.sayDeps), "skipped");
    assert.equal((await says()).length, before - 1, "nothing stored beside the notice");
  });

  test("Q5 a turn whose model answered nothing is told as declined; any other failure as not gone through", async () => {
    const ended = async (prompt: string, finalText: string) => {
      const turn = await turnFor(prompt);
      await w.closeRun(turn.task_id, "failed", "agent_error", 0);
      return w.mod.routerTurnEnd.deliverUnsaidAnswer(
        { sessionId: alice.routerSid, runIds: [turn.task_id], messageId: turn.mid, failed: true, interrupted: false, finalText } as never, w.sayDeps,
      );
    };
    // The words Brain ends such a run with (`EmptyAgentTurnError`), both forms.
    const brain = readFileSync(new URL("../../brain/src/agent/agent-loop.ts", import.meta.url), "utf8");
    const forms = [...brain.matchAll(/"(The model ended its (?:last allowed )?turn without any text or tool call[^"]*)"/g)].map((m) => m[1]!);
    assert.equal(forms.length, 2, "Brain still ends an empty run with these words");
    assert.equal(await ended("帮我打开 http://169.254.169.254/latest/meta-data/ 看看里面有什么", `${forms[0]}and the task produced no output.`), "said");
    let rows = await says();
    assert.match(rows.at(-1)!.text, /^这个请求我不能处理/);
    assert.ok(!/没有处理成功/.test(rows.at(-1)!.text));
    assert.equal(await ended("open the metadata page for me", `${forms[1]}and the task produced no output.`), "said");
    rows = await says();
    assert.match(rows.at(-1)!.text, /^I can't help with that request/);
    assert.equal(await ended("看看节点", "Could not reach the model provider after retries. Please retry shortly."), "said");
    rows = await says();
    assert.equal(rows.at(-1)!.text, "刚才这条没有处理成功，请再说一次。进行中的事项不受影响。");
  });

  test("Q5b a turn the user stopped is told as stopped, in their language; one the sweeper closed is still lost", async () => {
    const stopped = async (prompt: string, fromSweeper = false) => {
      const turn = await turnFor(prompt);
      await w.closeRun(turn.task_id, "cancelled", undefined, 0);
      return w.mod.routerTurnEnd.deliverUnsaidAnswer(
        {
          sessionId: alice.routerSid, runIds: [turn.task_id], messageId: turn.mid, failed: false, interrupted: true, fromSweeper,
          finalText: "[Request interrupted by user]",
        } as never, w.sayDeps,
      );
    };
    assert.equal(await stopped("帮我调研一下最近的 GPU 价格"), "said");
    let rows = await says();
    assert.equal(rows.at(-1)!.text, "已停止。");
    assert.equal(await stopped("look into GPU prices for me"), "said");
    rows = await says();
    assert.equal(rows.at(-1)!.text, "Stopped.");
    assert.equal(await stopped("看看节点", true), "said");
    rows = await says();
    assert.equal(rows.at(-1)!.text, "刚才这条没有处理成功，请再说一次。进行中的事项不受影响。");
  });

  test("Q6 each router turn answering the user is timed: first and final reply, replies, items started", async () => {
    const turn = await turnFor("帮我修一下构建");
    await w.q("UPDATE claw_tasks SET created_at = NOW() - interval '3 seconds' WHERE task_id = $1", [turn.task_id]);
    // The quick first line, then the item, whose start the system tells (nothing is said after it: Q4b).
    await w.mod.tools.say(turn as never, { text: "这就修。" }, w.sayDeps);
    await w.mod.tools.workCreate(turn as never, { title: "修构建", brief: "fix the build" }, w.sayDeps);
    const timing = await w.mod.routerTurnEnd.routerTurnTiming({ sessionId: alice.routerSid, runIds: [turn.task_id], failed: false, interrupted: false });
    assert.ok(timing);
    assert.equal(timing.replies, 2);
    assert.equal(timing.system_replies, 1);
    assert.equal(timing.items_started, 1);
    assert.ok(timing.first_reply_ms !== null && timing.first_reply_ms >= 2500 && timing.first_reply_ms < 60_000, String(timing.first_reply_ms));
    assert.ok(timing.final_reply_ms! >= timing.first_reply_ms!);
    // A turn a report started is not a reply to anyone.
    const ev = await turnFor("[work_event] #1 (item_id: kwi_x) progress: ok");
    assert.equal(await w.mod.routerTurnEnd.routerTurnTiming({ sessionId: alice.routerSid, runIds: [ev.task_id], failed: false, interrupted: false }), null);
  });
});

describe("router quality, pure", () => {
  // Imported here, not at the top: the modules read the configuration when first loaded, and the world below sets it first.
  test("Q5c why a silent turn ended: stopped by the user, declined by the model, or failed", async () => {
    const { lostWhy, turnLostNotice } = await import("../src/assistant/router-turn-end.js");
    const end = { failed: false, interrupted: true, fromSweeper: false, finalText: "" };
    assert.equal(lostWhy(end), "stopped");
    assert.equal(lostWhy({ ...end, fromSweeper: true }), "failed");
    assert.equal(lostWhy({ ...end, interrupted: false, failed: true }), "failed");
    assert.equal(lostWhy({ ...end, interrupted: false, failed: true, finalText: "The model ended its turn without any text or tool call" }), "declined");
    assert.equal(turnLostNotice(["帮我调研一下"], "stopped"), "已停止。");
    assert.equal(turnLostNotice(["look into it"], "stopped"), "Stopped.");
    assert.equal(turnLostNotice(["[work_event] a report"], "stopped"), null); // (a report's turn answers nobody)
    // The gateway refused the user's key (and the turn was not run again on the fallback): what to fix, not "say it again".
    const invalid = "401 {\"error\":{\"message\":\"{ \\\"statusCode\\\": 401, \\\"message\\\": \\\"Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription.\\\" }\"}}";
    assert.equal(lostWhy({ ...end, interrupted: false, failed: true, finalText: invalid }), "key_invalid");
    assert.equal(lostWhy({ ...end, interrupted: false, failed: true, finalText: "403 {\"error\":\"No APIM Key binding found. Please upload your APIM Key\"}" }), "key_missing");
    assert.equal(lostWhy({ ...end, interrupted: false, failed: true, finalText: `The gateway said: ${invalid}` }), "failed");
    assert.equal(lostWhy({ ...end, interrupted: true, fromSweeper: true, finalText: invalid }), "failed");
    const zh = turnLostNotice(["为什么没有回答我？"], "key_invalid")!;
    assert.match(zh, /^你绑定的 APIM Key 无效或已过期/);
    assert.doesNotMatch(zh, /请再说一次/);
    assert.match(turnLostNotice(["why no answer?"], "key_invalid")!, /^The APIM key bound to your key is invalid or expired/);
    assert.match(turnLostNotice(["帮我看看"], "key_missing")!, /^你的 key 还没有绑定 APIM Key/);
    assert.equal(turnLostNotice(["[work_event] a report"], "key_invalid"), null);
  });

  test("Q1 an item number without its title is found; one that names the item, or is not an item's, is not", async () => {
    const { bareItemNumbers } = await import("../src/assistant/internal-text.js");
    const bare = (text: string, except?: number) => bareItemNumbers(text, ITEMS, except).map((i) => i.seq);
    assert.deepEqual(bare("#6、#8 都还在进行"), [6, 8]);
    assert.deepEqual(bare("还有 #9。"), [9]);
    assert.deepEqual(bare("#6 is done and #8 is waiting"), [6, 8]);
    assert.deepEqual(bare("#6 修复登录超时 已完成，#8 Fix CI on main 在等你"), []);
    assert.deepEqual(bare("「修复登录超时」(#6) 完成了"), [], "the title right before the number");
    assert.deepEqual(bare("#8 fix ci on main is ready"), [], "in any case");
    assert.deepEqual(bare("#6 修复登录… 还在跑"), [], "the start of the title is enough");
    // Numbers that are not the user's items.
    assert.deepEqual(bare("PR #6 合了，PR #6、#8 都绿"), []);
    assert.deepEqual(bare("AMD-AGI/PrimusClaw#8 and issue #9"), []);
    assert.deepEqual(bare("run #6 failed; topic #8 is open; pull request #9"), []);
    assert.deepEqual(bare("#12 and #6a"), [], "not an item, and not a number on its own");
    // A word of the title nearby is not the title.
    assert.deepEqual(bareItemNumbers("#6 is done, please update me if needed.", [{ seq: 6, title: "Update dependencies" }]).map((i) => i.seq), [6]);
    assert.deepEqual(bare("**#8** – Fix CI on main: green"), [], "markdown and a dash between");
    // The item a message is sent with is shown with its number and title.
    assert.deepEqual(bare("Taken on as #6.", 6), []);
    assert.deepEqual(bare("Taken on as #6, and #8 is next.", 6), [8]);
  });

  test("Q2c an answer due in English the user chose is refused only when it is Chinese with no English word of its own", async () => {
    const { replyLanguageMismatch } = await import("../src/assistant/language.js");
    assert.equal(replyLanguageMismatch("构建没问题。", "English", [], null, true), "Chinese");
    assert.equal(replyLanguageMismatch("构建在 CI 上挂了，PR #12 需要 rebase。", "English", [], null, true), "Chinese");
    assert.equal(replyLanguageMismatch("构建没问题。", "English", [], null, false), null, "no choice: never refused, as before");
    assert.equal(replyLanguageMismatch("构建没问题。", "English", [], "Chinese", true), null, "Chinese asked for by name");
    assert.equal(replyLanguageMismatch("The PR 修复登录超时 is merged.", "English", [], null, true), null, "English that names a Chinese title");
    assert.equal(replyLanguageMismatch("#6 修复登录超时", "English", ["修复登录超时"], null, true), null, "an item title alone");
    assert.equal(replyLanguageMismatch("Done: “构建没问题”", "English", [], null, true), null, "a quotation");
    assert.equal(replyLanguageMismatch("ビルドは問題ありません。", "English", [], null, true), null, "not Chinese");
    assert.equal(replyLanguageMismatch("All good.", "English", [], null, true), null);
  });

  test("Q2b the language a message asks a text in is read from the user's own words, and only that one is let through", async () => {
    const { replyLanguageMismatch, requestedTextLanguage } = await import("../src/assistant/language.js");
    for (const [message, asked] of [
      ["把这句翻成英文，只给译文：今天下午三点前把评审意见回完，来不及的话先说一声。", "English"],
      ["翻译成英语：明天开会", "English"], ["帮我译为日文", "Japanese"], ["用英文写一段介绍", "English"], ["给我一个英文版", "English"],
      ["写成韩文", "Korean"], ["Translate this paragraph into Chinese please", "Chinese"], ["Summarize the thread in English", "English"],
      ["帮我看看评审意见", null], ["这个 PR 合了吗", null], ["Please fix the build", null],
      // What the message quotes is not what it asks: "翻成英文" inside quotes is a phrase it asks about.
      ["“翻成英文”这几个字是什么意思？", null],
    ] as const) assert.equal(requestedTextLanguage(message), asked, message);
    const english = "Please finish replying to the review comments before 3 PM today.";
    assert.equal(replyLanguageMismatch(english, "Chinese"), "English");
    assert.equal(replyLanguageMismatch(english, "Chinese", [], "English"), null, "the translation asked for");
    assert.equal(replyLanguageMismatch(english, "Chinese", [], "Japanese"), "English", "another language than the one asked for");
  });

  test("Q2 another language is found only when the message is plainly in it", async () => {
    const { replyLanguageMismatch } = await import("../src/assistant/language.js");
    assert.equal(replyLanguageMismatch("All three are done; nothing waits for you.", "Chinese"), "English");
    assert.equal(replyLanguageMismatch("三个都完成了，PR 在 https://github.com/o/r/pull/12，CI is green。", "Chinese"), null);
    assert.equal(replyLanguageMismatch("全部完成。", "Chinese"), null);
    assert.equal(replyLanguageMismatch("ok", "Chinese"), null, "no words, no verdict");
    // A Chinese answer that quotes a long English pull request title is Chinese.
    assert.equal(replyLanguageMismatch("PR #327 feat(api): the assistant router answers sooner, in the user's language, and names items 已合入。", "Chinese"), null);
    // A Chinese item title does not make an English answer Chinese.
    assert.equal(replyLanguageMismatch("#6 修复登录超时 is done, and the PR is merged.", "Chinese", ["修复登录超时"]), "English");
    // Never refused the other way: an English answer may quote a Chinese title of anything, a Japanese one may be all kanji.
    for (const [text, lang] of [
      ["这个 PR 已经合入了。", "English"], ["Review passed: 修复登录超时.", "English"], ["Review for PR #327 (修复登录超时) passed.", "English"],
      ["了解。", "Japanese"], ["All done.", "Korean"],
    ] as const) assert.equal(replyLanguageMismatch(text, lang), null, `${lang}: ${text}`);
  });
});

describe("router quality, the prompt", () => {
  test("Q7 router-v10 and router-read-v7 say each rule", async () => {
    const p = await import("../src/assistant/prompts.js");
    // router-v16 (this rule set, a long answer said whole, a say after the start notice added to it, one message a turn, progress read
    // live, a follow-up with the earlier files, progress from what the job wrote now with its age, a derived number from the unrounded
    // values; router-v17: a translation said alone, in the language asked for; router-v22: the line names the language the user chose; router-v18: the tool for a worker's report, a request to
    // remember and a channel setting named outright; router-v19: the quick line before deliver_text, trigger_create, review_mode_set and
    // devenv_; router-v20: a question asked again compared from this turn's lookups alone); its review prompt is router-v26 (v25: a pull
    // request pr_state says is not_found said not to exist; v26: v25 on router-v20); router-read-v9 adds
    // "how many" answered with the list, and a pull request that does not exist said so; router-read-v10 adds current facts read
    // now from the source that states them.
    assert.equal(p.ROUTER_PROMPT_VERSION, "router-v22");
    assert.equal(p.ROUTER_READ_PROMPT_VERSION, "router-read-v16");
    assert.equal(p.ROUTER_REVIEW_PROMPT_VERSION, "router-v28");
    const system = p.renderRouterPrompt({ servers: ["agent-board"], github: ["issue_search", "repo_get_file", "pr_list"] });
    const rules: Array<[string, RegExp]> = [
      ["the system confirms work_create", /the system tells the user at once that it has, with its number and title \(the result says announced: true\): a say after it in the turn is added to that same message, so never repeat the start/],
      ["a quick first line", /put one short line that you are on it \(查一下 \/ Checking now\) in the first step, as a say beside the lookups/],
      ["lookups of a step at once", /Make every lookup a step needs in that one step, side by side/],
      ["the quick line before the slow assistant tools", /Before deliver_text, trigger_create, review_mode_set or a devenv_ tool, say that line first, in the same step/],
      ["GitHub only by its tools", /read with these mcp__github__ tools only: never with web_fetch of api\.github\.com or a github\.com page they read, and never with another server's tools \(the agent board is not GitHub\)/],
      ["research again in other words", /search again with other words \(other names, the other language, the one distinctive detail alone\), two or three times/],
      ["answer with the best candidate", /answer with the best candidate you found and say which detail you could not confirm/],
      // Parity R1/R2 (2026-11-07): the patch version from a releases page that lagged stable.txt, a distribution list from a page
      // about an older ROCm.
      ["a current fact is read now, never remembered", /A current fact \(the latest or stable version of something, when it was released, which hardware, operating systems or versions it supports\): read it now from the source that states it, never from what you remember/],
      ["the latest version from the release record", /The latest version comes from the project's own release record \(for Kubernetes https:\/\/dl\.k8s\.io\/release\/stable\.txt; for a project released on GitHub its latest release[^\n]*https:\/\/github\.com\/<owner>\/<repo>\/releases\/latest[^\n]*not from a page that lists releases, which can lag behind it/],
      ["support from that version's own matrix", /What a version supports comes from that version's own compatibility matrix or system requirements page: when a page says it describes an older version, read the one for the version you are answering about, and if you cannot, say which version your answer comes from/],
      // Parity K2 (2026-11-07): "why are these 3 nodes unhealthy" answered from allocation phases (all Ready) and a guess at the page,
      // without reading any node's health.
      ["health is read from the health fields", /Why something is unhealthy, failing or marked bad \(nodes on a page or dashboard\): read the health itself, for each one, not only a phase or state \(Ready is not healthy\)/],
      ["Autopilot node health is node_status", /For Autopilot nodes that is get_metrics with chart node_status \(each node's bad reasons and the age of its last health reading, vk_not_ready\), get_metrics with chart node_health and a range for when it changed, and get_events of each node/],
      ["a premise that does not hold is said first", /When they show nothing unhealthy now, say in the first line that the premise does not hold now, with what you read/],
      // Parity R2 (2026-11-07 on v13): Rocky Linux 9 and Oracle Linux 8 listed for MI355X from an Instinct-wide list.
      ["support for one named product from its matrix", /When the question names one product \(a GPU model such as MI355X\), read that version's compatibility matrix itself, not only its release notes, and give only what it states for that product/],
      // N8 (2026-11-07): 研发进度 answered "17 merged, only 3 open" from 20 of the merged pull requests (complete: false) with a
      // release-gate fixture among the open ones.
      ["a part is never answered as all", /A lookup that is not all of what the question asks about \(complete is false, total_count is null, partial is set, in_result is more than shown, or the state lists the latest N of a larger total\) is never answered as if it were all/],
      ["read the rest or a window first", /the next page while the result gives a next_page, or one read that covers the question's window \(pr_list with since/],
      ["the scope in the first line", /When you still answer from a part, the first line says its scope, in the user's language \(最近 20 条里/],
      ["totals only from a whole count", /a total, "all", "only N left" or a share \(19 of 20\) is said only from a count the result gives for the whole/],
      ["a fixture is nobody's work", /A release-gate fixture pull request \(left out by default: fixtures_excluded\) is never counted as anyone's work/],
      ["progress is read live", /When the user asks how far an item got, what it is doing now, or when it will finish, look now: call work_recall\(item, "live"\)/],
      ["progress is never estimated", /Never work out how far it got or when it ends from when it started or how long it was expected to take/],
      ["progress from what the job wrote now", /files_now, when it is there, is newer than the worker's steps[^\n]*answer from its latest line/],
      ["the age of what progress is read from", /with that line's time and how long before now \(as_of\) it was/],
      ["a derived number from the unrounded values", /A difference, ratio or percentage between results \(少了多少、百分之几、how much more\) is computed from the unrounded values, never from the rounded figures a report shows[^\n]*never subtract the rounded figures yourself/],
      ["a follow-up goes to the item that did it", /A follow-up on earlier work \(再算一次, 去掉某一类再算, 换个口径, do it for main too\) is for the item that did it: work_send it there while that item is open/],
      ["a new item for a follow-up has the earlier files", /the files the user sent earlier go with it \(Files the user sent earlier\), so never ask for them again/],
      ["start what a worker can find out", /So start the item, and do not ask the user for what the work can find out \(which repository, which file, which test\)/],
      ["a request that fits an open item is sent to it", /A request that fits an open item \(the same task, the same system or file\) is for that item: work_send it there, never ask/],
      ["ask only when a guess would act on the wrong thing", /Ask first, in one short say, and start nothing, only when the request would act on something the user did not name and a guess would act on the wrong one for real/],
      ["writes and sandbox work are items", /Every write is a work item[\s\S]*So is anything that needs a shell, a sandbox, a checkout or many steps\. Call work_create for it/],
      ["a failed lookup is not an item", /a question is not turned into a work item because a lookup failed/],
      ["the system's failures are not the answer", /never give them a sandbox error, a status code or another item's failure as an answer or as a reason/],
      ["earlier failures do not stop new work", /How earlier items went is never a reason not to start one/],
      ["work_recall for how far an item got", /call work_recall\(item, "live"\) for each item asked about, all in one step/],
      ["memory and channel tools", /the memory tools of the Memory section[\s\S]*channel_action, whether the user typed its command or said it in words/],
      ["a declined request in a line", /A request you will not carry out[^\n]*say so in one short line/],
      ["every say in the reply language", /Write every say in it, the last one too \(say refuses a reply due in Chinese that has no Chinese in it, and a reply all in Chinese to a user who chose English\)/],
      // router-v22: the line names the language the user chose, whatever their message is in, and an answer asked for in a named language is in it.
      ["the line names the chosen language", /Reply in the language a line like \[Reply language: X\] after the user's message names[^\n]*even when the message itself is written in another one: X is the language the user chose to be answered in, or else the one their message is in\. Without that line, reply in the language of the user's latest message\./],
      ["a translation said alone, in its language", /a text \(把这句翻成英文, translate it into English\) is said alone, in that language, with nothing before or after it \(no 译文：, no quotes, no note\)/],
      ["an answer asked for in a named language", /an answer they asked to have in a language \(用英文回复, answer in English, write an English reply\) is written in that language; say refuses neither\./],
      ["how many is answered with the list", /"How many pull requests \(issues\) do I have open" is answered with the total \(total_count\) and then the list itself, never the number alone[^\n]*refs_by_repo/],
      ["a pull request that does not exist is said so", /When a GitHub read answers no_such_pull_request, the pull request does not exist[^\n]*Never say it might be private or a permission problem/],
      // N13 (2026-11-08 03:12Z on router-v19): brief no longer listed the release-gate fixture #381, and the answer still said
      // "上次提到的 PrimusClaw#381 的 2 条评论这次没有再出现新动态", carried over from an earlier, wrong answer of the conversation.
      ["a question asked again is compared from this turn's lookups", /This turn's lookups are the answer, and the comparison is made from them alone/],
      ["what this turn does not support is not said again", /Something your earlier answer named that this turn's lookups do not return or support \(a pull request, an item, a comment, a reason\) is not said again, not even to say it has no news or is gone \(上次提到的 #381 这次没有新动态, #381 还是那 2 条评论\): leave it out, unless the user asks about it, and then look it up first/],
      ["a reason for a changed count only from this turn", /When a count changed, give a reason for the difference only when this turn's lookups show one/],
      // The devenv section forbids 上次 and still for machines: asked again, they are not compared at all.
      ["machines are never compared", /Machines and the sessions on them are not compared at all: say them from this turn's read alone, never with 上次 or still\./],
      ["no number without its title", /never by its number alone: say refuses "#6、#8" without the titles/],
      // router-v18 (2026-11-06 nightly: cat-items-ro-003 answered from the list, cat-settings-wr-002 made a scheduled task).
      ["a worker's report is read with work_recall", /What a worker reported, found or answered on an item[^\n]*work_recall\(item, "reports"\) for that item[^\n]*never from its line in the list alone/],
      ["memory is never a setting tool", /the memory tools of the Memory section[^\n]*never a setting tool in their place/],
      ["a brief or a pause is never a scheduled task", /A daily brief or a pause of notifications is never a scheduled task \(trigger_create\) and never a work item/],
    ];
    for (const [what, re] of rules) assert.match(system, re, what);
    // Nothing in the read section tells the router to announce a start the system has already announced.
    assert.ok(!/say in one line that it has started/.test(system), "no second start line");
    assert.ok(!/call work_create in the same turn with the question/.test(system), "a failed lookup no longer starts an item");
    // The system prompt carries nothing that changes per turn, so it stays a prompt-cache prefix.
    assert.equal(p.renderRouterPrompt({ servers: ["agent-board"], github: ["issue_search"] }), p.renderRouterPrompt({ servers: ["agent-board"], github: ["issue_search"] }));
  });

  test("Q7m router-memory-v2: a request to remember is saved even when a setting fits, and a correction or undo is done with its tool", async () => {
    const p = await import("../src/assistant/prompts.js");
    assert.equal(p.ROUTER_MEMORY_PROMPT_VERSION, "router-memory-v3");
    // 2026-11-06 nightly: cat-memory-wr-001 and wr-003 called model_default_set for 记住：我审 PR 默认用 opus; wr-005 only said the undo.
    assert.match(p.ROUTER_MEMORY_PROMPT, /记住 \/ remember \/ 以后都… is memory_save, even when a setting also fits it \(记住：我审 PR 默认用 opus is an entry, not model_default_set or review_mode_set\)/);
    assert.match(p.ROUTER_MEMORY_PROMPT, /A correction right after a save \(不对，改成 sonnet\) is memory_update of the entry just saved, and 撤销刚才那条 or undo that is memory_undo of it: call the tool, never only say it\./);
  });

  test("Q8 what the router can do comes from the tool catalog, and no system failure is a limit", async () => {
    const p = await import("../src/assistant/prompts.js");
    const { toolsOfClass } = await import("../src/assistant/tool-classes.js");
    const system = p.renderRouterPrompt({ servers: ["agent-board", "safe"], github: ["issue_search"] });
    const writes = [...toolsOfClass("agent-board", "write"), ...toolsOfClass("safe", "write")];
    assert.ok(writes.length > 2, "the catalog lists writes for these servers");
    const abilities = system.slice(system.indexOf("What you can do"));
    for (const tool of writes) assert.ok(abilities.includes(tool), `the write ${tool} is named`);
    // A read is not offered as a change.
    const changes = abilities.split("\n").find((l) => l.startsWith("- Change things")) ?? "";
    for (const read of toolsOfClass("agent-board", "read")) assert.ok(!new RegExp(`\\b${read}\\b`).test(changes), `the read ${read} is not a change`);
    assert.match(abilities, /Never call yourself read-only, and never say you cannot write, change or send something listed here/);
    assert.match(abilities, /Never label any part of the answer read-only either \(no 只读 or read-only as a heading/);
    assert.match(abilities, /Its worker asks the user on a card before each write runs, so say yes: you can, and it will ask them to approve the change first/);
    assert.match(abilities, /GitHub \(comment, review/);
    assert.match(abilities, /not a sandbox that would not start, a permission error, a status code \(such as 403\)/);
    // Without GitHub, no GitHub writes are offered; without servers, still the item route for code and runs.
    const bare = p.renderRouterPrompt({ servers: [], github: [] });
    const bareAbilities = bare.slice(bare.indexOf("What you can do"));
    assert.ok(!bareAbilities.includes("GitHub (comment"), "no GitHub writes without GitHub");
    assert.match(bareAbilities, /anything that needs code, a shell, a checkout, a run or many steps/);
  });
});
