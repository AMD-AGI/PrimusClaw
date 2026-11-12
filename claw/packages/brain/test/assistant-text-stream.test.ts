// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The top-level loop's own text, published while the model writes it (`assistantTextDelta`, `@claw/protocol`): the streamer
 * (`AssistantTextStream`), the loop that drives it, and the time from the model's first token to the first event, measured
 * through the real Anthropic session over a scripted stream.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSISTANT_TEXT_DELTA_EVENT, ASSISTANT_TEXT_VOID_EVENT,
  type AssistantTextDeltaData, type Message, type ToolSchema,
} from "@claw/protocol";
import type { LlmContentBlock, LlmSession, LlmTurnResult, StreamTurnOptions } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { buildAnthropicSession } from "../src/llm/anthropic-provider.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { AssistantTextStream, ASSISTANT_TEXT_DELTA_INTERVAL_MS, publishableLength } from "../src/agent/assistant-text-stream.js";

type Ev = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOOLS = [
  { name: "bash", description: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } },
] as unknown as ToolSchema[];

/** Turns played in order; `during` runs inside a turn's streamTurn with the options the loop passed (what a provider would see). */
function session(turns: Array<{ content: LlmContentBlock[]; during?: (o: StreamTurnOptions | undefined) => Promise<void> }>) {
  const seen: Array<StreamTurnOptions | undefined> = [];
  let i = 0;
  const s: LlmSession = {
    async streamTurn(_m: Message[], _t: ToolSchema[], _s?: AbortSignal, options?: StreamTurnOptions): Promise<LlmTurnResult> {
      seen.push(options);
      const turn = turns[i++];
      if (!turn) throw new Error("no more turns");
      await turn.during?.(options);
      return {
        content: turn.content, stopReason: turn.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      };
    },
    async complete() { return ""; },
  };
  return { session: s, seen };
}

function opts(over: Partial<LoopOptions>): { opts: LoopOptions; events: Array<Ev & { at: number }> } {
  const events: Array<Ev & { at: number }> = [];
  return {
    events,
    opts: {
      model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 6,
      router: { route: async () => "ok", setHands: () => {} } as unknown as ToolRouter,
      onEvent: async (e: unknown) => { events.push({ ...(e as Ev), at: performance.now() }); },
      sessionId: "s", userId: "u", streamText: true,
      ...over,
    },
  };
}

const deltas = (events: Ev[]) => events.filter((e) => e.type === ASSISTANT_TEXT_DELTA_EVENT) as unknown as AssistantTextDeltaData[];

