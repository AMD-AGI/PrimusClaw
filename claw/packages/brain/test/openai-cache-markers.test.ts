// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// openai-cache-markers.test.ts
//
// Markers on the OpenAI-shaped wire, opted into by LLM_CACHE_STYLE=anthropic.
// Read at module load, so this file owns that branch.
//
// The shapes here are the ones toOpenAiMessages actually produces, which is
// why planning happens after the transform: a canonical user message holding
// N tool_result blocks becomes N role:"tool" messages, tool_use blocks vanish
// into tool_calls where no content part exists, and an assistant turn that
// only called tools comes out with content: null.

import test from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";

process.env.LLM_API_STYLE = "openai";
process.env.LLM_CACHE_STYLE = "anthropic";
process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
const { buildOpenAiSession, toOpenAiMessages } = await import("../src/llm/openai-provider.js");
const { planOpenAiCacheBreakpoints } = await import("../src/llm/openai-cache.js");
const { MAX_STRIDE_BLOCKS } = await import("../src/llm/cache-plan.js");
const { renderOpenAiCacheMarkers, renderPlannedOpenAiMarkers } = await import("../src/llm/openai-cache.js");
const { MAX_BREAKPOINTS } = await import("../src/llm/cache-plan.js");

function stub() {
  const bodies: Array<Record<string, any>> = [];
  return {
    bodies,
    client: { chat: { completions: { create: async (b: Record<string, any>) => {
      bodies.push(JSON.parse(JSON.stringify(b)));
      return { async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "ok" }, finish_reason: null }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 1,
                         prompt_tokens_details: { cached_tokens: 0 } } };
      } };
    } } } } as any,
  };
}

function convo(turns = 6): Message[] {
  const out: Message[] = [{ role: "user", content: "the task ".repeat(30) }];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "bash", input: {} }] });
    out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "ok" }] });
  }
  out.push({ role: "assistant", content: [{ type: "text", text: "summary" }] });
  return out;
}

function markers(body: Record<string, any>): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const m of body.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) if (p && p.cache_control) out.push({ role: m.role, part: p });
  }
  return out;
}

test("markers reach the wire when the deployment declares an Anthropic backend", async () => {
  const { client, bodies } = stub();
  await buildOpenAiSession(client, "claude-opus-4.5").streamTurn(convo(), [] as ToolSchema[], undefined);
  const found = markers(bodies[0]);
  assert.ok(found.length > 0, "no cache_control reached the wire");
  assert.ok(found.length <= MAX_BREAKPOINTS, `${found.length} markers, over the cap`);
  assert.deepEqual(found[0].part.cache_control, { type: "ephemeral", ttl: "1h" });
});

test("a marked string content is widened into a text part, not left a string", async () => {
  // A marker cannot ride on a plain string. Measured against the gateway, the
  // parts form is accepted transparently: identical token counts and output,
  // the only difference being the cache accounting.
  const { client, bodies } = stub();
  await buildOpenAiSession(client, "claude-opus-4.5").streamTurn(convo(), [] as ToolSchema[], undefined);
  const first = bodies[0].messages[0];
  assert.ok(Array.isArray(first.content));
  assert.equal(first.content[0].type, "text");
  assert.ok(String(first.content[0].text).startsWith("the task"), "the text must survive widening");
});

test("no marker lands on a role:'tool' message", async () => {
  // Excluded until a gateway is confirmed to honour one there. An unverified
  // marker is worse than a missing one: counted as sent, buying nothing.
  const { client, bodies } = stub();
  await buildOpenAiSession(client, "claude-opus-4.5").streamTurn(convo(), [] as ToolSchema[], undefined);
  for (const m of bodies[0].messages) {
    if (m.role !== "tool") continue;
    assert.equal(JSON.stringify(m).includes("cache_control"), false);
  }
});

test("an assistant turn that only called tools carries no marker", async () => {
  // toOpenAiMessages gives it content: null -- there is nothing to widen
  // without inventing text the model never wrote.
  const wire = toOpenAiMessages([
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "c", name: "bash", input: {} }] },
  ]);
  const nullContent = wire.find((m: any) => m.role === "assistant");
  assert.equal((nullContent as any).content, null, "precondition: the transform yields null");
  const out = renderOpenAiCacheMarkers(wire as any, { style: "anthropic", ttl: "1h" });
  assert.equal(JSON.stringify(out.messages[1]).includes("cache_control"), false);
});

test("the count comes off the rendered messages, not the plan", async () => {
  const { client, bodies } = stub();
  const res = await buildOpenAiSession(client, "claude-opus-4.5")
    .streamTurn(convo(), [] as ToolSchema[], undefined);
  assert.equal(res.cacheReport?.breakpointsSent, markers(bodies[0]).length);
  assert.equal(res.cacheReport?.enabled, true);
});

test("the native dialect uses prompt_cache_breakpoint, not cache_control", () => {
  // Genuine OpenAI reads a different key in the same slot. cache_control is
  // not in its type system at all.
  const wire = toOpenAiMessages([{ role: "user", content: "hello ".repeat(30) }]);
  const out = renderOpenAiCacheMarkers(wire as any, { style: "native", ttl: "1h" });
  const s = JSON.stringify(out.messages);
  assert.ok(s.includes("prompt_cache_breakpoint"));
  assert.equal(s.includes("cache_control"), false);
});

