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
