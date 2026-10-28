// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A replayed tool call whose input is not a JSON object poisons a session.
 *
 * The model endpoint refuses the whole request ("Assistant tool call
 * function.arguments must be a JSON object" / "tool_use.input: Input should be
 * an object"), the history is replayed in full on every turn, and so every
 * later turn fails in about two seconds, forever. Reported from a session whose
 * stored history carried the string "<redacted>" as a tool call's input.
 *
 * These tests read the bytes that go out on each wire, which is the only place
 * the endpoint's rule can be checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Message, ToolSchema } from "@claw/protocol";

import { OpenAiProvider, toOpenAiMessages } from "../src/llm/openai-provider.js";
import { buildAnthropicSession } from "../src/llm/anthropic-provider.js";
import {
  looksLikeToolArgumentsRejection,
  parseToolArguments,
  sanitizeToolUseInputs,
} from "../src/llm/tool-input.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { registry } from "../src/infra/metrics.js";

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every shape a stored or streamed tool input can take that is not an object. */
const badInputs: Array<{ name: string; input: unknown }> = [
  { name: "redaction placeholder string", input: "<redacted>" },
  { name: "string holding JSON text", input: '{"limit":5}' },
  { name: "truncated JSON text", input: '{"limit":' },
  { name: "empty string", input: "" },
  { name: "array", input: [1, 2] },
  { name: "empty array", input: [] },
  { name: "number", input: 7 },
  { name: "boolean", input: true },
  { name: "null", input: null },
  { name: "undefined", input: undefined },
];

/** An assistant turn with three calls (the poisoned one in the middle) and its results. */
function history(badInput: unknown): Message[] {
  return [
    { role: "user", content: "list my keys" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "call_read", name: "read", input: { path: "/a" } },
        { type: "tool_use", id: "call_bad", name: "mcp__safe__apikey_list", input: badInput },
        { type: "tool_use", id: "call_bash", name: "bash", input: { command: "ls" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_read", content: "r1" },
        { type: "tool_result", tool_use_id: "call_bad", content: "r2" },
        { type: "tool_result", tool_use_id: "call_bash", content: "r3" },
      ],
    },
    { role: "user", content: "and now?" },
  ];
}

// ---------------------------------------------------------------- OpenAI wire

for (const c of badInputs) {
  test(`toOpenAiMessages sends object arguments and keeps the pairing: ${c.name}`, () => {
    const wire = toOpenAiMessages(history(c.input)) as unknown as Array<Obj>;
    const assistant = wire.find((m) => m.role === "assistant") as Obj;
    const calls = assistant.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
    assert.deepEqual(calls.map((t) => t.id), ["call_read", "call_bad", "call_bash"]);
    for (const t of calls) {
      assert.equal(typeof t.function.arguments, "string");
      assert.ok(isObject(JSON.parse(t.function.arguments)), `${t.id}: arguments must decode to an object`);
    }
    // Untouched calls are byte-identical to before.
    assert.equal(calls[0].function.arguments, '{"path":"/a"}');
    assert.equal(calls[2].function.arguments, '{"command":"ls"}');
    // Every tool call still has its answer.
    const answered = wire.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    assert.deepEqual(answered, ["call_read", "call_bad", "call_bash"]);
  });
}

/** One SSE response per request; records every request body. */
async function withGateway(
  respond: (n: number, body: Obj) => { status: number; sse?: string; json?: Obj },
  run: (baseUrl: string, bodies: Obj[]) => Promise<void>,
): Promise<void> {
  const bodies: Obj[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Obj;
      bodies.push(body);
      const out = respond(bodies.length, body);
      if (out.json) {
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
      } else {
        res.writeHead(out.status, { "content-type": "text/event-stream" });
        res.end(out.sse);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const chunk = (o: Obj) => `data: ${JSON.stringify(o)}\n\n`;
function toolCallStream(args: string[]): string {
  const frames = args.map((a, i) => chunk({
    id: "1", model: "m",
    choices: [{ index: 0, delta: { tool_calls: [{
      index: 0,
      ...(i === 0 ? { id: "call_1", type: "function" } : {}),
      function: { ...(i === 0 ? { name: "mcp__safe__apikey_list" } : {}), arguments: a },
    }] } }],
  }));
  return frames.join("")
    + chunk({ id: "1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    + "data: [DONE]\n\n";
}
const textStream = () =>
  chunk({ id: "1", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })
  + chunk({ id: "1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  + "data: [DONE]\n\n";

const openAiSession = (baseUrl: string) => new OpenAiProvider().createSession({
  model: "m", apiUrl: baseUrl, apiKey: "k", userId: "u", sessionId: "s",
});

for (const c of badInputs) {
  test(`the OpenAI request body that goes out has object arguments: ${c.name}`, async () => {
    await withGateway(() => ({ status: 200, sse: textStream() }), async (baseUrl, bodies) => {
      await openAiSession(baseUrl).streamTurn(history(c.input), [], undefined);
      assert.equal(bodies.length, 1);
      const sent = bodies[0].messages as Array<Obj>;
      const calls = sent.flatMap((m) => (m.tool_calls as Array<{ function: { arguments: string } }> | undefined) ?? []);
      assert.equal(calls.length, 3);
      for (const t of calls) assert.ok(isObject(JSON.parse(t.function.arguments)));
    });
  });
}

// What a backend can stream for a call with no arguments, and what the stored
// block must be. Valid JSON that is not an object used to be stored as-is.
const streamedArgs: Array<{ name: string; chunks: string[]; want: Obj }> = [
  { name: "no argument fragments", chunks: [""], want: {} },
  { name: "empty object", chunks: ["{}"], want: {} },
  { name: "empty array", chunks: ["[]"], want: {} },
  { name: "split empty array", chunks: ["[", "]"], want: {} },
  { name: "null", chunks: ["null"], want: {} },
  { name: "bare string", chunks: ['"abc"'], want: { value: "abc" } },
  { name: "non-empty array", chunks: ["[1,2]"], want: { value: [1, 2] } },
  { name: "split object", chunks: ['{"limit"', ":5}"], want: { limit: 5 } },
];

for (const c of streamedArgs) {
  test(`a streamed tool call is stored as an object: ${c.name}`, async () => {
    await withGateway(() => ({ status: 200, sse: toolCallStream(c.chunks) }), async (baseUrl) => {
      const res = await openAiSession(baseUrl).streamTurn([{ role: "user", content: "hi" }], [], undefined);
      const use = res.content.find((b) => b.type === "tool_use") as { input: unknown };
      assert.ok(use, "the tool call must survive");
      assert.deepEqual(use.input, c.want);
      assert.ok(isObject(use.input));
    });
  });
}

test("a cut-off stream is still a failed parse, not a silently coerced call (OpenAI)", async () => {
  await withGateway(() => ({ status: 200, sse: toolCallStream(['{"limit"', ":"]) }), async (baseUrl) => {
    await assert.rejects(
      openAiSession(baseUrl).streamTurn([{ role: "user", content: "hi" }], [], undefined),
      (err: unknown) => (err as { code?: string }).code === "TOOL_INPUT_PARSE_FAILED",
    );
  });
});

// -------------------------------------------------------------- Anthropic wire

function anthropicStub() {
  const bodies: Obj[] = [];
  const client = {
    messages: {
      create: async (body: Obj) => {
        bodies.push(structuredClone(body));
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } };
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

for (const c of badInputs) {
  test(`the Anthropic request body that goes out has object inputs: ${c.name}`, async () => {
    const { client, bodies } = anthropicStub();
    await buildAnthropicSession(client, "m").streamTurn(history(c.input), [], undefined);
    assert.equal(bodies.length, 1);
    const uses = (bodies[0].messages as Array<Obj>)
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Obj[]) : []))
      .filter((b) => b.type === "tool_use");
    assert.deepEqual(uses.map((u) => u.id), ["call_read", "call_bad", "call_bash"]);
    for (const u of uses) assert.ok(isObject(u.input), `${String(u.id)} input must be an object`);
    const results = (bodies[0].messages as Array<Obj>)
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Obj[]) : []))
      .filter((b) => b.type === "tool_result");
    assert.deepEqual(results.map((r) => r.tool_use_id), ["call_read", "call_bad", "call_bash"]);
  });
}

function anthropicToolStream(partials: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__safe__apikey_list", input: {} } };
      for (const p of partials) yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: p } };
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } };
      yield { type: "message_stop" };
    },
  };
}