test("rendering does not mutate the wire messages handed in", () => {
  const wire = toOpenAiMessages(convo());
  const before = JSON.stringify(wire);
  renderOpenAiCacheMarkers(wire as any, { style: "anthropic", ttl: "1h" });
  assert.equal(JSON.stringify(wire), before);
});

test("5m renders the bare marker, 1h carries the ttl", () => {
  const wire = toOpenAiMessages([{ role: "user", content: "hello ".repeat(30) }]);
  const five = renderOpenAiCacheMarkers(wire as any, { style: "anthropic", ttl: "5m" });
  const oneH = renderOpenAiCacheMarkers(wire as any, { style: "anthropic", ttl: "1h" });
  assert.ok(JSON.stringify(five.messages).includes('"cache_control":{"type":"ephemeral"}'));
  assert.ok(JSON.stringify(oneH.messages).includes('"ttl":"1h"'));
});

test("a tool message at the tail can carry the rolling marker", () => {
  // The tail of an agent turn is routinely a tool message, and a tool loop is
  // made almost entirely of tool results and assistants that only call tools.
  // Excluding tool messages left the rolling walk with nowhere legal to land
  // anywhere near the tail, which is how 52 wire messages produced two
  // breakpoints and both of them at the head.
  //
  // The gateway turns a tool message into an Anthropic `tool_result` block,
  // which the native path already marks in production. This wire's
  // translation is not independently verified -- neither is any other marker
  // on it, which is why the whole path is opt-in.
  const wire = toOpenAiMessages([
    { role: "user", content: "the task ".repeat(30) },
    { role: "assistant", content: [{ type: "tool_use", id: "c0", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c0", content: "ok" }] },
  ]);
  assert.equal((wire[wire.length - 1] as any).role, "tool", "precondition: the tail is a tool message");
  const out = renderOpenAiCacheMarkers(wire as any, { style: "anthropic", ttl: "1h" });
  assert.ok(out.breakpointsApplied > 0);
  assert.ok(
    out.messages.some((m: any) => m.role === "tool" && JSON.stringify(m).includes("cache_control")),
    "the tail is reachable",
  );
});

test("a message that cannot hold a marker still costs stride", () => {
  // An assistant that only calls tools has null content and can carry nothing.
  // Projecting it to no blocks made it free, and the planner then spread its
  // markers well past the block budget it believes it is keeping.
  const toolTurn = (i: number) => ([
    { role: "assistant" as const, content: [{ type: "tool_use", id: `c${i}`, name: "bash", input: {} }] },
    { role: "user" as const, content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "ok" }] },
  ]);
  const convo: any[] = [{ role: "user", content: "the task ".repeat(30) }];
  for (let i = 0; i < 25; i++) convo.push(...toolTurn(i));
  const wire = toOpenAiMessages(convo);
  const plan = planOpenAiCacheBreakpoints(wire as any, { ttl: "1h" });

  assert.ok(wire.length > 40, `precondition: a long tool loop (${wire.length} messages)`);
  assert.ok(plan.breakpoints.length >= 3, `rolling markers must roll, got ${plan.breakpoints.length}`);
  const last = plan.breakpoints[plan.breakpoints.length - 1].messageIndex;
  assert.ok(last > wire.length - 12, `the newest marker must be near the tail, got ${last}/${wire.length}`);

  // The budget is 18 BLOCKS, and on this wire one message is one block. If an
  // unmarkable message costs nothing, two markers 36 messages apart still look
  // like 18 to the planner -- past the 20-block lookback, where the chain
  // silently ends. Measured in real messages, the distance has to hold.
  const idx = plan.breakpoints.map((b) => b.messageIndex).sort((a, b) => a - b);
  for (let i = 1; i < idx.length; i++) {
    assert.ok(
      idx[i] - idx[i - 1] <= MAX_STRIDE_BLOCKS,
      `markers ${idx[i - 1]}->${idx[i]} are ${idx[i] - idx[i - 1]} messages apart, budget ${MAX_STRIDE_BLOCKS}`,
    );
  }
});

test("a marker the plan asks for but the renderer refuses is not counted", () => {
  // Plan and render cannot disagree on any input the projection produces --
  // it hides every position the renderer refuses. Injecting a plan that points
  // at a null-content assistant is the only way to exercise the shortfall, and that
  // shortfall is the regression breakpointsApplied exists to catch.
  const wire = toOpenAiMessages([
    { role: "user", content: "prompt ".repeat(30) },
    { role: "assistant", content: [{ type: "tool_use", id: "c0", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c0", content: "ok" }] },
  ]);
  // An assistant that only calls tools: content null, nothing to widen.
  const toolIdx = wire.findIndex((m: any) => m.role === "assistant" && m.content == null);
  const bogus = {
    ttl: "1h" as const, systemRunLength: 0,
    breakpoints: [
      { kind: "message" as const, messageIndex: 0, blockIndex: 0, wrapStringContent: true },
      { kind: "message" as const, messageIndex: toolIdx, blockIndex: 0, wrapStringContent: true },
    ],
  };
  const out = renderPlannedOpenAiMarkers(wire as any, bogus, { style: "anthropic", ttl: "1h" });
  assert.equal(out.breakpointsApplied, 1, "the refused marker must not be counted");
  assert.equal(JSON.stringify(out.messages[toolIdx]).includes("cache_control"), false);
});
