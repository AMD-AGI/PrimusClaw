// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { publicSessionRow, publicTaskRow, redactPublicJson } from "../src/events/redaction.js";
import type { ClawTaskRow } from "../src/tasks/types.js";

test("redactPublicJson recursively masks credential and environment fields", () => {
  const safe = redactPublicJson({
    nested: {
      platform_key: "pk-secret",
      llm_api_key: "llm-secret",
      authorization: "Bearer secret",
      env: { DATABASE_URL: "postgres://secret" },
      token_usage: { prompt_tokens: 12, completion_tokens: 4 },
      command: "curl -H 'Authorization: Bearer sk-legacy-secret-value-123' https://example.test",
      harmless: "visible",
    },
  });
  const encoded = JSON.stringify(safe);
  assert.equal(encoded.includes("pk-secret"), false);
  assert.equal(encoded.includes("llm-secret"), false);
  assert.equal(encoded.includes("postgres://secret"), false);
  assert.equal(encoded.includes("sk-legacy-secret-value-123"), false);
  assert.equal(encoded.includes("visible"), true);
  assert.deepEqual((safe as { nested: { token_usage: unknown } }).nested.token_usage, {
    prompt_tokens: 12,
    completion_tokens: 4,
  });
});

test("redactPublicJson masks camelCase credential keys", () => {
  // redactPublicJson is not only applied to snake_case Postgres rows:
  // events/store.ts::sanitizeSessionEvent runs it over every live Brain event
  // before SSE delivery, and those payloads are camelCase JS objects whose
  // values carry no credential shape for redactSecrets to match on.
  const safe = redactPublicJson({
    argumentsDetail: { login: { userPassword: "hunter2", accessToken: "plain-value-1" } },
    result: { refreshToken: "plain-value-2", openaiApiKey: "plain-value-3", label: "visible" },
  });
  const encoded = JSON.stringify(safe);
  for (const leaked of ["hunter2", "plain-value-1", "plain-value-2", "plain-value-3"]) {
    assert.equal(encoded.includes(leaked), false, `${leaked} must not survive`);
  }
  assert.equal(encoded.includes("visible"), true);
});

test("redactPublicJson leaves usage counters and absent fields alone", () => {
  const safe = redactPublicJson({
    tokenUsage: { input_tokens: 12, output_tokens: 4 },
    accessToken: null,
    apiKey: "",
  });
  assert.deepEqual(safe, {
    tokenUsage: { input_tokens: 12, output_tokens: 4 },
    accessToken: null,
    apiKey: "",
  });
});

test("publicSessionRow removes internal routing fields and redacts config", () => {
  const safe = publicSessionRow({
    session_id: "sid",
    brain_url: "http://brain.internal",
    hands_url: "http://hands.internal",
    config: { source: "workbench", platform_key: "pk-secret" },
  });
  assert.equal("brain_url" in safe, false);
  assert.equal("hands_url" in safe, false);
  assert.equal(JSON.stringify(safe).includes("pk-secret"), false);
});

test("publicTaskRow removes callback endpoints and all snapshotted credentials", () => {
  const task = {
    task_id: "task",
    session_id: "sid",
    callback_url: "http://api.internal/callback?token=secret",
    backend_mcp_url: "http://mcp.internal",
    internal_token_hash: "hash",
    input: { user_env: { API_TOKEN: "input-secret" } },
    sandbox_spec: { env: { API_TOKEN: "sandbox-secret" } },
    metadata: { credential: "metadata-secret" },
  } as unknown as ClawTaskRow;
  const safe = publicTaskRow(task);
  const encoded = JSON.stringify(safe);
  assert.equal("callback_url" in safe, false);
  assert.equal("backend_mcp_url" in safe, false);
  assert.equal("internal_token_hash" in safe, false);
  assert.equal(encoded.includes("input-secret"), false);
  assert.equal(encoded.includes("sandbox-secret"), false);
  assert.equal(encoded.includes("metadata-secret"), false);
});

test("publicTaskRow masks the sealed credentials blob on a doorbell spec", () => {
  const task = {
    task_id: "task",
    session_id: "sid",
    input: { prompt: "hello", credentials: "sealed-blob-must-not-leak" },
  } as unknown as ClawTaskRow;
  const safe = publicTaskRow(task);
  const encoded = JSON.stringify(safe);
  assert.equal(encoded.includes("sealed-blob-must-not-leak"), false);
  assert.equal(encoded.includes("hello"), true);
  assert.equal((safe.input as { credentials: string }).credentials, "[REDACTED]");
});

