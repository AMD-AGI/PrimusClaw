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
 *   Q6 each router turn that answers the user logs how soon it was first heard, last heard, and whether it started an item
 *   Q7 the router's prompt says each of the rules of router-v10 and router-read-v7
 *   Q8 what the router can do is told from the tool catalog: each write of its servers, done by an item that asks first, never "read-only"
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
    // router-v12 (this rule set, a long answer said whole, nothing after the start notice); its review prompt is router-v15.
    assert.equal(p.ROUTER_PROMPT_VERSION, "router-v13");
    assert.equal(p.ROUTER_READ_PROMPT_VERSION, "router-read-v7");
    assert.equal(p.ROUTER_REVIEW_PROMPT_VERSION, "router-v16");
    const system = p.renderRouterPrompt({ servers: ["agent-board"], github: ["issue_search", "repo_get_file", "pr_list"] });
    const rules: Array<[string, RegExp]> = [
      ["the system confirms work_create", /the system tells the user at once that it has, with its number and title \(the result says announced: true\): a say after it in the turn is added to that same message, so never repeat the start/],
      ["a quick first line", /put one short line that you are on it \(查一下 \/ Checking now\) in the first step, as a say beside the lookups/],
      ["lookups of a step at once", /Make every lookup a step needs in that one step, side by side/],
      ["GitHub only by its tools", /read with these mcp__github__ tools only: never with web_fetch of api\.github\.com or a github\.com page they read, and never with another server's tools \(the agent board is not GitHub\)/],
      ["research again in other words", /search again with other words \(other names, the other language, the one distinctive detail alone\), two or three times/],
      ["answer with the best candidate", /answer with the best candidate you found and say which detail you could not confirm/],
      ["start what a worker can find out", /So start the item, and do not ask the user for what the work can find out \(which repository, which file, which test\)/],
      ["a request that fits an open item is sent to it", /A request that fits an open item \(the same task, the same system or file\) is for that item: work_send it there, never ask/],
      ["ask only when a guess would act on the wrong thing", /Ask first, in one short say, and start nothing, only when the request would act on something the user did not name and a guess would act on the wrong one for real/],
      ["writes and sandbox work are items", /Every write is a work item[\s\S]*So is anything that needs a shell, a sandbox, a checkout or many steps\. Call work_create for it/],
      ["a failed lookup is not an item", /a question is not turned into a work item because a lookup failed/],
      ["the system's failures are not the answer", /never give them a sandbox error, a status code or another item's failure as an answer or as a reason/],
      ["earlier failures do not stop new work", /How earlier items went is never a reason not to start one/],
      ["work_recall for how far an item got", /call work_recall\(item, "reports"\) for each item asked about, all in one step/],
      ["memory and channel tools", /the memory tools of the Memory section[\s\S]*channel_action, whether the user typed its command or said it in words/],
      ["a declined request in a line", /A request you will not carry out[^\n]*say so in one short line/],
      ["every say in the reply language", /write every say in it, the last one too \(say refuses a reply to a Chinese message that has no Chinese in it\)/],
      ["no number without its title", /never by its number alone: say refuses "#6、#8" without the titles/],
    ];
    for (const [what, re] of rules) assert.match(system, re, what);
    // Nothing in the read section tells the router to announce a start the system has already announced.
    assert.ok(!/say in one line that it has started/.test(system), "no second start line");
    assert.ok(!/call work_create in the same turn with the question/.test(system), "a failed lookup no longer starts an item");
    // The system prompt carries nothing that changes per turn, so it stays a prompt-cache prefix.
    assert.equal(p.renderRouterPrompt({ servers: ["agent-board"], github: ["issue_search"] }), p.renderRouterPrompt({ servers: ["agent-board"], github: ["issue_search"] }));
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
