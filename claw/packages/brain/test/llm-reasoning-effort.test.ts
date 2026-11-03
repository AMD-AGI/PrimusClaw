// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run's reasoning effort (`ExecuteRequest.effort`): what each provider puts on the wire for it, that it reaches every turn of the
 * loop and of its sub-agents, and that a run without one sends exactly what it sent before the field existed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ReasoningEffort, ToolSchema } from "@claw/protocol";
import { buildAnthropicSession } from "../src/llm/anthropic-provider.js";
import { buildOpenAiSession } from "../src/llm/openai-provider.js";
import { getProvider } from "../src/llm/index.js";
import type { LlmSession, LlmSessionOptions, LlmTurnResult } from "../src/llm/provider.js";
import { agentLoop } from "../src/agent/agent-loop.js";
import { ToolRouter } from "../src/tools/router.js";

type Body = Record<string, any>;
const MSGS: Message[] = [{ role: "user", content: "review it" }];
const NO_TOOLS: ToolSchema[] = [];

function anthropicStub() {
  const bodies: Body[] = [];
  const client = {
    messages: {
      create: async (body: Body) => {
        bodies.push(structuredClone(body));
        if (!body.stream) return { content: [{ type: "text", text: "summary" }] };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", message: { model: "claude-opus-5.5", usage: { input_tokens: 3 } } };
            yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
            yield { type: "content_block_stop", index: 0 };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
            yield { type: "message_stop" };
          },
        };
      },
    },
  };
  return { client: client as any, bodies };
}

function openAiStub() {
  const bodies: Body[] = [];
  const client = {
    chat: { completions: { create: async (body: Body) => {
      bodies.push(structuredClone(body));
      if (!body.stream) return { choices: [{ message: { content: "summary" } }] };
      return {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: "ok" }, finish_reason: null }] };
          yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } };
        },
      };
    } } },
  };
  return { client: client as any, bodies };
}

const EFFORT_KEYS = ["thinking", "output_config", "reasoning_effort"];

test("Anthropic: every streamed turn asks for adaptive thinking at the run's effort; a run without one sends neither field", async () => {
  for (const effort of ["low", "medium", "high"] as const) {
    const { client, bodies } = anthropicStub();
    const session = buildAnthropicSession(client, "claude-opus-5.5", {}, effort);
    await session.streamTurn(MSGS, NO_TOOLS);
    await session.streamTurn(MSGS, NO_TOOLS);
    for (const b of bodies) {
      assert.deepEqual(b.thinking, { type: "adaptive" }, effort);
      assert.deepEqual(b.output_config, { effort }, effort);
    }
    // A compaction or summary call keeps its own knobs: the run's effort is not spent on it.
    await session.complete("sys", "text", 100);
    assert.equal(EFFORT_KEYS.some((k) => k in bodies[2]!), false, `${effort}: complete() is not the run's turn`);
  }
  const { client, bodies } = anthropicStub();
  await buildAnthropicSession(client, "claude-opus-5.5").streamTurn(MSGS, NO_TOOLS);
  assert.equal(EFFORT_KEYS.some((k) => k in bodies[0]!), false);
});

test("OpenAI: every streamed turn carries reasoning_effort; a run without one does not", async () => {
  const { client, bodies } = openAiStub();
  await buildOpenAiSession(client, "gpt-6-luna", {}, "high").streamTurn(MSGS, NO_TOOLS);
  assert.equal(bodies[0]?.reasoning_effort, "high");
  const plain = openAiStub();
  await buildOpenAiSession(plain.client, "gpt-6-luna").streamTurn(MSGS, NO_TOOLS);
  assert.equal(EFFORT_KEYS.some((k) => k in plain.bodies[0]!), false);
});

function turn(content: LlmTurnResult["content"], stopReason: LlmTurnResult["stopReason"]): LlmTurnResult {
  return { content, stopReason, usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1 } as unknown as LlmTurnResult;
}

test("the loop opens its LLM session at the run's effort, and a sub-agent it starts opens its own at the same effort", async () => {
  const provider = getProvider();
  const original = provider.createSession;
  try {
    for (const effort of ["high", undefined] as Array<ReasoningEffort | undefined>) {
      const opened: LlmSessionOptions[] = [];
      provider.createSession = (opts: LlmSessionOptions): LlmSession => {
        opened.push(opts);
        const parent = opened.length === 1;
        let n = 0;
        return {
          async streamTurn() {
            n++;
            if (parent && n === 1) {
              return turn([{ type: "tool_use", id: "t1", name: "task", input: { description: "second pass", prompt: "find what was missed", subagent_type: "readonly", tools: [] } }] as any, "tool_use");
            }
            return turn([{ type: "text", text: "done" }] as any, "end_turn");
          },
          async complete() { return "summary"; },
        } as unknown as LlmSession;
      };
      const tools: ToolSchema[] = [{ name: "task", description: "sub-agent", input_schema: { type: "object" } }];
      const hands = {} as any;
      await agentLoop([{ role: "user", content: "review it" }], tools, {
        model: "claude-opus-5.5", apiUrl: "http://gateway.invalid", apiKey: "k", maxTurns: 4,
        router: new ToolRouter(hands, new Map()), onEvent: async () => {}, depth: 0, hands,
        ...(effort ? { effort } : {}),
      });
      assert.equal(opened.length, 2, "the run's session and the sub-agent's");
      assert.deepEqual(opened.map((o) => o.effort), [effort, effort]);
    }
  } finally {
    provider.createSession = original;
  }
});