for (const c of streamedArgs.filter((s) => s.chunks[0] !== "")) {
  test(`an Anthropic streamed tool_use is stored as an object: ${c.name}`, async () => {
    const client = { messages: { create: async () => anthropicToolStream(c.chunks) } } as any;
    const res = await buildAnthropicSession(client, "m").streamTurn([{ role: "user", content: "hi" }], [], undefined);
    const use = res.content.find((b) => b.type === "tool_use") as { input: unknown };
    assert.deepEqual(use.input, c.want);
  });
}

test("a cut-off stream is still a failed parse, not a silently coerced call (Anthropic)", async () => {
  const client = { messages: { create: async () => anthropicToolStream(['{"limit"', ":"]) } } as any;
  await assert.rejects(
    buildAnthropicSession(client, "m").streamTurn([{ role: "user", content: "hi" }], [], undefined),
    (err: unknown) => (err as { code?: string }).code === "TOOL_INPUT_PARSE_FAILED",
  );
});

// ------------------------------------------------------------------ the helpers

test("parseToolArguments separates a cut-off stream from a wrong-typed answer", () => {
  assert.deepEqual(parseToolArguments(""), { input: {}, malformed: false });
  assert.deepEqual(parseToolArguments('{"a":1}'), { input: { a: 1 }, malformed: false });
  assert.deepEqual(parseToolArguments("[]"), { input: {}, malformed: false });
  assert.deepEqual(parseToolArguments('{"a":'), { input: { _raw: '{"a":' }, malformed: true });
});

