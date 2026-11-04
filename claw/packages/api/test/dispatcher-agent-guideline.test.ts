// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With `CLAW_AGENT_GUIDELINE_ENABLED` on, a task the scheduler dispatches carries the working guideline when it runs a
 * model turn, like a chat turn does. The dispatcher publishes `tasks.execute` itself rather than through
 * `applySessionRoleToTask`, so without its own call `/v1/tasks` and workbench runs went without it. An app run has no
 * model turn and gets none -- the control that makes the first assertion mean something.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.TASK_DISPATCH_STAGE_TIMEOUT_MS = "200";
process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.LLM_KEY_SOURCE = "virtualKey";
process.env.CLAW_AGENT_GUIDELINE_ENABLED = "true";
const { db } = await import("../src/infra/db.js");
const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");
const { AGENT_GUIDELINE } = await import("../src/sessions/agent-guideline.js");

const originalQuery = db.query;
const originalPublish = taskPublisher.publish;
after(() => {
  db.query = originalQuery;
  taskPublisher.publish = originalPublish;
});

/** Dispatch a row of this mode and return the execute request it published. */
async function published(mode: string): Promise<Record<string, unknown>> {
  const row = {
    task_id: `ktsk_${mode}`, session_id: "s-1", dag_id: null, dag_node_id: null, dag_root_task_id: null,
    status: "preparing", started_at: new Date().toISOString(), prompt: "summarise the repo", script: null,
    sandbox_spec: "none", input: {}, metadata: {}, depends_on: [], mode,
  };
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/^UPDATE claw_tasks SET/.test(sql)) return { rows: [row], rowCount: 1 };
    if (/FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) return { rows: [row], rowCount: 1 };
    if (/claw_workspace/.test(sql)) {
      return { rows: [{ workspace_id: "kws_1", storage_prefix: "users/u/sessions/s/" }], rowCount: 1 };
    }
    if (/SELECT user_id, config FROM claw_sessions/.test(sql)) {
      return { rows: [{ user_id: "u-1", config: { platform_key: "pk", _server_managed_credentials: true } }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const sent: string[] = [];
  taskPublisher.publish = async (payload: string) => { sent.push(payload); };
  const result = await dispatchTask(row.task_id);
  assert.equal(sent.length, 1, `expected one execute request: ${JSON.stringify(result)}`);
  return JSON.parse(sent[0]!) as Record<string, unknown>;
}

test("a dispatched model task carries the working guideline as its system text", async () => {
  assert.equal((await published("llm")).system_append, AGENT_GUIDELINE);
});

test("control: an app run, which has no model turn, carries none", async () => {
  assert.equal("system_append" in (await published("app")), false);
});
