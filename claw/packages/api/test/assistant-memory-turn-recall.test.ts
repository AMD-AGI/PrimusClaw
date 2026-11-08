// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The router turn's recall (`CLAW_MEMORY_TURN_RECALL`, E242): before the model answers, the server recalls the user's memory for
 * their message and gives the turn the entries it is about, in full. Against a real Postgres with the production schema, with the
 * canary list naming alice (`CLAW_MEMORY_TURN_RECALL_USERS`); skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   K1  an index full of preferences lists none of the project's entries; a message naming the project carries them in full
 *   K2  off (a user not on the list, or the list emptied): the turn is the same text as without the feature, the system prompt too
 *   K3  only the user's own active entries, and none where the index is not shown (memory off, a session marked `memory: "off"`)
 *   K4  a recall is not counted as a read
 *   K5  a store above the entry limit (lowered since) is read only to the limit, newest first
 *   K6  an entry's body is shown whole, up to what a write may store
 *   R*  the ranking itself (`rankByMessage`), pure
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { rankByMessage, recallTerms } from "../src/memory/gates.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("router turn recall", { skip }, () => {
  let w: World;
  let mt: typeof import("../src/assistant/memory-tools.js");
  let svc: typeof import("../src/memory/service.js");
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld({
      CLAW_MEMORY_ENABLED: "true", CLAW_ASSISTANT_MEMORY_TOOLS: "on", CLAW_MEMORY_CATALOGUE_MAX_LINES: "4", CLAW_MEMORY_MAX_ENTRIES: "12",
      CLAW_MEMORY_TURN_RECALL_USERS: "alice",
    });
    mt = await import("../src/assistant/memory-tools.js");
    svc = await import("../src/memory/service.js");
    svc.memoryPorts.publishSessionEvent = async () => undefined;
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_subscriptions, claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistant_messages, claw_assistants, claw_sessions, claw_notification_outbox, claw_memory_links, claw_memory_entries, claw_memory_events, claw_user_memory_prefs, claw_assistant_scopes CASCADE");
    mt.turnRecallSettings.all = false;
    mt.turnRecallSettings.users = new Set(["alice"]);
    alice = await w.user("alice");
    bob = await w.user("bob");
    await svc.setMemoryPreference("alice", true);
    await svc.setMemoryPreference("bob", true);
  });

  async function stored(userId: string, type: string, title: string, body: string): Promise<number> {
    const r = await svc.writeMemory(userId, { type, title, body }, { kind: "model", sessionId: "chat", quote: body, humanMessages: [body] });
    assert.ok(r.ok, JSON.stringify(r));
    return r.id;
  }

  /** The person's signed-in message, and the task of the router turn that answers it, as Brain is handed it. */
  async function turnFor(u: { userId: string; routerSid: string }, content: string): Promise<{ turn: Claims; task: Record<string, unknown> }> {
    const turn = await w.routerTurn(u);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, $3, NULL, $4, '{"kind":"person"}'::jsonb, '{}'::jsonb, NOW())`,
      [turn.sid, turn.mid, u.userId, content],
    );
    const task: Record<string, unknown> = { task_id: turn.task_id, message_id: turn.mid, prompt: content };
    await w.mod.role.applySessionRoleToTask(task, u.routerSid);
    return { turn, task };
  }

  /** Six preferences, which fill the four-line index, and the project's two entries, which it then does not list. */
  async function seeded(): Promise<{ release: number; owner: number }> {
    const owner = await stored("alice", "project", "Kestrel 值班负责人是 Heron", "Kestrel 的值班负责人是代号 Heron 的同事。");
    const release = await stored("alice", "project", "Kestrel 发布窗口", "Kestrel 只在每月第二个周四发布，前一周周五起冻结。");
    for (const [title, body] of [
      ["偏好短句", "回答时用简短的句子。"], ["YAML 缩进用两个空格", "写 YAML 时缩进使用两个空格。"],
      ["画图用 Mermaid", "画架构图时优先使用 Mermaid 语法。"], ["数字用万做单位", "数字超过一万时用万作单位。"],
      ["不要复述问题", "回答时不要复述用户的问题。"], ["周一上午做计划", "用户每周一上午做计划。"],
    ]) await stored("alice", "user", title, body);
    return { release, owner };
  }

  test("K1 a message naming a project the full index does not list carries the project's entries in full", async () => {
    const { release, owner } = await seeded();
    const { task } = await turnFor(alice, "Kestrel 一般在哪天发布？");
    const prompt = String(task.prompt);
    const index = prompt.slice(prompt.indexOf("<memory-index"), prompt.indexOf("</memory-index>"));
    assert.ok(index && !index.includes("Kestrel"), `the index lists the project, so this proves nothing: ${index}`);
    assert.ok(prompt.includes("<memory-recall"), prompt);
    assert.ok(prompt.includes(`#${release} Kestrel 发布窗口: Kestrel 只在每月第二个周四发布`), prompt);
    assert.ok(prompt.includes(`#${owner} Kestrel 值班负责人是 Heron`), prompt);
    // Beside the index, with the message: the system prompt is not where it goes.
    assert.ok(!String(task.system_append).includes("第二个周四"), String(task.system_append));
    // A message about nothing the user keeps recalls nothing.
    const { task: hello } = await turnFor(alice, "你好");
    assert.ok(!String(hello.prompt).includes("<memory-recall"), String(hello.prompt));
  });

  test("K2 off, the turn is what it was without the feature", async () => {
    await seeded();
    const on = (await turnFor(alice, "Kestrel 一般在哪天发布？")).task;
    const block = /\n\n<memory-recall[\s\S]*?<\/memory-recall>/.exec(String(on.prompt));
    assert.ok(block, String(on.prompt));
    mt.turnRecallSettings.users = new Set();
    const off = (await turnFor(alice, "Kestrel 一般在哪天发布？")).task;
    assert.equal(String(off.prompt), String(on.prompt).replace(block[0], ""));
    assert.equal(String(off.system_append), String(on.system_append));
    // A user the list does not name, with the same entries, gets no recall either.
    mt.turnRecallSettings.users = new Set(["alice"]);
    await stored("bob", "project", "Kestrel 发布窗口", "Kestrel 只在每月第二个周四发布。");
    assert.ok(!String((await turnFor(bob, "Kestrel 一般在哪天发布？")).task.prompt).includes("<memory-recall"));
    // `on` is everyone.
    mt.turnRecallSettings.all = true;
    assert.ok(String((await turnFor(bob, "Kestrel 一般在哪天发布？")).task.prompt).includes("<memory-recall"));
  });

  test("K3 only the user's own active entries, and only where the index is shown", async () => {
    mt.turnRecallSettings.all = true;
    const mine = await stored("alice", "project", "Kestrel 发布窗口", "Kestrel 只在每月第二个周四发布。");
    const theirs = await stored("bob", "project", "Kestrel 发布窗口（bob）", "Kestrel 每周五发布，不冻结。");
    const pending = await stored("alice", "reference", "回滚找 Osprey", "Kestrel 发布出问题要回滚时，去 Teams 频道 rollback 找 Osprey。");
    const due = await stored("alice", "reference", "旧日历", "Kestrel 去年的上线日历放在 wiki 的 calendar-2025 页面，第一个周二发布。");
    await w.q("UPDATE claw_memory_entries SET status = 'pending' WHERE id = $1", [pending]);
    await w.q("UPDATE claw_memory_entries SET expires_at = NOW() - interval '1 day' WHERE id = $1", [due]);
    const prompt = String((await turnFor(alice, "Kestrel 一般在哪天发布？")).task.prompt);
    const recalled = /<memory-recall[\s\S]*?<\/memory-recall>/.exec(prompt)?.[0] ?? "";
    assert.ok(recalled.includes(`#${mine} Kestrel 发布窗口: Kestrel 只在每月第二个周四发布`), prompt);
    for (const id of [theirs, pending, due]) assert.ok(!recalled.includes(`#${id} `), `#${id} recalled: ${recalled}`);
    assert.ok(!prompt.includes("每周五发布") && !prompt.includes("Osprey") && !prompt.includes("第一个周二"), prompt);

    await svc.setMemoryPreference("alice", false);
    assert.ok(!String((await turnFor(alice, "Kestrel 一般在哪天发布？")).task.prompt).includes("Kestrel 只在"));
    await svc.setMemoryPreference("alice", true);
    await w.q(`UPDATE claw_sessions SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{memory}', '"off"') WHERE session_id = $1`, [alice.routerSid]);
    assert.ok(!String((await turnFor(alice, "Kestrel 一般在哪天发布？")).task.prompt).includes("Kestrel 只在"));
  });

  test("K4 a recall is not counted as a read", async () => {
    const { release } = await seeded();
    const read = async () => (await w.q("SELECT access_count, last_accessed FROM claw_memory_entries WHERE id = $1", [release]))[0];
    const before = await read();
    assert.ok(String((await turnFor(alice, "Kestrel 一般在哪天发布？")).task.prompt).includes(`#${release} `));
    assert.deepEqual(await read(), before);
  });

  test("K5 a store above the entry limit is read only to the limit, newest first", async () => {
    const old = await stored("alice", "project", "Kestrel 发布窗口", "Kestrel 只在每月第二个周四发布。");
    for (let i = 0; i < 12; i += 1) {
      await w.q(
        `INSERT INTO claw_memory_entries (user_id, category, content, mtype, title, status) VALUES ('alice', 'user', $1, 'user', $1, 'active')`,
        [`偏好第 ${i} 条：回答用短句 ${i}`],
      );
    }
    const prompt = String((await turnFor(alice, "Kestrel 一般在哪天发布？")).task.prompt);
    assert.ok(!prompt.includes(`#${old} Kestrel 发布窗口:`), prompt);
  });

  test("K6 an entry's body is shown whole, up to what a write may store", async () => {
    const body = `Kestrel 发布规则：${"每月第二个周四发布冻结期从前一周周五开始".repeat(23)}到此为止`;
    assert.ok([...body].length > 400 && [...body].length <= 500, String([...body].length));
    const id = await stored("alice", "project", "Kestrel 发布规则", body);
    const prompt = String((await turnFor(alice, "Kestrel 一般在哪天发布？")).task.prompt);
    assert.ok(prompt.includes(`#${id} Kestrel 发布规则: ${body}`), prompt);
  });
});