test("redactPublicJson shows which API key a held call names, and hides the key itself", () => {
  // The permissionRequest for apikey_delete carried input {"apikey_id": 192};
  // the approval card showed it as "[REDACTED]".
  const safe = redactPublicJson({
    type: "permissionRequest",
    tool: "mcp__safe__apikey_delete",
    input: { apikey_id: 192, apikey_name: "claw5-gate-allow", key_prefix: "ak-1a2b" },
    result: { apikey: "plain-key-value-no-shape", api_key: "another-plain-value" },
  }) as { input: Record<string, unknown>; result: Record<string, unknown> };
  assert.deepEqual(safe.input, { apikey_id: 192, apikey_name: "claw5-gate-allow", key_prefix: "ak-1a2b" });
  assert.equal(safe.result.apikey, "[REDACTED]");
  assert.equal(safe.result.api_key, "[REDACTED]");
});

test("redactPublicJson masks a Vault secret_id and a map of passwords keyed by name", () => {
  const uuid = "6a1c2f3e-0b4d-4e5f-8a9b-0c1d2e3f4a5b";
  const safe = redactPublicJson({
    type: "permissionRequest",
    input: {
      secret_id: uuid,
      SecretID: uuid,
      VAULT_SECRET_ID: uuid,
      passwords_by_name: { prod: "XkjQmzPl" },
      secrets_by_id: { "7": "XkjQmzPl" },
      apikey_id: ["XkjQmzPl"],
    },
  }) as { input: Record<string, unknown> };
  const encoded = JSON.stringify(safe);
  assert.ok(!encoded.includes(uuid), encoded);
  assert.ok(!encoded.includes("XkjQmzPl"), encoded);
  for (const key of Object.keys(safe.input)) assert.equal(safe.input[key], "[REDACTED]", key);
});

// node-postgres hands a timestamptz back as a Date. `redactPublicJson` used to walk it like a
// plain object and answer `{}`, so every task and session time in a public answer came back
// empty (seen on `GET /v1/tasks/:id` of a deleted session's run). A Date keeps the JSON a
// client would have got without redaction: its ISO string, or null when it is invalid.
test("redactPublicJson keeps a Date as the ISO string JSON would carry", () => {
  const at = new Date("2026-11-07T16:08:57.677Z");
  const safe = redactPublicJson({ at, list: [at], nested: { at }, bad: new Date(Number.NaN) });
  assert.deepEqual(safe, {
    at: "2026-11-07T16:08:57.677Z",
    list: ["2026-11-07T16:08:57.677Z"],
    nested: { at: "2026-11-07T16:08:57.677Z" },
    bad: null,
  });
  assert.equal(redactPublicJson(at), "2026-11-07T16:08:57.677Z");
});

test("publicTaskRow and publicSessionRow keep the row's times", () => {
  const created = new Date("2026-11-07T16:06:07.000Z");
  const task = publicTaskRow({
    task_id: "ktsk_1",
    created_at: created,
    started_at: created,
    completed_at: null,
  } as unknown as ClawTaskRow) as unknown as Record<string, unknown>;
  assert.equal(task.created_at, "2026-11-07T16:06:07.000Z");
  assert.equal(task.started_at, "2026-11-07T16:06:07.000Z");
  assert.equal(task.completed_at, null);
  const session = publicSessionRow({ session_id: "s1", created_at: created, updated_at: created });
  assert.equal(session.created_at, "2026-11-07T16:06:07.000Z");
  assert.equal(session.updated_at, "2026-11-07T16:06:07.000Z");
});

test("a deleted session's task answers its times, not empty objects", async () => {
  const { deletedSessionTaskView } = await import("../src/routes/tasks.js");
  const view = deletedSessionTaskView({
    task_id: "ktsk_1",
    session_id: "845d5367-f159-4e03-b2cc-669fea227916",
    status: "cancelled",
    failure_reason: "session_deleted",
    error_message: null,
    created_at: new Date("2026-11-07T16:06:07.000Z"),
    started_at: new Date("2026-11-07T16:06:21.000Z"),
    completed_at: new Date("2026-11-07T16:08:57.677Z"),
  } as unknown as ClawTaskRow);
  assert.equal(view.created_at, "2026-11-07T16:06:07.000Z");
  assert.equal(view.started_at, "2026-11-07T16:06:21.000Z");
  assert.equal(view.completed_at, "2026-11-07T16:08:57.677Z");
  assert.equal(view.status, "cancelled");
  assert.equal(view.session_deleted, true);
});