test("sanitizeToolUseInputs is copy-on-change and never touches the caller's history", () => {
  const clean = history({ q: 1 });
  const same = sanitizeToolUseInputs(clean);
  assert.equal(same.repaired, 0);
  assert.equal(same.messages, clean, "a clean history comes back as the same array");

  const dirty = history("<redacted>");
  const snapshot = structuredClone(dirty);
  const out = sanitizeToolUseInputs(dirty);
  assert.equal(out.repaired, 1);
  assert.deepEqual(dirty, snapshot, "the input history is not mutated");
  assert.notEqual(out.messages, dirty);
  assert.equal(out.messages[0], dirty[0], "untouched messages are passed through by reference");
  const uses = (out.messages[1].content as Obj[]).filter((b) => b.type === "tool_use");
  assert.deepEqual(uses.map((u) => u.id), ["call_read", "call_bad", "call_bash"]);
  assert.deepEqual(uses[1].input, { value: "<redacted>" });
  assert.equal(out.messages[2], dirty[2], "the tool_result message is the same object");
});

test("looksLikeToolArgumentsRejection reads both wires' wording and nothing else", () => {
  const openai = Object.assign(new Error("400 Assistant tool call function.arguments must be a JSON object."), { status: 400 });
  const anthropic = new Error('{"error":{"message":"messages.53.content.4.tool_use.input: Input should be an object"}}');
  const nested = { message: "400 bad", error: { error: { message: "x tool_use.input: Input should be an object y" } } };
  assert.equal(looksLikeToolArgumentsRejection(openai), true);
  assert.equal(looksLikeToolArgumentsRejection(anthropic), true);
  assert.equal(looksLikeToolArgumentsRejection(nested), true);
  assert.equal(looksLikeToolArgumentsRejection(new Error("429 rate limited")), false);
  assert.equal(looksLikeToolArgumentsRejection(new Error("cache_control not supported")), false);
  assert.equal(looksLikeToolArgumentsRejection(undefined), false);
  assert.equal(looksLikeToolArgumentsRejection(null), false);
});

// ------------------------------------------------------- the sanitizing retry

const usage = { input_tokens: 10, output_tokens: 1, cache_create: 0, cache_read: 0 };
const REJECTION = Object.assign(
  new Error("400 Assistant tool call function.arguments must be a JSON object."),
  { status: 400 },
);