/** Each text_id's deltas joined in seq order. */
function joined(events: Ev[]): Map<string, string> {
  const out = new Map<string, string>();
  const byId = new Map<string, AssistantTextDeltaData[]>();
  for (const d of deltas(events)) byId.set(d.text_id, [...(byId.get(d.text_id) ?? []), d]);
  for (const [id, ds] of byId) {
    assert.deepEqual(ds.map((d) => d.seq), ds.map((_, i) => i), `${id}: seq is 0, 1, 2, ... in publish order`);
    out.set(id, ds.map((d) => d.delta).join(""));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the held tail

test("a trailing run of printable ASCII is held back; whitespace, other characters, or the end release it", () => {
  assert.equal(publishableLength("Hello", false), 0);
  assert.equal(publishableLength("Hello ", false), 6);
  assert.equal(publishableLength("Hello wor", false), 6);
  assert.equal(publishableLength("token ghp_abc", false), 6);
  assert.equal(publishableLength("line\nnext", false), 5);
  assert.equal(publishableLength("你好", false), 2, "CJK text is never held");
  assert.equal(publishableLength("你好abc", false), 2);
  assert.equal(publishableLength("smile 😀", false), 8);
  assert.equal(publishableLength("Hello wor", true), 9, "a complete block is published whole");
  assert.equal(publishableLength("", false), 0);
});

test("a credential split across tokens is published in one delta, so the per-event redaction sees it whole", async () => {
  const published: AssistantTextDeltaData[] = [];
  const s = new AssistantTextStream(1, async (e) => { published.push(e as AssistantTextDeltaData); }, 0);
  let text = "";
  for (const tok of ["Your token is ", "ghp_", "AAAA", "BBBB", "CCCC", " and", " more"]) {
    text += tok;
    s.options.onText({ index: 0, text });
    await sleep(1);
  }
  await s.flush();
  const secretIn = published.filter((d) => d.delta.includes("ghp_"));
  assert.equal(secretIn.length, 1);
  assert.match(secretIn[0]!.delta, /ghp_AAAABBBBCCCC/);
  assert.equal(published.map((d) => d.delta).join(""), text);
});

// ------------------------------------------------------------------------------------------------ the streamer

test("a block's first text goes out at once, later text at most once per interval, and flush publishes the rest", async () => {
  const published: Array<AssistantTextDeltaData & { at: number }> = [];
  const t0 = performance.now();
  const s = new AssistantTextStream(3, async (e) => { published.push({ ...(e as AssistantTextDeltaData), at: performance.now() - t0 }); });
  s.options.onText({ index: 0, text: "你好，" });
  s.options.onText({ index: 0, text: "你好，这是" });       // inside the interval: held until it ends
  s.options.onText({ index: 0, text: "你好，这是第一段" });
  await sleep(ASSISTANT_TEXT_DELTA_INTERVAL_MS + 30);
  s.options.onText({ index: 0, text: "你好，这是第一段。Done" });
  await s.flush();
  assert.deepEqual(published.map((d) => d.delta), ["你好，", "这是第一段", "。Done"]);
  assert.ok(published[0]!.at < 20, `first delta after ${published[0]!.at} ms`);
  assert.ok(published[1]!.at >= ASSISTANT_TEXT_DELTA_INTERVAL_MS - 5, "the second waited for the interval");
  assert.deepEqual(published.map((d) => d.seq), [0, 1, 2]);
  assert.ok(published.every((d) => d.turn === 3 && d.type === ASSISTANT_TEXT_DELTA_EVENT));
  assert.equal(s.textIds().length, 1);
  assert.ok(published.every((d) => d.text_id === s.textIds()[0]));
});

test("a slow publish holds the next one back: deltas go out one at a time and in order", async () => {
  const order: string[] = [];
  let first = true;
  const s = new AssistantTextStream(1, async (e) => {
    if (first) { first = false; await sleep(80); }
    order.push((e as AssistantTextDeltaData).delta);
  }, 0);
  s.options.onText({ index: 0, text: "a " });
  s.options.onText({ index: 0, text: "a b " });
  s.options.onText({ index: 0, text: "a b c " });
  await s.flush();
  assert.deepEqual(order, ["a ", "b ", "c "]);
});

test("a failed publish is logged and the rest still go out", async () => {
  const out: string[] = [];
  let n = 0;
  const s = new AssistantTextStream(1, async (e) => {
    if (n++ === 0) throw new Error("nats down");
    out.push((e as AssistantTextDeltaData).delta);
  }, 0);
  s.options.onText({ index: 0, text: "one " });
  s.options.onText({ index: 0, text: "one two " });
  await s.flush();
  assert.deepEqual(out, ["two "]);
});

test("void takes back every block that showed text, and nothing more is published after it", async () => {
  const out: Ev[] = [];
  const s = new AssistantTextStream(1, async (e) => { out.push(e as unknown as Ev); }, 0);
  s.options.onText({ index: 0, text: "first " });
  s.options.onText({ index: 2, text: "held" }); // nothing publishable yet: nothing to take back
  await s.void();
  s.options.onText({ index: 0, text: "first second " });
  await s.flush();
  assert.deepEqual(out.map((e) => [e.type, e.delta ?? e.reason]), [
    [ASSISTANT_TEXT_DELTA_EVENT, "first "],
    [ASSISTANT_TEXT_VOID_EVENT, "retry"],
  ]);
});

// ------------------------------------------------------------------------------------------------ the loop

test("the loop streams its text, then sends the AssistantMessage, which names the stream; the deltas tile the text", async () => {
  const text1 = "Let me look at the repository first.";
  const text2 = "两个测试都通过了。All tests pass.";
  const { session: s, seen } = session([
    {
      content: [{ type: "text", text: text1 }, { type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } }],
      during: async (o) => {
        for (let i = 1; i <= text1.length; i += 5) { o!.text!.onText({ index: 0, text: text1.slice(0, i) }); await sleep(2); }
        o!.text!.onText({ index: 0, text: text1 });
        o!.text!.onToolCall();
      },
    },
    {
      content: [{ type: "text", text: text2 }],
      during: async (o) => {
        for (let i = 1; i <= text2.length; i += 3) { o!.text!.onText({ index: 0, text: text2.slice(0, i) }); await sleep(2); }
        o!.text!.onText({ index: 0, text: text2 });
      },
    },
  ]);
  const { opts: o, events } = opts({ llmSession: s });
  await agentLoop([{ role: "user", content: "run the tests" }], TOOLS, o);
  assert.ok(seen[0]?.text, "the provider was asked for the text as it is written");
  const messages = events.filter((e) => e.type === "AssistantMessage");
  assert.equal(messages.length, 2);
  const texts = joined(events);
  assert.equal(texts.size, 2);
  for (const [m, want] of [[messages[0]!, text1], [messages[1]!, text2]] as const) {
    const id = m.text_id as string;
    assert.ok(id, "the AssistantMessage names its stream");
    assert.equal(texts.get(id), want, "the deltas joined are the message's text");
    const own = deltas(events).filter((d) => d.text_id === id);
    assert.ok(events.indexOf(own[own.length - 1] as unknown as Ev & { at: number }) < events.indexOf(m), "every delta before its message");
    assert.deepEqual((m.data as { content: unknown[] }).content, [{ type: "text", text: want }], "the message itself is unchanged");
  }
  // The first turn's text was on screen before its tool call started.
  const firstStart = events.findIndex((e) => e.type === "toolUsed" && e.status === "start");
  assert.ok(events.indexOf(deltas(events)[0] as unknown as Ev & { at: number }) < firstStart);
});

test("off for a sub-agent, an assistant router turn, or when switched off; the AssistantMessage is as it always was", async () => {
  const play = () => session([{
    content: [{ type: "text", text: "hello there" }],
    during: async (o) => { o?.text?.onText({ index: 0, text: "hello there" }); },
  }]);
  for (const over of [
    { depth: 1 },
    { streamToolText: ["mcp__assistant__say"] },
    { streamText: false },
  ] as Array<Partial<LoopOptions>>) {
    const { session: s, seen } = play();
    const { opts: o, events } = opts({ llmSession: s, ...over });
    await agentLoop([{ role: "user", content: "hi" }], TOOLS, o);
    assert.equal(seen[0]?.text, undefined, JSON.stringify(over));
    assert.equal(deltas(events).length, 0, JSON.stringify(over));
    const m = events.find((e) => e.type === "AssistantMessage");
    if (m) assert.equal(m.text_id, undefined);
  }
});

test("text shown by a model call that failed and is tried again is taken back; the retry streams under a new id", async (t) => {
  t.mock.method(Math, "random", () => 0); // the shortest backoff the loop draws (2.5 s)
  let calls = 0;
  const s: LlmSession = {
    async streamTurn(_m: Message[], _t: ToolSchema[], _s?: AbortSignal, options?: StreamTurnOptions): Promise<LlmTurnResult> {
      calls += 1;
      options!.text!.onText({ index: 0, text: calls === 1 ? "The answer is " : "The answer is 42." });
      if (calls === 1) throw new TypeError("terminated"); // a dropped stream: tried again
      return {
        content: [{ type: "text", text: "The answer is 42." }], stopReason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      };
    },
    async complete() { return ""; },
  };
  const { opts: o, events } = opts({ llmSession: s });
  await agentLoop([{ role: "user", content: "?" }], TOOLS, o);
  const shown = events.filter((e) => e.type === ASSISTANT_TEXT_DELTA_EVENT || e.type === ASSISTANT_TEXT_VOID_EVENT);
  assert.deepEqual(shown.map((e) => [e.type, e.delta ?? e.reason]), [
    [ASSISTANT_TEXT_DELTA_EVENT, "The answer is "],
    [ASSISTANT_TEXT_VOID_EVENT, "retry"],
    [ASSISTANT_TEXT_DELTA_EVENT, "The answer is "],
    [ASSISTANT_TEXT_DELTA_EVENT, "42."], // held until the block was whole
  ]);
  assert.equal(shown[0]!.text_id, shown[1]!.text_id);
  assert.equal(shown[2]!.text_id, shown[3]!.text_id);
  assert.notEqual(shown[2]!.text_id, shown[0]!.text_id);
  assert.equal(events.find((e) => e.type === "AssistantMessage")!.text_id, shown[2]!.text_id);
});

// ------------------------------------------------------------------------------------------------ first token to first event

/**
 * A model that takes `tokens.length * gapMs` to write its answer, token by token, as Anthropic's stream sends it. Records when
 * it handed out its first text token.
 */
function slowModel(tokens: string[], gapMs: number) {
  const marks = { firstToken: 0, lastToken: 0 };
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { model: "m", usage: { input_tokens: 3 } } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      for (const [i, text] of tokens.entries()) {
        if (i === 0) marks.firstToken = performance.now();
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        marks.lastToken = performance.now();
        await sleep(gapMs);
      }
      yield { type: "content_block_stop", index: 0 };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: tokens.length } };
      yield { type: "message_stop" };
    },
  };
  const client = { messages: { create: async () => stream } };
  return { marks, session: buildAnthropicSession(client as never, "claude-sonnet-5.5") };
}