describe("rankByMessage", () => {
  const texts = [
    "用户负责的项目代号叫 Kestrel", "Kestrel 只在每月第二个周四发布", "回答时不要复述用户的问题", "报告结尾不要写客套话，如有问题随时联系",
    "写 YAML 时缩进使用两个空格", "提交 GPU 任务默认用集群 lyra", "画架构图时优先使用 Mermaid", "用户每周一上午做计划",
  ];
  const rank = (m: string) => rankByMessage(m, texts, (t) => t, { limit: 3, minScore: 0.25 }).map((x) => x.item);

  test("R1 a name the message and an entry share outweighs common wording", () => {
    const got = rank("Kestrel 出了问题我该找谁？");
    assert.ok(got.slice(0, 2).every((t) => t.includes("Kestrel")), JSON.stringify(got));
  });
  test("R2 a message that shares nothing an entry holds recalls nothing", () => {
    assert.deepEqual(rank("你好"), []);
    assert.deepEqual(rank("今天天气怎么样？"), []);
  });
  test("R3 an English message matches a word inside Chinese text, and words are not glued across spaces", () => {
    assert.ok(rank("Which cluster does my GPU job use by default?")[0]?.includes("lyra"));
    assert.ok(recallTerms("Kestrel 发布").has("kestrel") && recallTerms("Kestrel 发布").has("发布"));
    assert.ok(!recallTerms("go home").has("gohome") && !recallTerms("go home").has("oh"));
  });
  test("R4 at most limit, best first", () => {
    const got = rankByMessage("Kestrel 发布", texts, (t) => t, { limit: 1, minScore: 0 });
    assert.equal(got.length, 1);
    assert.ok(got[0].item.includes("发布"));
  });
});
