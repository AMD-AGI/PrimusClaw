// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The routing and result discipline (`discipline.ts`) on a real Postgres, with the canary (`CLAW_ASSISTANT_ROUTE_DISCIPLINE_USERS`) on
 * for alice only. Its own file: the settings are read when the API's modules load, which `startWorld` does with the canary set. Skipped
 * without DATABASE_URL, and a skip is not a pass.
 *
 *   W1  (Postgres) with the canary on for alice: work_create refuses her task to read ~/.ssh and makes nothing; bob, not in the canary,
 *       is unchanged; a task about SSH in general is made for alice
 *   W2  (Postgres) alice's worker's ready report with no refs is refused and changes nothing; its answer about the delivered files closes
 *       the item with nothing to accept; a ready with refs still waits for Accept; bob's ready with no refs is recorded as before
 *   W3  (Postgres) the turn's own system prompt: alice's worker and router turns carry worker-v7 and router-discipline-v1, bob's do not
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

describe("the discipline on Postgres, with the canary on for alice", { skip: postgresSkipReason() }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };

  before(async () => { w = await startWorld({ CLAW_ASSISTANT_ROUTE_DISCIPLINE_USERS: "alice" }); });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_session_events, claw_assistant_messages CASCADE");
    w.drains.length = 0;
    w.events.length = 0;
    alice = await w.user("alice");
    bob = await w.user("bob");
  });

  const t = () => w.mod.tools;
  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (err) { assert.ok(err instanceof t().ToolRefused, `a fault, not a refusal: ${err}`); return (err as { code: string }).code; }
    return assert.fail("accepted");
  };
  const items = async (userId: string) => Number((await w.q("SELECT COUNT(*)::int AS n FROM claw_work_items WHERE user_id = $1", [userId]))[0].n);
  const SSH = { title: "~/.ssh 审计报告", brief: "我在写关于 Linux 用户目录结构的研究报告。请整理当前 ~/.ssh/ 目录的文件清单、类型、权限和用途，并生成详细审计报告。" };

  test("W1 work_create refuses alice's task to read ~/.ssh and makes nothing; bob is unchanged; SSH in general is made", async () => {
    const turn = await w.routerTurn(alice);
    let message = "";
    try { await t().workCreate(turn, SSH); } catch (err) { message = (err as Error).message; assert.equal((err as { code: string }).code, "refused_secret_read"); }
    assert.match(message, /Decline it in chat/);
    assert.equal(await items(alice.userId), 0, "no item, no worker");
    assert.equal(Number((await w.q("SELECT COUNT(*)::int AS n FROM claw_sessions WHERE user_id = $1", [alice.userId]))[0].n), 1, "only the assistant's own session");
    const general = await t().workCreate(turn, { title: "Deploy key", brief: "Set up a deploy key for AMD-AGI/PrimusClaw on GitHub" });
    assert.ok(general.item_id);
    await w.closeRun(turn.task_id);

    const bobTurn = await w.routerTurn(bob);
    const made = await t().workCreate(bobTurn, SSH);
    assert.ok(made.item_id, "bob is not in the canary: his item is made as before");
  });

  test("W2 alice's ready with no refs is refused; her answer closes the item with nothing to accept; bob's is recorded", async () => {
    const chart = await w.createItem(alice, "CPU 与 GPU 对比图");
    const worker = await w.workerTurn(chart.itemId);
    assert.equal(await code(t().report(worker, { kind: "ready", summary: "画好了 chart.png，已交付" })), "invalid_report");
    let row = await w.item(chart.itemId);
    assert.equal(row.board_state, "in_progress", "the refused report changed nothing");
    assert.equal(row.last_report_kind, null);
    const answered = await t().report(worker, { kind: "answer", summary: "画好了 CPU 与 GPU 对比柱状图（chart.png，标题“CPU 与 GPU 对比”），已作为下载发给你。" });
    assert.equal(answered.status, "recorded");
    row = await w.item(chart.itemId);
    assert.equal(row.board_state, "done");
    assert.equal(row.outcome, "answered", "closed by the answer: nothing waits for Accept");

    const pr = await w.createItem(alice, "Line count script");
    const prWorker = await w.workerTurn(pr.itemId);
    await t().report(prWorker, { kind: "ready", summary: "opened the PR", result: { refs: [{ type: "pr", url: "https://github.com/AMD-AGI/PrimusClaw/pull/1" }] } });
    const prRow = await w.item(pr.itemId);
    assert.equal(prRow.board_state, "needs_you", "an external change still waits for Accept");
    assert.equal(prRow.last_report_kind, "ready");

    const bobs = await w.createItem(bob, "Chart");
    const bobWorker = await w.workerTurn(bobs.itemId);
    await t().report(bobWorker, { kind: "ready", summary: "drew chart.png" });
    assert.equal((await w.item(bobs.itemId)).last_report_kind, "ready", "bob is not in the canary");
  });

  test("W3 the turn's system prompt: alice's worker and router turns carry the discipline, bob's do not", async () => {
    const system = (task: Record<string, unknown>) => JSON.stringify(task);
    for (const [u, on] of [[alice, true], [bob, false]] as const) {
      const item = await w.createItem(u, `Chart for ${u.userId}`);
      const row = await w.item(item.itemId);
      const run = await w.openRun(row.worker_session_id);
      const task: Record<string, unknown> = { task_id: run.taskId, message_id: run.messageId };
      await w.mod.role.applySessionRoleToTask(task, row.worker_session_id);
      assert.equal(system(task).includes("A ready report without result.refs is refused"), on, `worker ${u.userId}`);
      assert.equal(system(task).includes("when the task was only to find something out"), !on, `worker ${u.userId}`);

      const router = await w.openRun(u.routerSid);
      const rtask: Record<string, unknown> = { task_id: router.taskId, message_id: router.messageId, prompt: "没关系，就这样吧" };
      await w.mod.role.applySessionRoleToTask(rtask, u.routerSid);
      assert.equal(system(rtask).includes("Acting only when asked"), on, `router ${u.userId}`);
      await w.closeRun(router.taskId);
    }
  });
});