for (const [label, tokens] of [
  ["English", "Sure, I will read the failing test and then fix the import it trips on .".split(/(?= )/)],
  ["Chinese", [..."好的，我先读一下失败的测试，然后修复它依赖的导入。"]],
] as const) {
  test(`${label}: the first text is on the stream within 300 ms of the model's first token, long before the answer is whole`, async () => {
    const gapMs = 60;
    const { marks, session: s } = slowModel([...tokens], gapMs);
    const { opts: o, events } = opts({ llmSession: s });
    await agentLoop([{ role: "user", content: "fix the test" }], TOOLS, o);
    const first = deltas(events)[0] as unknown as { at: number } | undefined;
    assert.ok(first, "no assistantTextDelta");
    const lag = first.at - marks.firstToken;
    const message = events.find((e) => e.type === "AssistantMessage")!;
    // eslint-disable-next-line no-console
    console.log(`[${label}] first token -> first assistantTextDelta: ${lag.toFixed(1)} ms; AssistantMessage: ${(message.at - marks.firstToken).toFixed(1)} ms`);
    assert.ok(lag <= 300, `first visible text ${lag.toFixed(1)} ms after the model's first token`);
    assert.ok(first.at < marks.lastToken, "the first text came before the model's last token");
    assert.equal(joined(events).get(message.text_id as string), tokens.join(""));
  });
}
