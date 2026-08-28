// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { db } from "../src/infra/db.js";
import { pendingDispatchPorts } from "../src/tasks/pending-dispatch.js";
import {
  gpuNodesFromSpec, stripRunSecrets, wantsSandboxFromSpec,
} from "../src/tasks/run-spec.js";
import {
  applySealedCredentials, credentialsFromTask, openRunCredentials, pendingSecretColumns,
  sealRunCredentials,
} from "../src/tasks/run-secrets.js";

function withCrypto(): void {
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  initUserEnvCrypto();
}

test("the persistable spec drops keys that must not sit in Postgres in the clear", () => {
  const spec = stripRunSecrets({
    prompt: "hello",
    llm_api_key: "sk-live",
    platform_key: "pk-live",
    user_env: { OPENAI_API_KEY: "sk-user" },
    session_env: { REGION: "us" },
    mcp_servers: [{ url: "https://mcp.example", headers: { Authorization: "Bearer t" } }],
    credentials: "should-not-copy",
  });
  assert.equal(spec.prompt, "hello");
  // session_env used to travel with the spec because it has no vault to be
  // re-read from. It is the caller's environment, so it is sealed instead.
  assert.equal("session_env" in spec, false);
  assert.equal("mcp_servers" in spec, false);
  assert.equal("llm_api_key" in spec, false);
  assert.equal("platform_key" in spec, false);
  assert.equal("user_env" in spec, false);
  assert.equal("credentials" in spec, false);
});

test("the persistable spec drops the history the claim rebuilds", () => {
  // Not a secret -- a duplicate. `claw_conversation_turns` owns the
  // conversation and is cleared when the session is; `claw_tasks` is never
  // deleted from, so storing the assembled context here left a second copy of
  // everything the user ever said, outliving the session they deleted.
  const spec = stripRunSecrets({
    prompt: "and the nodes?",
    history: [
      { role: "user", content: "how do I list pods" },
      { role: "assistant", content: "kubectl get pods" },
    ],
    skills: { k8s: { enabled: true } },
  });
  assert.equal("history" in spec, false);
  assert.ok(!JSON.stringify(spec).includes("kubectl get pods"), "no turn text survives");
  // The rest of the turn is the run's definition and does stay on the row.
  assert.equal(spec.prompt, "and the nodes?");
  assert.deepEqual(spec.skills, { k8s: { enabled: true } });
});

test("sandbox and gpu asks are read from the spec, not from secrets", () => {
  assert.equal(wantsSandboxFromSpec({ sandbox_image: "img:1" }), true);
  assert.equal(wantsSandboxFromSpec({ sandbox_spec: "none" }), false);
  assert.equal(gpuNodesFromSpec({ topology: { nodes: 4 } }), 4);
  assert.equal(gpuNodesFromSpec({ topology: "ray" }), 0);
});

test("sealed credentials round-trip and are not stored as plaintext", () => {
  withCrypto();
  const blob = sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" });
  assert.equal(blob.includes("sk-live"), false);
  assert.equal(blob.includes("pk-live"), false);
  assert.deepEqual(openRunCredentials(blob), { llm_api_key: "sk-live", platform_key: "pk-live" });
});

test("a doorbell pending row stores a blob instead of the keys", () => {
  withCrypto();
  const doorbell = pendingSecretColumns({
    llmKey: "sk-live", platformKey: "pk-live",
    userEnv: { OPENAI_API_KEY: "sk-user" }, doorbell: true,
  });
  // Both, for one release. The drain runs on every API replica and only one
  // that knows about credentials_blob reads it, so a pod from the previous
  // image -- mid-rollout, or for as long as a rollback lasts -- would other-
  // wise publish a turn with no credentials at all.
  assert.ok(doorbell.blob, "the sealed copy is what a current reader prefers");
  assert.equal(doorbell.blob!.includes("sk-live"), false, "and it is not readable");
  assert.equal(doorbell.llm, "sk-live", "the plaintext column stays until every replica reads the blob");
  assert.equal(doorbell.platform, "pk-live");
  assert.deepEqual(doorbell.userEnv, { OPENAI_API_KEY: "sk-user" });

  const fat = pendingSecretColumns({
    llmKey: "sk-live", platformKey: "pk-live",
    userEnv: { OPENAI_API_KEY: "sk-user" }, doorbell: false,
  });
  assert.equal(fat.llm, "sk-live");
  assert.equal(fat.blob, null);
  assert.equal(fat.userEnv.OPENAI_API_KEY, "sk-user");
});

