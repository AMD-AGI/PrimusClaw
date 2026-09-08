// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { UserInfo } from "../src/auth/models.js";
import type { DispatchInput } from "../src/sessions/dispatch.js";
import type { Harness } from "./scenario-harness.js";

process.env.CLAW_DEPLOY_MODE = "safe";
process.env.LLM_KEY_SOURCE = "virtualKey";

const { db } = await import("../src/infra/db.js");
const { dispatchTaskToBrain, sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
const { readTrustedSessionCredentials } = await import("../src/auth/session-credentials.js");
const { startHarness, seedSession } = await import("./scenario-harness.js");

let h: Harness;
let query: typeof db.query;
const originalPorts = { ...sessionDispatchPorts };
const user: UserInfo = {
  userId: "user-1", userName: "User", roles: ["default"],
  platformKey: "platform-first", virtualKey: "llm-first",
};

before(async () => {
  h = await startHarness();
  await h.sql("ALTER TABLE claw_sessions ADD COLUMN IF NOT EXISTS config JSONB");
  query = db.query;
});
beforeEach(async () => {
  db.query = query;
  Object.assign(sessionDispatchPorts, originalPorts);
  await h.reset();
  await h.sql("ALTER TABLE claw_sessions DROP CONSTRAINT IF EXISTS reject_credentials");
  await seedSession(h, "session-1");
});
after(async () => {
  Object.assign(sessionDispatchPorts, originalPorts);
  await h?.close();
});

function input(caller: UserInfo | null): DispatchInput {
  return {
    sessionId: "session-1", userId: "user-1", user: caller,
    content: "Answer briefly", messageType: "text", toolIds: [],
    pluginId: undefined, requestImage: undefined, requestResource: undefined,
    requestTimeout: undefined, workspaceId: undefined, mcpServers: undefined,
    capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
  };
}

async function config(): Promise<Record<string, unknown> | null> {
  const [row] = await h.sql("SELECT config FROM claw_sessions WHERE session_id = 'session-1'");
  return row.config as Record<string, unknown> | null;
}

function dispatchPorts(doorbell: boolean, expectedKey: string): string[] {
  const steps: string[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    if (/UPDATE claw_sessions\s+SET config/.test(text)) {
      const result = await query(text, params);
      steps.push("stamp");
      return result;
    }
    if (/FROM claw_workspace_refs r/.test(text)) {
      return {
        rows: [{ workspace_id: "workspace-1", storage_prefix: "files/", writer_run_id: null }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  sessionDispatchPorts.doorbellDispatch = doorbell;
  sessionDispatchPorts.admit = async () => ({ kind: "admit" });
  sessionDispatchPorts.publishSse = () => { steps.push("event"); };
  sessionDispatchPorts.openChatRun = (async () => {
    assert.equal(readTrustedSessionCredentials(await config()).platformKey, expectedKey);
    steps.push("open");
    return { taskId: "run-1" };
  }) as typeof sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.publishTask = async () => {
    assert.equal(readTrustedSessionCredentials(await config()).platformKey, expectedKey);
    steps.push("publish");
  };
  sessionDispatchPorts.failChatRunDispatch = async () => "closed";
  return steps;
}

for (const doorbell of [false, true]) {
  const path = doorbell ? "doorbell" : "direct";

  test(`${path} chat stamps the authenticated credentials before opening or publishing`, async () => {
    await h.sql("UPDATE claw_sessions SET config = $1::jsonb", [{
      model: "test-model", resources: { cpu: 2 }, platform_key: "untrusted-input",
      _server_managed_credentials: false,
    }]);
    const steps = dispatchPorts(doorbell, user.platformKey);

    const result = await dispatchTaskToBrain(input(user), async () => assert.fail("unexpected rollback"));

    assert.equal(result.kind, "dispatched");
    assert.deepEqual(steps, ["stamp", "event", "open", "publish"]);
    assert.deepEqual(await config(), {
      model: "test-model", resources: { cpu: 2 }, platform_key: user.platformKey,
      llm_api_key: user.virtualKey, _server_managed_credentials: true,
    });
  });

  test(`${path} chat refreshes the same session credentials and clears a removed LLM key`, async () => {
    dispatchPorts(doorbell, user.platformKey);
    assert.equal((await dispatchTaskToBrain(input(user), async () => {})).kind, "dispatched");
    const rotated = { ...user, platformKey: "platform-rotated", virtualKey: "" };
    dispatchPorts(doorbell, rotated.platformKey);

    const result = await dispatchTaskToBrain(input(rotated), async () => assert.fail("unexpected rollback"));

    assert.equal(result.kind, "dispatched");
    assert.deepEqual(await config(), {
      platform_key: rotated.platformKey, llm_api_key: null, _server_managed_credentials: true,
    });
  });

  test(`${path} chat rolls back a credential write failure before opening or publishing`, async () => {
    await h.sql(`ALTER TABLE claw_sessions ADD CONSTRAINT reject_credentials
      CHECK (config->>'platform_key' IS DISTINCT FROM 'platform-first')`);
    const steps = dispatchPorts(doorbell, user.platformKey);
    let rolledBack = false;

    const result = await dispatchTaskToBrain(input(user), async () => { rolledBack = true; });

    assert.equal(result.kind, "publish_failed");
    assert.equal(result.kind === "publish_failed" ? result.error.message : "", "session.credentials_stamp_failed");
    assert.equal(rolledBack, true);
    assert.deepEqual(steps, []);
    assert.equal(await config(), null);
  });

  test(`${path} chat with no platform key does not trust caller config or gain a new rejection`, async () => {
    const untrusted = { platform_key: "untrusted-input", _server_managed_credentials: false };
    await h.sql("UPDATE claw_sessions SET config = $1::jsonb", [untrusted]);
    const steps = dispatchPorts(doorbell, "");

    const result = await dispatchTaskToBrain(input({ ...user, platformKey: "" }), async () => assert.fail("unexpected rollback"));

    assert.equal(result.kind, "dispatched");
    assert.deepEqual(steps, ["event", "open", "publish"]);
    assert.deepEqual(await config(), untrusted);
  });
}
