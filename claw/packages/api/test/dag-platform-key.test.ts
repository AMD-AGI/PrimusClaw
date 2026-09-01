// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whose identity a DAG-dispatched workload runs as.
 *
 * It ran as the cluster's. `loadSessionPlatformKey` fell back to the shared
 * `SAFE_PLATFORM_KEY` whenever a session carried no key of its own, and the only
 * entry point that recorded one was the workbench route -- so every task created
 * through `POST /v1/sessions/:id/tasks` or `POST /v1/batches` dispatched under a
 * shared identity, silently, with a `hasPlatformKey` in a log line as the only
 * trace.
 *
 * The consequence is not only attribution. SaFE reads
 * `primus-safe.amd.com/user.id` from the bearer's subject and grants
 * update/delete/resume to the workload's owner, so the person who submitted a run
 * could not stop, delete or resume it.
 *
 * Coverage:
 *   C1 a session with the submitter's key dispatches as the submitter
 *   C2 a session with no key is refused, not downgraded
 *   C3 a key the caller put in config themselves is not trusted
 *   C4 the refusal is its own failure reason, not agent_error
 *   C5 the patch every entry point writes carries the marker
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";

process.env.TASK_DISPATCH_STAGE_TIMEOUT_MS = "200";
process.env.SAFE_PLATFORM_KEY = "pk-CLUSTER-SHARED";

const { dispatchTask, taskPublisher } = await import("../src/tasks/dispatcher.js");
const { sessionCredentialPatch, MissingPlatformKeyError } = await import(
  "../src/auth/session-credentials.js"
);

const originalQuery = db.query;
after(() => {
  db.query = originalQuery;
});

const NOW = new Date().toISOString();

function taskRow() {
  return {
    task_id: "t-1",
    session_id: "s-1",
    status: "preparing",
    mode: "script",
    prompt: "",
    input: {},
    plugin_id: null,
    sandbox_spec: "none",
    dag_root_task_id: null,
    started_at: NOW,
    created_at: NOW,
  };
}

interface Captured {
  published: Array<Record<string, unknown>>;
  transitions: string[];
  reasons: string[];
}

/** Drive one dispatch against a session whose config is `config`. */
async function dispatchWith(config: Record<string, unknown> | null): Promise<Captured> {
  const captured: Captured = { published: [], transitions: [], reasons: [] };

  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/SELECT user_id, config FROM claw_sessions/.test(sql)) {
      return { rows: [{ user_id: "u-1", config }], rowCount: 1 };
    }
    if (/^UPDATE claw_tasks SET status/.test(sql)) {
      const to = String(params[0] ?? "");
      captured.transitions.push(to);
      const reason = params.find(
        (p) => typeof p === "string" && /missing_platform_key|agent_error|workspace_bind_failed/.test(p),
      );
      if (typeof reason === "string") captured.reasons.push(reason);
      return { rows: [taskRow()], rowCount: 1 };
    }
    if (/^UPDATE claw_tasks SET/.test(sql)) return { rows: [taskRow()], rowCount: 1 };
    if (/FROM claw_tasks t LEFT JOIN claw_sessions/.test(sql)) {
      return { rows: [taskRow()], rowCount: 1 };
    }
    if (/claw_workspace/.test(sql)) {
      // Bound, so the dispatch reaches the publish and the question this file
      // asks -- whose key went out with it -- can be answered at all.
      return {
        rows: [{ workspace_id: "kws_1", storage_prefix: "users/u-1/sessions/s-1/" }],
        rowCount: 1,
      };
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

test("C1 a session with the submitter's key dispatches as the submitter", async () => {
  const seen = await dispatchWith({
    platform_key: "pk-user-1",
    _server_managed_credentials: true,
  });
  assert.equal(seen.published.length, 1, "the run was not dispatched");
  const req = seen.published[0] as { platform_key?: string };
  assert.equal(
    req.platform_key,
    "pk-user-1",
    "the run went out under something other than the submitter's key",
  );
});

test("C2 a session with no key is refused, not downgraded", async () => {
  const seen = await dispatchWith({});
  assert.deepEqual(seen.published, [], "the run was dispatched without a caller identity");
  assert.ok(
    seen.transitions.includes("failed"),
    "the task neither dispatched nor failed; it would sit until the deadline backstop",
  );
});

test("C2b the shared cluster key is never substituted", async () => {
  // The env is set at the top of this file precisely so a fallback would find
  // something. Before the fix this dispatched with pk-CLUSTER-SHARED.
  const seen = await dispatchWith({});
  const used = seen.published.map((p) => (p as { platform_key?: string }).platform_key);
  assert.ok(
    !used.includes("pk-CLUSTER-SHARED"),
    "the dispatcher fell back to the cluster's shared identity",
  );
});

test("C3 a key the caller put in config themselves is not trusted", async () => {
  // config is caller-supplied JSON on some paths. The marker is what separates a
  // key this service wrote from one a request body asked it to believe.
  const seen = await dispatchWith({ platform_key: "pk-forged" });
  assert.deepEqual(seen.published, [], "an unmarked key in config was dispatched with");
});

test("C4 the refusal is its own failure reason, not agent_error", async () => {
  const seen = await dispatchWith({});
  assert.ok(
    seen.reasons.includes("missing_platform_key"),
    `expected missing_platform_key, saw ${JSON.stringify(seen.reasons)}`,
  );
  assert.ok(
    !seen.reasons.includes("agent_error"),
    "filed under agent_error it would be counted among the workload's own failures",
  );
});

test("C5 the patch every entry point writes carries the marker", () => {
  const patch = sessionCredentialPatch({
    userId: "u-1",
    userName: "u",
    roles: [],
    platformKey: "pk-user-1",
    virtualKey: "vk-1",
  });
  assert.equal(patch._server_managed_credentials, true);
  assert.equal(patch.platform_key, "pk-user-1");
});

test("C5b a caller with no key is refused before anything is queued", async () => {
  const { stampSessionCredentials } = await import("../src/auth/session-credentials.js");
  await assert.rejects(
    () =>
      stampSessionCredentials("s-1", {
        userId: "u-1",
        userName: "u",
        roles: [],
        platformKey: "",
        virtualKey: "",
      }),
    MissingPlatformKeyError,
  );
});
