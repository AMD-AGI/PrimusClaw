// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Research reports opened per user (`CLAW_ASSISTANT_RESEARCH_USERS`, `assistant/research.ts`) on a real Postgres, with the switch off
 * and alice named. Its own file: the settings are read when the API's modules load, which `startWorld` does with the names set.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   RP1 (Postgres) alice's worker turn has its deliver_text checked and the research method, and her router turn the hand-off;
 *       bob's turns have neither, and a cite_check his request carried is taken off
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

describe("research reports on Postgres, opened for alice", { skip: postgresSkipReason() }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_RESEARCH_USERS: "alice" });
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions CASCADE");
    alice = await w.user("alice");
    bob = await w.user("bob");
  });

  test("RP1 alice's turns get research, bob's do not", async () => {
    const text = (task: Record<string, unknown>) => JSON.stringify(task);
    for (const [u, on] of [[alice, true], [bob, false]] as const) {
      const item = await w.createItem(u, `Compare two engines for ${u.userId}`);
      const row = await w.item(item.itemId);
      const run = await w.openRun(row.worker_session_id);
      const task: Record<string, unknown> = {
        task_id: run.taskId, message_id: run.messageId, cite_check: { tools: ["mcp__assistant__deliver_text"] },
      };
      await w.mod.role.applySessionRoleToTask(task, row.worker_session_id);
      assert.deepEqual(task.cite_check, on ? { tools: ["mcp__assistant__deliver_text"], revise: { rounds: 1, unverified_ratio: 0.05 } } : undefined, `worker ${u.userId}`);
      assert.equal(text(task).includes("When the item asks for research or a report with sources"), on, `worker ${u.userId}`);

      const router = await w.openRun(u.routerSid);
      const rtask: Record<string, unknown> = { task_id: router.taskId, message_id: router.messageId, prompt: "帮我出一份对比报告" };
      await w.mod.role.applySessionRoleToTask(rtask, u.routerSid);
      assert.equal(text(rtask).includes("Never write such a report yourself"), on, `router ${u.userId}`);
      assert.equal(rtask.cite_check, undefined, "a router's deliver_text is never checked");
      await w.closeRun(router.taskId);
    }
  });
});
