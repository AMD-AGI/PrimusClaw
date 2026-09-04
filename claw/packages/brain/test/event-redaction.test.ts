// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redactEgressPayload,
  redactPersistedEvent,
  redactToolEvent,
} from "../src/events/redaction.js";

test("tool event arguments redact the complete environment payload", () => {
  const event = redactToolEvent({
    type: "toolUsed",
    tool: "bash",
    status: "start",
    argumentsDetail: {
      bash: {
        command: "curl -H 'Authorization: Bearer sk-live-secret-value' https://example.com",
        env: {
          OPENAI_API_KEY: "sk-another-secret",
          NORMAL_VALUE: "visible",
        },
      },
    },
  });

  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("sk-live-secret-value"), false);
  assert.equal(serialized.includes("sk-another-secret"), false);
  assert.equal((event.argumentsDetail as any).bash.env, "<redacted>");
});

test("non-tool events are copied without content redaction", () => {
  const source = {
    type: "AssistantMessage",
    data: { content: "user-visible content" },
  };
  const result = redactToolEvent(source);
  assert.deepEqual(result, source);
  assert.notEqual(result, source);
});

test("routed_model on AssistantMessage is kept", () => {
  const event = redactPersistedEvent({
    type: "AssistantMessage",
    routed_model: "claude-haiku-4-5",
    turn: 0,
    data: { content: [{ type: "text", text: "pong" }] },
  });
  assert.equal(event.routed_model, "claude-haiku-4-5");
});

test("assistant, result, and checkpoint text redact exact runtime credentials", () => {
  const secret = "tenant-runtime-key-123";
  const event = redactPersistedEvent({
    type: "exec_complete",
    final_text: `command printed ${secret}`,
    prompt: `do not repeat ${secret}`,
  }, [secret]);
  const checkpoint = redactEgressPayload({
    messages: [{ role: "assistant", content: `observed ${secret}` }],
    turns_completed: 1,
  }, [secret]);

  assert.equal(JSON.stringify(event).includes(secret), false);
  assert.equal(JSON.stringify(checkpoint).includes(secret), false);
});

test("tool descriptions and full output are redacted, not only arguments", () => {
  const event = redactPersistedEvent({
    type: "toolUsed",
    description: "Authorization: Bearer sk-description-secret",
    full_output: { api_key: "output-secret" },
  });
  const encoded = JSON.stringify(event);
  assert.equal(encoded.includes("sk-description-secret"), false);
  assert.equal(encoded.includes("output-secret"), false);
});

test("camelCase credential keys are redacted in tool arguments and results", () => {
  // Tool arguments and MCP results are JS objects, so their keys are camelCase
  // far more often than snake_case. These values have no credential shape for
  // redactSecrets to recognise, which makes the key name the only defence.
  const event = redactPersistedEvent({
    type: "toolUsed",
    argumentsDetail: {
      login: { userPassword: "hunter2", accessToken: "plain-value-1" },
    },
    full_output: {
      refreshToken: "plain-value-2",
      openaiApiKey: "plain-value-3",
      s3: { accessKeyId: "AKIA-visible", secretAccessKey: "plain-value-4" },
    },
  });
  const encoded = JSON.stringify(event);
  for (const leaked of ["hunter2", "plain-value-1", "plain-value-2", "plain-value-3", "plain-value-4"]) {
    assert.equal(encoded.includes(leaked), false, `${leaked} must not survive`);
  }
});

test("usage counters survive redaction in both spellings", () => {
  // tokenUsage is on every ExecuteResult handed to deliverAgentDone; masking it
  // would blank the numbers the UI reports rather than protect anything.
  const state = redactEgressPayload({
    tokenUsage: { input_tokens: 12, output_tokens: 4, cache_read: 0 },
    token_usage: { prompt_tokens: 7 },
    maxTokens: 4096,
  });
  assert.deepEqual(state, {
    tokenUsage: { input_tokens: 12, output_tokens: 4, cache_read: 0 },
    token_usage: { prompt_tokens: 7 },
    maxTokens: 4096,
  });
});

test("an absent credential field keeps its shape", () => {
  const event = redactPersistedEvent({ accessToken: null, apiKey: "", sessionToken: "real" });
  assert.deepEqual(event, { accessToken: null, apiKey: "", sessionToken: "<redacted>" });
});
