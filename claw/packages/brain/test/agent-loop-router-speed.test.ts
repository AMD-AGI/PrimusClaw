// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The loop's part in a quick assistant router turn: a streamed tool's text is published as `toolTextDelta` events while the model
 * writes it (`LoopOptions.streamToolText`), and the read-only lookups the request names (`read_taint.sources`) run side by side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmContentBlock, LlmSession, LlmTurnResult, StreamTurnOptions } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { readTaintSources } from "../src/tools/allowlist.js";
import { agentLoop, TOOL_TEXT_DELTA_INTERVAL_MS, ToolTextThrottle, type LoopOptions } from "../src/agent/agent-loop.js";

type Ev = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SAY = "mcp__assistant__say";
const TOOLS = [
  { name: SAY, description: "say", input_schema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "mcp__safe__node_list", description: "nodes", input_schema: { type: "object", properties: {} } },
  { name: "mcp__safe__workload_list", description: "workloads", input_schema: { type: "object", properties: {} } },
  { name: "mcp__assistant__work_create", description: "start work", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

const use = (id: string, name: string, input: Record<string, unknown> = {}): LlmContentBlock => ({ type: "tool_use", id, name, input });

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

function router(handler: (name: string) => Promise<string>): ToolRouter {
  return { route: async (name: string) => handler(name), setHands: () => {} } as unknown as ToolRouter;
}

function opts(over: Partial<LoopOptions>): { opts: LoopOptions; events: Ev[] } {
  const events: Ev[] = [];
  return {
    events,
    opts: {
      model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 6,
      router: router(async () => "ok"),
      onEvent: async (e: unknown) => { events.push(e as Ev); },
      sessionId: "s", userId: "u",
      ...over,
    },
  };
}

test("a streamed say's text is published while it is written, at most once per interval, and the say still runs", async () => {
  const { session: s, seen } = session([
    {
      content: [use("toolu_say", SAY, { text: "Hello there, 12 nodes" })],
      during: async (o) => {
        const say = (text: string) => o!.toolText!.onText({ id: "toolu_say", name: SAY, text });
        say("Hello");
        say("Hello there");          // inside the interval: held, and published when the interval ends
        await sleep(TOOL_TEXT_DELTA_INTERVAL_MS + 50);
        say("Hello there, 12");      // inside the next interval: superseded before it ends
        say("Hello there, 12 nodes"); // published when the turn ends
      },
    },
    { content: [{ type: "text", text: "ok" }] },
  ]);
  const routed: string[] = [];
  const { opts: o, events } = opts({
    llmSession: s, streamToolText: [SAY], router: router(async (name) => { routed.push(name); return '{"ok":true}'; }),
  });
  await agentLoop([{ role: "user", content: "how many nodes?" }], TOOLS, o);

  assert.deepEqual([...seen[0]!.toolText!.tools], [SAY]);
  const deltas = events.filter((e) => e.type === "toolTextDelta");
  assert.deepEqual(deltas.map((e) => [e.tool, e.actionId, e.text]), [
    [SAY, "toolu_say", "Hello"],
    [SAY, "toolu_say", "Hello there"],
    [SAY, "toolu_say", "Hello there, 12 nodes"],
  ]);
  // The preview comes before the call: the say itself runs once the step is whole, as every call does.
  const firstStart = events.findIndex((e) => e.type === "toolUsed" && e.status === "start");
  assert.ok(events.indexOf(deltas[2]) < firstStart);
  assert.deepEqual(routed, [SAY]);
});

test("a say written inside one interval is still published twice: its first text at once, its whole text before it runs", async () => {
  const { session: s } = session([
    {
      content: [use("toolu_say", SAY, { text: "12 nodes are free." })],
      during: async (o) => {
        const say = (text: string) => o!.toolText!.onText({ id: "toolu_say", name: SAY, text });
        say("12");
        say("12 nodes");
        say("12 nodes are free.");
      },
    },
    { content: [{ type: "text", text: "ok" }] },
  ]);
  const { opts: o, events } = opts({ llmSession: s, streamToolText: [SAY] });
  await agentLoop([{ role: "user", content: "how many nodes?" }], TOOLS, o);
  const deltas = events.filter((e) => e.type === "toolTextDelta");
  assert.deepEqual(deltas.map((e) => e.text), ["12", "12 nodes are free."], "the text written after the first delta was dropped");
  const firstStart = events.findIndex((e) => e.type === "toolUsed" && e.status === "start");
  assert.ok(events.indexOf(deltas[1]!) < firstStart, "the last delta came after the say ran");
});

test("text that stops growing inside an interval is published when the interval ends, not only when the turn does", async () => {
  let midTurn: string[] = [];
  const { session: s } = session([
    {
      content: [use("toolu_say", SAY, { text: "Searching the web, one moment." })],
      during: async (o) => {
        const say = (text: string) => o!.toolText!.onText({ id: "toolu_say", name: SAY, text });
        say("Searching");
        say("Searching the web, one moment.");
        // The model goes quiet (it is still writing something else): the held text must not wait for the turn to end.
        await sleep(TOOL_TEXT_DELTA_INTERVAL_MS + 150);
        midTurn = events.filter((e) => e.type === "toolTextDelta").map((e) => String(e.text));
      },
    },
    { content: [{ type: "text", text: "ok" }] },
  ]);
  const { opts: o, events } = opts({ llmSession: s, streamToolText: [SAY] });
  await agentLoop([{ role: "user", content: "search" }], TOOLS, o);
  assert.deepEqual(midTurn, ["Searching", "Searching the web, one moment."]);
  // Nothing is published twice.
  assert.deepEqual(events.filter((e) => e.type === "toolTextDelta").map((e) => e.text), ["Searching", "Searching the web, one moment."]);
});

test("a failed attempt's held text is not published", async () => {
  const published: string[] = [];
  const t = new ToolTextThrottle(new Set([SAY]), 50, async ({ text }) => { published.push(text); });
  t.options.toolText!.onText({ id: "a", name: SAY, text: "Hel" });
  t.options.toolText!.onText({ id: "a", name: SAY, text: "Hello" });
  t.cancel();
  await sleep(100);
  t.options.toolText!.onText({ id: "a", name: SAY, text: "Hello again" });
  assert.deepEqual(published, ["Hel"]);
});

test("without stream_tool_text, and in a sub-agent's loop, no text is asked for", async () => {
  for (const over of [{}, { streamToolText: [SAY], depth: 1 }] as Array<Partial<LoopOptions>>) {
    const { session: s, seen } = session([{ content: [{ type: "text", text: "hi" }] }]);
    const { opts: o, events } = opts({ llmSession: s, ...over });
    await agentLoop([{ role: "user", content: "hi" }], TOOLS, o);
    // No tool's text; the loop's own text is asked for only at the top level (`assistantTextDelta`, not a say's preview).
    assert.equal(seen[0]?.toolText, undefined);
    if (over.depth) assert.equal(seen[0], undefined);
    assert.equal(events.some((e) => e.type === "toolTextDelta"), false);
  }
});

/** Two lookups in one step; each waits until it sees the other running (or gives up), and the most at once is reported. */
async function twoLookups(readSources?: string[]): Promise<{ most: number; routed: string[] }> {
  let running = 0;
  let most = 0;
  const routed: string[] = [];
  const handler = async (name: string) => {
    routed.push(name);
    running++;
    most = Math.max(most, running);
    for (let i = 0; i < 20 && running < 2; i++) await sleep(10);
    running--;
    return "[]";
  };
  const { session: s } = session([
    { content: [use("t1", "mcp__safe__node_list"), use("t2", "mcp__safe__workload_list"), use("t3", "mcp__assistant__work_create")] },
    { content: [{ type: "text", text: "done" }] },
  ]);
  // As the engine builds it from the request (`read_taint.sources`).
  const { opts: o } = opts({ llmSession: s, router: router(handler), parallelTools: readTaintSources(readSources ? { sources: readSources, allow_after: [SAY] } : undefined) });
  await agentLoop([{ role: "user", content: "what runs on the nodes?" }], TOOLS, o);
  return { most, routed };
}

test("the request's read-only sources are read once: none, a list, or nothing usable", () => {
  assert.equal(readTaintSources(undefined), null);
  assert.equal(readTaintSources({ sources: [] }), null);
  assert.equal(readTaintSources({ sources: ["", 3] }), null);
  const parsed = readTaintSources({ sources: ["mcp__safe__node_list", "mcp__dispatron__get_*"], allow_after: [SAY] })!;
  assert.equal(parsed.allows("mcp__dispatron__get_runs"), true);
  assert.equal(parsed.allows(SAY), false, "allow_after is not a source");
});

test("the read-only lookups a request names run side by side; anything else after them still waits its turn", async () => {
  const parallel = await twoLookups(["mcp__safe__node_list", "mcp__safe__workload_*"]);
  assert.equal(parallel.most, 2);
  // The acting call comes after both lookups, never beside them, as it did when they ran one by one.
  assert.equal(parallel.routed[2], "mcp__assistant__work_create");
  const serial = await twoLookups(undefined);
  assert.equal(serial.most, 1);
  assert.deepEqual(serial.routed, ["mcp__safe__node_list", "mcp__safe__workload_list", "mcp__assistant__work_create"]);
});

test("a call's deltas go out in order even when an earlier publish is slow, and all of them before the call runs", async () => {
  const delivered: string[] = [];
  // The first publish stalls (a retried JetStream publish); the later, longer texts must not overtake it.
  const t = new ToolTextThrottle(new Set([SAY]), 20, async ({ text }) => {
    if (text === "A") await sleep(150);
    delivered.push(text);
  });
  t.options.toolText!.onText({ id: "a", name: SAY, text: "A" });
  t.options.toolText!.onText({ id: "a", name: SAY, text: "AB" });
  await sleep(40);
  t.options.toolText!.onText({ id: "a", name: SAY, text: "ABC" });
  await t.flush();
  assert.deepEqual(delivered, ["A", "AB", "ABC"]);
});

test("a failed attempt's deltas queued behind a slow publish are not sent after it is cancelled", async () => {
  const delivered: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const t = new ToolTextThrottle(new Set([SAY]), 20, async ({ text }) => {
    if (text === "A") await held;
    delivered.push(text);
  });
  t.options.toolText!.onText({ id: "a", name: SAY, text: "A" });
  await sleep(40);
  t.options.toolText!.onText({ id: "a", name: SAY, text: "AB" }); // queued behind "A"
  t.cancel();
  release();
  await sleep(20);
  assert.deepEqual(delivered, ["A"]);
});

const sayDeltas = (events: Ev[]) => events.filter((e) => e.type === "toolTextDelta");

test("a router turn's own text is published as its say's text while it is written, when the run asks for it", async () => {
  const { session: s, seen } = session([
    {
      content: [{ type: "text", text: "下个月冻结期从 12 月 4 日（周五）开始。" }],
      during: async (o) => {
        o!.text!.onText({ index: 0, text: "下个月冻结期" });
        o!.text!.onText({ index: 0, text: "下个月冻结期从 12 月 4 日（周五）开始。" });
      },
    },
  ]);
  const { opts: o, events } = opts({ llmSession: s, streamToolText: [SAY], streamTextAs: SAY });
  await agentLoop([{ role: "user", content: "下个月 Kestrel 的冻结期从哪天开始？" }], TOOLS, o);
  assert.ok(seen[0]?.text, "the provider is asked for the text");
  assert.deepEqual(sayDeltas(events).map((e) => [e.tool, e.actionId, e.text, e.source]), [
    [SAY, "text-1-0", "下个月冻结期", "text"],
    [SAY, "text-1-0", "下个月冻结期从 12 月 4 日（周五）开始。", "text"],
  ]);
  assert.equal(events.some((e) => e.type === "toolTextVoid"), false);
});

test("text followed by a tool call is taken back, and the run's later text is not shown", async () => {
  let voidedMidTurn = false;
  const { session: s } = session([
    {
      content: [{ type: "text", text: "查一下" }, use("toolu_m", "mcp__safe__node_list")],
      during: async (o) => {
        o!.text!.onText({ index: 0, text: "查一下" });
        o!.text!.onToolCall();
        await sleep(10);
        // When the call starts, not when the model's turn ends: the words go before the call's arguments are even written.
        voidedMidTurn = events.some((e) => e.type === "toolTextVoid");
      },
    },
    {
      content: [{ type: "text", text: "12 个节点空闲。" }],
      during: async (o) => { o?.text?.onText({ index: 0, text: "12 个节点空闲。" }); },
    },
  ]);
  const { opts: o, events } = opts({ llmSession: s, streamToolText: [SAY], streamTextAs: SAY });
  await agentLoop([{ role: "user", content: "nodes?" }], TOOLS, o);
  const voids = events.filter((e) => e.type === "toolTextVoid");
  assert.equal(voidedMidTurn, true);
  assert.deepEqual(voids.map((e) => [e.tool, e.actionId, e.reason, e.source]), [[SAY, "text-1-0", "tool_call", "text"]]);
  assert.deepEqual(sayDeltas(events).map((e) => e.text), ["查一下"], "nothing of the run's text after the void");
  assert.ok(events.indexOf(voids[0]!) > events.indexOf(sayDeltas(events)[0]!));
});

test("a tool call the provider did not report while streaming still takes the text back", async () => {
  const { session: s } = session([
    {
      content: [{ type: "text", text: "Checking" }, use("toolu_m", "mcp__safe__node_list")],
      during: async (o) => { o!.text!.onText({ index: 0, text: "Checking" }); },
    },
    { content: [{ type: "text", text: "done" }] },
  ]);
  const { opts: o, events } = opts({ llmSession: s, streamToolText: [SAY], streamTextAs: SAY });
  await agentLoop([{ role: "user", content: "nodes?" }], TOOLS, o);
  assert.equal(events.filter((e) => e.type === "toolTextVoid").length, 1);
});

test("once the run says something itself, its text is no longer shown; without the option it never is", async () => {
  const { session: s, seen } = session([
    { content: [use("toolu_say", SAY, { text: "12 个节点空闲。" })] },
    {
      content: [{ type: "text", text: "已回答。" }],
      during: async (o) => { o?.text?.onText({ index: 0, text: "已回答。" }); },
    },
  ]);
  const { opts: o, events } = opts({ llmSession: s, streamToolText: [SAY], streamTextAs: SAY });
  await agentLoop([{ role: "user", content: "nodes?" }], TOOLS, o);
  assert.equal(seen[1]?.text, undefined, "the turn after the say is not asked for its text");
  assert.equal(sayDeltas(events).some((e) => e.source === "text"), false);
  assert.equal(events.some((e) => e.type === "toolTextVoid"), false, "a say with no text before it takes nothing back");

  const off = session([{ content: [{ type: "text", text: "ok" }] }]);
  const { opts: o2, events: e2 } = opts({ llmSession: off.session, streamToolText: [SAY] });
  await agentLoop([{ role: "user", content: "hi" }], TOOLS, o2);
  assert.equal(off.seen[0]?.text, undefined);
  assert.equal(sayDeltas(e2).length, 0);
});

test("a sub-agent's text is never the run's to show", async () => {
  const sub = session([{ content: [{ type: "text", text: "inner" }], during: async (o) => { o?.text?.onText({ index: 0, text: "inner" }); } }]);
  const { opts: o, events } = opts({ llmSession: sub.session, streamToolText: [SAY], streamTextAs: SAY, depth: 1 } as Partial<LoopOptions>);
  await agentLoop([{ role: "user", content: "x" }], TOOLS, o);
  assert.equal(sub.seen[0]?.text, undefined);
  assert.equal(sayDeltas(events).length, 0);
});


test("text shown by a model call that failed and is tried again is taken back; the retry shows its own", async (t) => {
  t.mock.method(Math, "random", () => 0); // the shortest backoff the loop draws (2.5 s)
  let calls = 0;
  const s: LlmSession = {
    async streamTurn(_m: Message[], _t: ToolSchema[], _s?: AbortSignal, options?: StreamTurnOptions): Promise<LlmTurnResult> {
      calls += 1;
      options!.text!.onText({ index: 0, text: calls === 1 ? "下个月冻" : "下个月冻结期从 12 月 4 日开始。" });
      if (calls === 1) throw new TypeError("terminated"); // a dropped stream: tried again
      await sleep(5);
      return {
        content: [{ type: "text", text: "下个月冻结期从 12 月 4 日开始。" }], stopReason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      };
    },
    async complete() { return ""; },
  };
  const { opts: o, events } = opts({ llmSession: s, streamToolText: [SAY], streamTextAs: SAY });
  await agentLoop([{ role: "user", content: "下个月冻结期？" }], TOOLS, o);
  const shown = events.filter((e) => e.type === "toolTextDelta" || e.type === "toolTextVoid").map((e) => [e.type, e.actionId, e.reason ?? e.text]);
  assert.deepEqual(shown, [
    ["toolTextDelta", "text-1-0", "下个月冻"],
    ["toolTextVoid", "text-1-0", "retry"],
    ["toolTextDelta", "text-2-0", "下个月冻结期从 12 月 4 日开始。"],
  ]);
});

test("every text a model call showed is taken back when a tool call follows, two blocks split by thinking included", async () => {
  const { session: s } = session([
    {
      content: [{ type: "text", text: "先看一下" }, { type: "thinking", thinking: "" } as unknown as LlmContentBlock, { type: "text", text: "再查节点" },
        use("toolu_m", "mcp__safe__node_list")],
      during: async (o) => {
        o!.text!.onText({ index: 0, text: "先看一下" });
        o!.text!.onText({ index: 2, text: "再查节点" });
        o!.text!.onToolCall();
      },
    },
    { content: [{ type: "text", text: "done" }] },
  ]);
  const { opts: o, events } = opts({ llmSession: s, streamToolText: [SAY], streamTextAs: SAY });
  await agentLoop([{ role: "user", content: "nodes?" }], TOOLS, o);
  assert.deepEqual(events.filter((e) => e.type === "toolTextVoid").map((e) => e.actionId).sort(), ["text-1-0", "text-1-2"]);
});
