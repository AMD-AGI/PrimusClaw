// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// prompt-size-unknown.test.ts
//
// A provider that reports no usage and one reporting zero are different facts,
// and the compaction trigger cannot tell them apart through `??` -- 0 is not
// nullish. That matters because compaction is the only context-size guard in
// Brain: a run whose prompt size is never measured keeps growing with nothing
// watching it, until the model rejects the request with a 400 that
// streamTurnWithRetry does not retry.
//
// So the providers now say `undefined` when no usage arrived, and a turn
// nobody could measure is counted instead of passing silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { buildAnthropicSession } from "../src/llm/anthropic-provider.js";
import { buildOpenAiSession } from "../src/llm/openai-provider.js";
import { registry } from "../src/infra/metrics.js";

async function unknownCount(): Promise<number> {
  const m = registry.getSingleMetric("claw_brain_prompt_size_unknown_total");
  if (!m) return NaN;
  return (await m.get()).values[0]?.value ?? 0;
}

/** An Anthropic stream whose message_start carries no usage at all. */
function anthropicStreamNoUsage() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { model: "m" } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
      yield { type: "message_stop" };
    },
  };
}

test("the Anthropic provider says undefined, not zero, when no usage arrived", async () => {
  const client = { messages: { create: async () => anthropicStreamNoUsage() } } as any;
  const res = await buildAnthropicSession(client, "m")
    .streamTurn([{ role: "user", content: "hi" }], [] as ToolSchema[], undefined);
  assert.equal(res.promptTokens, undefined, "0 here would read as an empty prompt");
});

test("the Anthropic provider still reports a real size when usage arrives", async () => {
  const client = {
    messages: {
      create: async () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "message_start", message: { model: "m", usage: { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 } } };
          yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
          yield { type: "message_stop" };
        },
      }),
    },
  } as any;
  const res = await buildAnthropicSession(client, "m")
    .streamTurn([{ role: "user", content: "hi" }], [] as ToolSchema[], undefined);
  assert.equal(res.promptTokens, 1005, "input + read + create, because input is the remainder");
});

test("the OpenAI provider says undefined when the gateway omits usage", async () => {
  // stream_options.include_usage is requested, but not every OpenAI-compatible
  // gateway honours it.
  const client = {
    chat: { completions: { create: async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "ok" }, finish_reason: null }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    }) } },
  } as any;
  const res = await buildOpenAiSession(client, "gpt-4o")
    .streamTurn([{ role: "user", content: "hi" }], [] as ToolSchema[], undefined);
  assert.equal(res.promptTokens, undefined);
});

test("a turn nobody could measure is counted instead of passing silently", async () => {
  const before = await unknownCount();
  const session: LlmSession = {
    async streamTurn() {
      return {
        content: [], stopReason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
      } as LlmTurnResult;
    },
    async complete() { return "s"; },
  };
  const opts: LoopOptions = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 1,
    router: ({ route: async () => "ok", setHands: () => {} }) as unknown as ToolRouter,
    sessionId: "s", userId: "u", llmSession: session, onEvent: async () => {},
  };
  await agentLoop([{ role: "user", content: "hi" } as Message], [] as ToolSchema[], opts);
  assert.equal(await unknownCount(), before + 1);
});

test("a measured turn is not counted as unknown", async () => {
  const before = await unknownCount();
  const session: LlmSession = {
    async streamTurn() {
      return {
        content: [], stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 1, cache_create: 0, cache_read: 0 },
        firstByteMs: 1, promptTokens: 10,
      } as LlmTurnResult;
    },
    async complete() { return "s"; },
  };
  const opts: LoopOptions = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 1,
    router: ({ route: async () => "ok", setHands: () => {} }) as unknown as ToolRouter,
    sessionId: "s", userId: "u", llmSession: session, onEvent: async () => {},
  };
  await agentLoop([{ role: "user", content: "hi" } as Message], [] as ToolSchema[], opts);
  assert.equal(await unknownCount(), before);
});
