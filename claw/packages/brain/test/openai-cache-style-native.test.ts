// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The native dialect, driven through the provider.
//
// LLM_CACHE_STYLE is read at module load, so the native branch needs its own
// file -- and until it had one, nothing exercised it at provider level. The
// load-bearing claim is that the request-level opt-in "travels with the
// messages so the two cannot be sent apart", and the only coverage was a
// direct renderer call with the style passed as an argument plus an assertion
// that PROMPT_CACHE_OPTIONS equals its own literal, which would still pass if
// the provider never attached it. That is a consumer test standing in for a
// producer test: it proves the value is right, not that anything sends it.

import test from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";

process.env.LLM_API_STYLE = "openai";
process.env.LLM_CACHE_STYLE = "native";
process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
const { buildOpenAiSession } = await import("../src/llm/openai-provider.js");

function stub() {
  const bodies: Array<Record<string, any>> = [];
  const client = { chat: { completions: { create: async (b: any) => {
    bodies.push(JSON.parse(JSON.stringify(b)));
    return { async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: "ok" }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } };
    } };
  } } } } as any;
  return { client, bodies };
}
const LONG: Message[] = [{ role: "user", content: "the task prompt ".repeat(40) }];

test("the request carries prompt_cache_options alongside the breakpoints", async () => {
  // Breakpoints without the opt-in are accepted and ignored: caching that
  // looks configured and bills as if it is not. This is the assertion that
  // makes them inseparable.
  const { client, bodies } = stub();
  const res = await buildOpenAiSession(client, "gpt-4o").streamTurn(LONG, [] as ToolSchema[], undefined);
  assert.ok((res.cacheReport?.breakpointsSent ?? 0) > 0, "precondition: markers went out");
  assert.deepEqual(bodies[0].prompt_cache_options, { mode: "explicit" });
  assert.ok(JSON.stringify(bodies[0].messages).includes("prompt_cache_breakpoint"),
    "and in the native dialect, not cache_control");
});

test("a turn that places no breakpoint sends no opt-in either", async () => {
  // The key is meaningless without a breakpoint to qualify, and handing a
  // cache parameter to an endpoint on a request that asks for no caching is
  // how a deployment gets a 400 it did not buy anything with. An assistant
  // that only calls tools projects to no markable position at all.
  const { client, bodies } = stub();
  const noneMarkable: Message[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "c0", name: "bash", input: { command: "x" } }] } as any,
  ];
  const res = await buildOpenAiSession(client, "gpt-4o").streamTurn(noneMarkable, [] as ToolSchema[], undefined);
  assert.equal(res.cacheReport?.breakpointsSent, 0, "precondition: nothing markable");
  assert.equal(bodies[0].prompt_cache_options, undefined);
});
