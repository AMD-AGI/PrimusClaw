// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SANDBOX_ALLOWED_NAMESPACES at dispatch: the routes refuse a workspace off the
 * list with 400, but a DAG node's namespace can be a template rendered only now,
 * and a session can be pinned from before the list was set. `dispatchTask`
 * fails such a run `sandbox_workspace_not_allowed` and publishes nothing; the
 * same run in a listed workspace, and with no list, is published.
 *
 * Driven through `dispatchTask` itself, not the guard helper, so the test fails
 * if the dispatcher stops asking.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.TASK_DISPATCH_STAGE_TIMEOUT_MS = "200";
process.env.CLAW_DEPLOY_MODE = "safe";
process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
(await import("../src/crypto/user-env.js")).initUserEnvCrypto();

const { db } = await import("../src/infra/db.js");
const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");

const originalQuery = db.query;
after(() => {
  db.query = originalQuery;
  delete process.env.SANDBOX_ALLOWED_NAMESPACES;
});

const NOW = new Date().toISOString();

function taskRow(namespace: string) {
  return {
    task_id: "t-1",
    session_id: "s-1",
    status: "preparing",
    mode: "script",
    prompt: "",
    input: {},
    plugin_id: null,
    sandbox_spec: { handle: "ws", image: "registry.example.invalid/img:1", namespace },
    dag_root_task_id: null,
    started_at: NOW,
    created_at: NOW,
  };
}

interface Captured {
  published: Array<Record<string, unknown>>;
  reasons: string[];
}

async function dispatchIn(namespace: string, list: string | undefined): Promise<Captured> {
  if (list === undefined) delete process.env.SANDBOX_ALLOWED_NAMESPACES;
  else process.env.SANDBOX_ALLOWED_NAMESPACES = list;
  const captured: Captured = { published: [], reasons: [] };
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/SELECT user_id, config FROM claw_sessions/.test(sql)) {
      return { rows: [{ user_id: "u-1", config: { platform_key: "pk-user-1", _server_managed_credentials: true } }], rowCount: 1 };
    }
    if (/^UPDATE claw_tasks SET status/.test(sql)) {
      const reason = params.find((p) => typeof p === "string" && /^[a-z_]+$/.test(p) && /not_allowed|agent_error|missing_platform_key|workspace_bind_failed/.test(p));
      if (typeof reason === "string") captured.reasons.push(reason);
      return { rows: [taskRow(namespace)], rowCount: 1 };
    }
    if (/^UPDATE claw_tasks SET/.test(sql)) return { rows: [taskRow(namespace)], rowCount: 1 };
    if (/FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) return { rows: [taskRow(namespace)], rowCount: 1 };
    if (/claw_workspace/.test(sql)) {
      return { rows: [{ workspace_id: "kws_1", storage_prefix: "users/u-1/sessions/s-1/" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const originalPublish = taskPublisher.publish;
  taskPublisher.publish = (async (payload: string) => {
    captured.published.push(JSON.parse(payload));
  }) as typeof taskPublisher.publish;
  try {
    await dispatchTask("t-1");
  } finally {
    taskPublisher.publish = originalPublish;
  }
  return captured;
}

test("a rendered sandbox off the list is failed sandbox_workspace_not_allowed and not published", async () => {
  const seen = await dispatchIn("ws-open", "ws-isolated");
  assert.deepEqual(seen.published, [], "a run off the list reached Brain");
  assert.deepEqual(seen.reasons, ["sandbox_workspace_not_allowed"]);
});

test("the same run in a listed workspace, and in any workspace with no list, is published", async () => {
  for (const [ns, list] of [["ws-isolated", "ws-isolated"], ["ws-open", undefined]] as const) {
    const seen = await dispatchIn(ns, list);
    assert.equal(seen.published.length, 1, `${ns} / ${String(list)}: ${JSON.stringify(seen.reasons)}`);
    assert.equal(seen.published[0]!.workspace_id, ns);
  }
});