test("a sealed blob on a fat execute request restores the keys and drops credentials", () => {
  withCrypto();
  const blob = sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" });
  const task: Record<string, unknown> = { prompt: "hello", credentials: blob };
  applySealedCredentials(task, blob);
  assert.equal(task.llm_api_key, "sk-live");
  assert.equal(task.platform_key, "pk-live");
  assert.equal("credentials" in task, false);
});

test("session env and mcp definitions survive the round trip through the envelope", () => {
  withCrypto();
  // Sealing them is only correct if the worker still gets them: unlike
  // user_env there is no vault the claim could re-read them from.
  const blob = sealRunCredentials(credentialsFromTask({
    llm_api_key: "sk-live",
    platform_key: "pk-live",
    session_env: { REGION: "us" },
    mcp_servers: [{ url: "https://mcp.example", headers: { Authorization: "Bearer t" } }],
  }));
  assert.doesNotMatch(blob, /REGION|Bearer t|sk-live/, "nothing readable in the ciphertext");
  const opened = openRunCredentials(blob);
  assert.deepEqual(opened.session_env, { REGION: "us" });
  assert.deepEqual(opened.mcp_servers, [
    { url: "https://mcp.example", headers: { Authorization: "Bearer t" } },
  ]);
});

test("a blob sealed before the envelope widened still opens", () => {
  withCrypto();
  // Rows written by the previous release carry only the two keys. Hydrating
  // one must not invent an empty session_env and drop what the caller sent.
  const legacy = sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" });
  const opened = openRunCredentials(legacy);
  assert.equal(opened.llm_api_key, "sk-live");
  assert.equal("session_env" in opened, false);
  assert.equal("mcp_servers" in opened, false);
});

test("an unreadable pending blob ends that turn instead of wedging the drain", async () => {
  // The last unpinned producer from the coverage audit. The guard could be
  // deleted entirely -- restoring the version where the throw escapes
  // handleComplete and the event is redelivered every ten seconds for ever --
  // without a single test failing.
  withCrypto();
  const { applyPendingCredentials } = await import("../src/events/consumer.js");
  const deleted: unknown[][] = [];
  const originalQuery = db.query;
  db.query = (async (text: string, params: unknown[] = []) => {
    if (/DELETE FROM claw_pending_messages/.test(text)) deleted.push(params);
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  const originalPublish = pendingDispatchPorts.publishSessionEvent;
  const events: Array<Record<string, unknown>> = [];
  pendingDispatchPorts.publishSessionEvent = async (_s, e) => { events.push(e); };
  try {
    const task: Record<string, unknown> = { prompt: "hi" };
    const ok = await applyPendingCredentials(
      task,
      { id: 7, content: "hi", credentials_blob: "dHJ1bmNhdGVk" },
      { sessionId: "s-1", userId: "u-1", messageId: "m-1" },
    );
    assert.equal(ok, false, "the turn is not dispatched");
    assert.equal("llm_api_key" in task, false, "and no empty key was put on it");
    assert.deepEqual(deleted, [[7]], "the queue entry is dropped so it is not redelivered");
    assert.ok(events.some((e) => e.failure_reason === "credentials_unreadable"),
      "and the reader is told why");
  } finally {
    db.query = originalQuery;
    pendingDispatchPorts.publishSessionEvent = originalPublish;
  }
});

test("a readable pending blob still puts the keys on the task", async () => {
  withCrypto();
  const { applyPendingCredentials } = await import("../src/events/consumer.js");
  const task: Record<string, unknown> = { prompt: "hi" };
  const ok = await applyPendingCredentials(
    task,
    { id: 8, content: "hi", credentials_blob: sealRunCredentials({ llm_api_key: "sk-live", platform_key: "pk-live" }) },
    { sessionId: "s-1", userId: "u-1", messageId: "m-1" },
  );
  assert.equal(ok, true);
  assert.equal(task.llm_api_key, "sk-live");
});
