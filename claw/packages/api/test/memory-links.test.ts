// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a memory entry cites (`memory/links.ts`, `claw_memory_links`, E242), against a real Postgres with the production schema;
 * skipped without DATABASE_URL, and a skip is not a pass. The pure half (C*) runs everywhere.
 *
 *   L1  a name no entry answers yet is kept dangling, and joined to the entry saved later that it names
 *   L2  a number cites that entry of the same user; `repo#12` and a number no entry has cite nothing
 *   L3  a name two entries answer equally is left dangling: a wrong join is worse than none
 *   L4  a changed body cites what it says now; undo puts back what the old words cite
 *   L5  a deleted entry takes every citation of it along: a name goes back to dangling, a number goes; forgetting all leaves none
 *   L6  nothing reaches another user: their entry neither answers a dangling name nor is cited by number
 *   L7  an entry made in place of a close one (force_new) is derived from it
 *   L8  the router's turn recall shows what a recalled entry cites, as it stands now
 *   L9  a cited entry renamed away takes the citation with it: the name is dangling again, and the recall shows no citation
 *   L10 a later entry that ties with the cited one leaves the name unjoined
 *   L11 an entry waiting for its owner's confirmation does not capture a name; confirmed, it is joined
 *   L12 an update waits for the user's write lock before it locks a row: a forget-all holding the lock deletes the row, and neither
 *       deadlocks
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { citationsIn, resolveCitation } from "../src/memory/links.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("memory citations", { skip }, () => {
  let w: World;
  let mt: typeof import("../src/assistant/memory-tools.js");
  let svc: typeof import("../src/memory/service.js");

  before(async () => {
    w = await startWorld({ CLAW_MEMORY_ENABLED: "true", CLAW_ASSISTANT_MEMORY_TOOLS: "on", CLAW_MEMORY_TURN_RECALL_USERS: "alice" });
    mt = await import("../src/assistant/memory-tools.js");
    svc = await import("../src/memory/service.js");
    svc.memoryPorts.publishSessionEvent = async () => undefined;
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_subscriptions, claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistant_messages, claw_assistants, claw_sessions, claw_notification_outbox, claw_memory_links, claw_memory_entries, claw_memory_events, claw_user_memory_prefs, claw_assistant_scopes CASCADE");
    await svc.setMemoryPreference("alice", true);
    await svc.setMemoryPreference("bob", true);
  });

  async function save(userId: string, title: string, body: string, o: { type?: string; force?: boolean; quote?: string } = {}): Promise<number> {
    const quote = o.quote ?? body;
    const r = await svc.writeMemory(userId, { type: o.type ?? "project", title, body, force_new: o.force }, { kind: "model", sessionId: "chat", quote, humanMessages: [quote] });
    assert.ok(r.ok && r.op === "add", JSON.stringify(r));
    return r.id;
  }
  const links = async (userId = "alice") =>
    (await w.q("SELECT from_id, rel, to_kind, to_id FROM claw_memory_links WHERE user_id = $1 ORDER BY from_id, rel, to_kind, to_id", [userId]))
      .map((r) => `${r.from_id} ${r.rel} ${r.to_kind}:${r.to_id}`);

  test("L1 a dangling name is joined to the entry saved later that it names", async () => {
    const dataset = await save("alice", "Kestrel 用的数据集是 Wren-v3", "Kestrel 用的数据集叫 Wren-v3。它的许可证限制记在「Wren 许可」那一条里（该条目尚未建立）。");
    assert.deepEqual(await links(), [`${dataset} cites title:Wren 许可`]);
    const licence = await save("alice", "Wren-v3 许可：仅限内部评测", "Wren 许可：Wren-v3 只能用于内部评测，不能用于训练对外发布的模型。");
    assert.deepEqual(await links(), [`${dataset} cites memory:${licence}`]);
  });

  test("L2 a number cites that entry of the same user; repo#12 and an unknown number cite nothing", async () => {
    const a = await save("alice", "Kestrel 发布窗口", "Kestrel 只在每月第二个周四发布。");
    const b = await save("alice", "Kestrel 冻结期", `冻结期见 #${a}，另见 PrimusClaw#${a} 和 #999999。`);
    assert.deepEqual(await links(), [`${b} cites memory:${a}`]);
  });

  test("L3 a name two entries answer equally stays dangling", async () => {
    await save("alice", "白天值班的 Osprey", "白天由 Osprey 值班，周一到周三。");
    await save("alice", "Osprey 节假日值班表", "节假日找 Osprey 值班，夜里电话联系。");
    const c = await save("alice", "Kestrel 交接", "交接时看「Osprey 值班」那一条。");
    assert.deepEqual(await links(), [`${c} cites title:Osprey 值班`]);
  });

  test("L4 a changed body cites what it says now; undo puts back the old citations", async () => {
    const a = await save("alice", "Kestrel 发布窗口", "Kestrel 只在每月第二个周四发布。");
    const b = await save("alice", "Heron 联系方式", "在 Teams 频道 kestrel-oncall 里找 Heron。");
    const c = await save("alice", "值班安排", `值班安排见 #${a}。`);
    const r = await svc.updateMemory("alice", c, { body: `联系方式见「Heron 联系方式」，不再看 #${a}…` }, { kind: "api", attended: true });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(await links(), [`${c} cites memory:${a}`, `${c} cites memory:${b}`].sort());
    await svc.updateMemory("alice", c, { body: "联系方式见「Heron 联系方式」。" }, { kind: "api", attended: true });
    assert.deepEqual(await links(), [`${c} cites memory:${b}`]);
    assert.equal(await svc.undoMemory("alice", c, "api"), "restored");
    assert.deepEqual(await links(), [`${c} cites memory:${a}`, `${c} cites memory:${b}`].sort());
  });

  test("L5 a deleted entry takes its citations along; forgetting all leaves none", async () => {
    const licence = await save("alice", "Wren-v3 许可：仅限内部评测", "Wren 许可：Wren-v3 只能用于内部评测。");
    const byName = await save("alice", "Kestrel 数据集", "数据集 Wren-v3，许可证见「Wren 许可」。");
    const byNumber = await save("alice", "内部评测依据", `评测只在内部做，依据 #${licence}。`);
    assert.deepEqual(await links(), [`${byName} cites memory:${licence}`, `${byNumber} cites memory:${licence}`]);
    assert.ok(await svc.forgetMemory("alice", licence, "api"));
    assert.deepEqual(await links(), [`${byName} cites title:Wren 许可`]);
    // Saved again, the name is joined again.
    const again = await save("alice", "Wren 许可（新）", "Wren 许可：Wren-v3 只能用于内部评测，2027 年起可外训。");
    assert.deepEqual(await links(), [`${byName} cites memory:${again}`]);
    await svc.forgetAllMemories("alice");
    assert.deepEqual(await links(), []);
  });

  test("L6 nothing reaches another user", async () => {
    const mine = await save("alice", "Kestrel 数据集", "数据集 Wren-v3，许可证见「Wren 许可」。");
    const theirs = await save("bob", "Wren-v3 许可", "Wren 许可：Wren-v3 只能用于内部评测。");
    const cites = await save("alice", "评测依据", `评测依据 #${theirs}。`);
    assert.deepEqual(await links("alice"), [`${mine} cites title:Wren 许可`]);
    assert.deepEqual(await links("bob"), []);
    assert.ok(cites);
  });

  test("L7 an entry made in place of a close one is derived from it", async () => {
    const old = await save("alice", "默认集群 orion", "提交 GPU 任务默认用集群 orion。", { type: "user", quote: "默认用集群 orion" });
    const now = await save("alice", "默认集群 lyra", "提交 GPU 任务默认用集群 lyra。", { type: "user", force: true, quote: "以后默认用集群 lyra" });
    assert.deepEqual(await links(), [`${now} derived_from memory:${old}`]);
  });

  test("L8 the turn recall shows what a recalled entry cites", async () => {
    mt.turnRecallSettings.all = false;
    mt.turnRecallSettings.users = new Set(["alice"]);
    const alice = await w.user("alice");
    const dataset = await save("alice", "Kestrel 用的数据集是 Wren-v3", "Kestrel 用的数据集叫 Wren-v3。许可证限制记在「Wren 许可」那一条里（该条目尚未建立）。");
    const licence = await save("alice", "Wren-v3 许可：仅限内部评测", "Wren 许可：Wren-v3 只能用于内部评测，不能用于训练对外发布的模型。");
    const turn = await w.routerTurn(alice);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, 'alice', NULL, $3, '{"kind":"person"}'::jsonb, '{}'::jsonb, NOW())`,
      [turn.sid, turn.mid, "Kestrel 用的数据集叫什么？"],
    );
    const task: Record<string, unknown> = { task_id: turn.task_id, message_id: turn.mid, prompt: "Kestrel 用的数据集叫什么？" };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    const recalled = /<memory-recall[\s\S]*?<\/memory-recall>/.exec(String(task.prompt))?.[0] ?? "";
    const line = recalled.split("\n").find((l) => l.includes(`#${dataset} `)) ?? "";
    assert.ok(line.endsWith(`(cites #${licence} Wren-v3 许可：仅限内部评测)`), recalled);
  });

  test("L9 a cited entry renamed away takes the citation with it", async () => {
    mt.turnRecallSettings.all = true;
    const dataset = await save("alice", "Kestrel 用的数据集是 Wren-v3", "Kestrel 用的数据集叫 Wren-v3。许可证限制记在「Wren 许可」那一条里。");
    const licence = await save("alice", "Wren-v3 许可：仅限内部评测", "Wren 许可：Wren-v3 只能用于内部评测。");
    assert.deepEqual(await links(), [`${dataset} cites memory:${licence}`]);
    const r = await svc.updateMemory("alice", licence, { title: "Kestrel 发布窗口", body: "Kestrel 只在每月第二个周四发布。" }, { kind: "api", attended: true });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(await links(), [`${dataset} cites title:Wren 许可`]);
    assert.equal((await svc.citationsOf("alice", [dataset])).get(dataset), undefined);
    // Undone, the old words name it again.
    assert.equal(await svc.undoMemory("alice", licence, "api"), "restored");
    assert.deepEqual(await links(), [`${dataset} cites memory:${licence}`]);
    mt.turnRecallSettings.all = false;
  });

  test("L10 a later entry that ties with the cited one leaves the name unjoined", async () => {
    const dataset = await save("alice", "Kestrel 数据集", "数据集 Wren-v3，许可证见「Wren 许可」。");
    const licence = await save("alice", "Wren 许可（评测）", "Wren 许可：Wren-v3 只能用于内部评测。");
    assert.deepEqual(await links(), [`${dataset} cites memory:${licence}`]);
    await save("alice", "Wren 许可变更记录", "Wren 许可在 2027 年会放宽到外部研究。");
    assert.deepEqual(await links(), [`${dataset} cites title:Wren 许可`]);
  });

  test("L11 an entry waiting for confirmation does not capture a name; confirmed, it is joined", async () => {
    const dataset = await save("alice", "Kestrel 数据集", "数据集 Wren-v3，许可证见「Wren 许可」。");
    const r = await svc.writeMemory("alice", { type: "project", title: "Wren-v3 许可", body: "Wren 许可：Wren-v3 只能用于内部评测。" }, { kind: "api", attended: false });
    assert.ok(r.ok && r.status === "pending", JSON.stringify(r));
    assert.deepEqual(await links(), [`${dataset} cites title:Wren 许可`]);
    const ok = await svc.updateMemory("alice", r.id, {}, { kind: "api", attended: true });
    assert.ok(ok.ok && ok.status === "active", JSON.stringify(ok));
    assert.deepEqual(await links(), [`${dataset} cites memory:${r.id}`]);
  });

  test("L12 an update waits for the user's lock before locking a row: no deadlock with a forget-all holding it", async () => {
    const id = await save("alice", "Kestrel 发布窗口", "Kestrel 只在每月第二个周四发布。");
    const pool = w.h.app.db.db.pool as unknown as { connect(): Promise<{ query(t: string, p?: unknown[]): Promise<unknown>; release(): void }> };
    const other = await pool.connect();
    try {
      // What a forget-all does: the user's lock first, then the delete of their rows.
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock(hashtext('claw_memory:' || $1))", ["alice"]);
      const update = svc.updateMemory("alice", id, { body: "Kestrel 改到每月第三个周四发布。" }, { kind: "api", attended: true });
      await new Promise((r) => setTimeout(r, 300));
      await other.query("DELETE FROM claw_memory_entries WHERE user_id = 'alice' AND id = $1", [id]);
      await other.query("COMMIT");
      const r = await update;
      assert.ok(!r.ok && r.error === "not_found", JSON.stringify(r));
    } finally {
      await other.query("ROLLBACK").catch(() => undefined);
      other.release();
    }
  });
});

