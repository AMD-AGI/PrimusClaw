// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Session events are read by four client-facing surfaces: the SSE route, the
 * two MCP wait tools, and the Anthropic-compatible stream. Redaction used to
 * live in the SSE route alone, so the same session leaked more through MCP than
 * over HTTP. It now happens in events/store.ts, at the subscription every one of
 * them reads from.
 *
 * These tests pin the two halves of that contract: credential-shaped values are
 * masked, and the fields consumers route on survive untouched — a redaction that
 * rewrote `type`, `tool` or the sequence ids would break SSE dedup and the MCP
 * wait loop instead of protecting anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeSessionEvent } from "../src/events/store.js";

const BEARER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
const HEX64 = "a".repeat(64);

test("an Authorization header echoed in assistant text is masked", () => {
  const event = sanitizeSessionEvent({
    type: "AssistantMessage",
    content: [
      { type: "text", text: `retrying with Authorization: Bearer ${BEARER}` },
      { type: "text", text: "second block" },
    ],
  });

  const blocks = event.content as Array<{ type: string; text: string }>;
  assert.equal(blocks[0].text.includes(BEARER), false);
  assert.match(blocks[0].text, /Bearer <redacted>/);
  assert.equal(blocks[1].text, "second block");
});

test("an x-api-key and a raw internal token in tool output are masked", () => {
  const event = sanitizeSessionEvent({
    type: "toolUsed",
    tool: "bash",
    status: "success",
    brief: `curl -H 'x-api-key: ak-${"z".repeat(24)}' https://api.internal`,
    full_output: `CLAW_INTERNAL_TOKEN=${HEX64}\ndone`,
  });

  assert.equal((event.brief as string).includes("z".repeat(24)), false);
  assert.equal((event.full_output as string).includes(HEX64), false);
});

test("credential-bearing fields are masked by name, at any depth", () => {
  const event = sanitizeSessionEvent({
    type: "statusUpdate",
    data: {
      platform_key: "sk-platform",
      llm_api_key: "sk-user",
      user_env: { OPENAI_API_KEY: "sk-env" },
      session_env: { HF_TOKEN: "hf_env" },
      nested: { authorization: "Bearer whatever" },
    },
  });

  const data = event.data as Record<string, unknown>;
  assert.equal(data.platform_key, "[REDACTED]");
  assert.equal(data.llm_api_key, "[REDACTED]");
  assert.equal(data.user_env, "[REDACTED]");
  assert.equal(data.session_env, "[REDACTED]");
  assert.equal((data.nested as Record<string, unknown>).authorization, "[REDACTED]");
});

test("the fields consumers route on are not rewritten", () => {
  // eventName()/shouldForward() in routes/events.ts, the Anthropic event mapper
  // and the MCP wait loop all branch on these. A UUID is not a credential
  // shape, so subagent ids and session ids must survive verbatim.
  const event = sanitizeSessionEvent({
    type: "toolUsed",
    tool: "read",
    status: "success",
    brief: "read src/index.ts",
    agentStatus: "running",
    subagent_id: "sub-9f8c1a2b-0000-4000-8000-000000000001",
    event_id: "claw-4211",
    seq: 4211,
    token_usage: { input_tokens: 120, output_tokens: 8 },
  });

  assert.deepEqual(event, {
    type: "toolUsed",
    tool: "read",
    status: "success",
    brief: "read src/index.ts",
    agentStatus: "running",
    subagent_id: "sub-9f8c1a2b-0000-4000-8000-000000000001",
    event_id: "claw-4211",
    seq: 4211,
    token_usage: { input_tokens: 120, output_tokens: 8 },
  });
});

test("redaction is idempotent, so a double-masked event is unchanged", () => {
  // The SSE route no longer redacts the live path itself. If a consumer is ever
  // reinstated as a second masking layer, it must not corrupt the first one's
  // output.
  const once = sanitizeSessionEvent({
    type: "AssistantMessage",
    content: [{ type: "text", text: `Bearer ${BEARER}` }],
  });
  assert.deepEqual(sanitizeSessionEvent(once), once);
});

test("routed_model on AssistantMessage is kept", () => {
  const event = sanitizeSessionEvent({
    type: "AssistantMessage",
    routed_model: "claude-haiku-4-5",
    turn: 0,
    data: { content: [{ type: "text", text: "pong" }] },
  });
  assert.equal(event.routed_model, "claude-haiku-4-5");
  assert.equal(event.type, "AssistantMessage");
});
