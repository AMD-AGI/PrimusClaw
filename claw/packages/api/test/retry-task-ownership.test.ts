// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { retryTask } from "../src/tasks/lifecycle.js";
import { type SandboxHandle } from "../src/tasks/sandbox-handle.js";
import { startHarness, type Harness } from "./scenario-harness.js";

const RETAINED_METADATA = { input_label: "retained", custom: { sandbox: "user-defined value" } };
let h: Harness;

before(async () => {
  h = await startHarness();
});

beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

async function seedOriginal(sandbox: SandboxHandle | null) {
  const metadata = {
    ...RETAINED_METADATA, ...(sandbox ? { sandbox } : {}),
    run_phase: { phase: "waiting" }, last_release: { reason: "worker_lost" }, retried_into: "previous-retry",
  };
  const workloadId = sandbox?.provider === "agent-sandbox" ? null : sandbox?.handle ?? "legacy-workload";
  await h.sql(
    `INSERT INTO claw_tasks
       (task_id, session_id, name, status, origin, metadata, brain_id,
        sandbox_workload_id, platform_message, workspace_throwaway)
     VALUES ('original', 'session-1', 'work', 'failed', 'task', $1::jsonb,
             'worker-a', $2, 'Preempted, reclaimed', TRUE)`,
    [JSON.stringify(metadata), workloadId],
  );
  return { metadata, workloadId };
}

for (const sandbox of [
  { provider: "safe-workload", handle: "workload-a" },
  { provider: "agent-sandbox", handle: "agent-a" },
  null,
] satisfies Array<SandboxHandle | null>) {
  test(`a retry leaves ${sandbox?.provider ?? "legacy"} ownership on the original run`, async () => {
    const original = await seedOriginal(sandbox);

    const result = await retryTask("original");

    assert.equal(result.ok, true);
    assert.ok(result.new_task_id);
    const [retry] = await h.sql(
      `SELECT parent_task_id, status, brain_id, sandbox_workload_id,
              metadata, platform_message, workspace_throwaway
         FROM claw_tasks WHERE task_id = $1`,
      [result.new_task_id],
    );
    assert.deepEqual(retry, {
      parent_task_id: "original", status: "queued", brain_id: null,
      sandbox_workload_id: null, metadata: RETAINED_METADATA,
      platform_message: null, workspace_throwaway: true,
    });
    const [previous] = await h.sql(
      "SELECT status, brain_id, sandbox_workload_id, metadata, platform_message FROM claw_tasks WHERE task_id = 'original'",
    );
    assert.deepEqual(previous, {
      status: "failed", brain_id: "worker-a", sandbox_workload_id: original.workloadId,
      metadata: { ...original.metadata, retried_into: result.new_task_id },
      platform_message: "Preempted, reclaimed",
    });
  });
}