describe("citations, pure", () => {
  test("C1 numbers and corner-bracket names, each once; not repo#12, not a quotation", () => {
    assert.deepEqual(citationsIn("见 #12 和 #12、repo#13、x#14，「Kestrel 发布窗口」与『Heron 联系方式』"), { ids: [12], names: ["Kestrel 发布窗口", "Heron 联系方式"] });
    assert.deepEqual(citationsIn(`「${"长".repeat(61)}」 「」 「！」`).names, []);
    assert.deepEqual(citationsIn("PR #12、pull #13、issue #14、事项 #15、事项#16、item #17 都不是；记忆 #18 是").ids, [18]);
  });
  test("C2 a name names the one entry holding all its terms; of two, the one whose title holds more; a tie names none", () => {
    const c = [
      { id: 1, title: "Wren-v3 许可：仅限内部评测", body: "Wren 许可：只能内部评测" },
      { id: 2, title: "Kestrel 数据集", body: "数据集 Wren-v3，许可证见「Wren 许可」" },
      { id: 3, title: "Heron", body: "无关" },
    ];
    assert.equal(resolveCitation("Wren 许可", c, 2), 1);
    assert.equal(resolveCitation("Wren 许可", c, null), 1);
    assert.equal(resolveCitation("Wren 许可", [c[1], { id: 4, title: "Kestrel 评测", body: "依据「Wren 许可」" }], null), null);
    assert.equal(resolveCitation("Lark 教训", c, null), null);
  });
});