/** A session with no coercion of its own, so the loop's retry is what gets exercised. */
function refusingSession(refusals: number) {
  const sent: Message[][] = [];
  const session: LlmSession = {
    async streamTurn(messages) {
      sent.push(structuredClone(messages));
      const bad = messages.some((m) => Array.isArray(m.content)
        && (m.content as Obj[]).some((b) => b.type === "tool_use" && !isObject(b.input)));
      if (bad && sent.length <= refusals) throw REJECTION;
      if (refusals > 0 && sent.length <= refusals) throw REJECTION;
      return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage, firstByteMs: 1, promptTokens: 10 } as unknown as LlmTurnResult;
    },
    async complete() { return "summary"; },
  };
  return { session, sent };
}

function loopOptions(session: LlmSession): LoopOptions {
  return {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 10, depth: 0,
    router: ({ route: async () => "tool ok", setHands: () => {} }) as unknown as ToolRouter,
    sessionId: "s-poisoned", userId: "u", llmSession: session,
    onEvent: async () => {},
  };
}

async function counter(name: string, label: string, value: string): Promise<number> {
  const m = (await registry.getMetricsAsJSON()).find((x) => x.name === name);
  const v = m?.values.find((x) => (x.labels as Obj)[label] === value);
  return Number(v?.value ?? 0);
}

test("a 400 about tool-call arguments repairs the history, retries once, and counts it", async () => {
  const { session, sent } = refusingSession(1);
  const before = await counter("claw_brain_llm_tool_args_rejected_total", "outcome", "retried");
  const beforeFixed = await counter("claw_brain_llm_tool_input_repaired_total", "stage", "retry");

  const result = await agentLoop(history("<redacted>"), [] as ToolSchema[], loopOptions(session));

  assert.equal(result.finalText, "done");
  assert.equal(sent.length, 2, "one refused request, one retry");
  const usesIn = (msgs: Message[]) => msgs.flatMap((m) => Array.isArray(m.content) ? (m.content as Obj[]) : [])
    .filter((b) => b.type === "tool_use");
  assert.equal(usesIn(sent[0]).filter((u) => !isObject(u.input)).length, 1, "the first request carried the poisoned call");
  assert.ok(usesIn(sent[1]).every((u) => isObject(u.input)), "the retry carried only object inputs");
  assert.deepEqual(usesIn(sent[1]).map((u) => u.id), ["call_read", "call_bad", "call_bash"], "no call was dropped");
  const results = sent[1].flatMap((m) => Array.isArray(m.content) ? (m.content as Obj[]) : []).filter((b) => b.type === "tool_result");
  assert.deepEqual(results.map((r) => r.tool_use_id), ["call_read", "call_bad", "call_bash"], "every call kept its result");
  assert.equal(await counter("claw_brain_llm_tool_args_rejected_total", "outcome", "retried"), before + 1);
  assert.equal(await counter("claw_brain_llm_tool_input_repaired_total", "stage", "retry"), beforeFixed + 1);
});

test("the sanitizing retry happens once: a second refusal is not looped on", async () => {
  const { session, sent } = refusingSession(99);
  await assert.rejects(
    agentLoop(history("<redacted>"), [] as ToolSchema[], loopOptions(session)),
    (err: unknown) => err === REJECTION,
  );
  assert.equal(sent.length, 2, "one original request and exactly one retry");
});

test("a refusal with nothing to repair is not retried with identical bytes", async () => {
  const { session, sent } = refusingSession(99);
  const before = await counter("claw_brain_llm_tool_args_rejected_total", "outcome", "nothing_to_repair");
  await assert.rejects(
    agentLoop(history({ fine: true }), [] as ToolSchema[], loopOptions(session)),
    (err: unknown) => err === REJECTION,
  );
  assert.equal(sent.length, 1);
  assert.equal(await counter("claw_brain_llm_tool_args_rejected_total", "outcome", "nothing_to_repair"), before + 1);
});

test("an unrelated 400 does not trigger the sanitizing retry", async () => {
  const sent: number[] = [];
  const session: LlmSession = {
    async streamTurn() { sent.push(1); throw Object.assign(new Error("400 prompt is too long"), { status: 400 }); },
    async complete() { return ""; },
  };
  await assert.rejects(agentLoop(history("<redacted>"), [] as ToolSchema[], loopOptions(session)), /prompt is too long/);
  assert.equal(sent.length, 1);
});
