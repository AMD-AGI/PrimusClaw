// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// agent-loop-compaction.test.ts
//
// The first tests for auto-compaction. It had none, and it is the only
// context-size guard in Brain: nothing else stops a long-running task from
// growing until the model rejects the request, and a context-window rejection
// is a 400, which streamTurnWithRetry does not retry.
//
// What is pinned here above all is WHICH NUMBER the trigger reads. Anthropic
// reports usage.input_tokens as the uncached remainder -- measured on the live
// gateway, the same prompt reads 10,960 with no cache marker and 6 with one --
// so the moment prompt caching starts working, a trigger written against
// input_tokens can never fire again. The caching change and this one cannot
// ship apart.

// The trigger is read at module load, so it must be set before the module is
// imported -- and a plain `import` is hoisted above every statement in the
// file, so a top-level assignment lands too late and the suite silently runs
// against the 850K default. Same shape as bg-shell-gate-on.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import type { CheckpointState } from "../src/agent/index.js";
import { registry } from "../src/infra/metrics.js";

process.env.COMPACTION_TRIGGER_INPUT_TOKENS = "1000";
const { agentLoop } = await import("../src/agent/agent-loop.js");
type LoopOptions = import("../src/agent/agent-loop.js").LoopOptions;

type Ev = Record<string, unknown>;

function session(turns: Array<Partial<LlmTurnResult>>, completeImpl?: () => Promise<string>): LlmSession & {
  calls: Array<{ messages: Message[] }>;
} {
  const calls: Array<{ messages: Message[] }> = [];
  let i = 0;
  return {
    calls,
    async streamTurn(messages) {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)) });
      const t = turns[i++];
      if (!t) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: t.content ?? [],
        stopReason: t.stopReason ?? "end_turn",
        usage: t.usage ?? { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
        ...(t.cacheReport ? { cacheReport: t.cacheReport } : {}),
        ...(t.promptTokens !== undefined ? { promptTokens: t.promptTokens } : {}),
      };
    },
    complete: completeImpl ?? (async () => "COMPACTED-SUMMARY"),
  };
}

const router = () => ({ route: async () => "ok", setHands: () => {} }) as unknown as ToolRouter;

function opts(over: Partial<LoopOptions> = {}): { o: LoopOptions; events: Ev[] } {
  const events: Ev[] = [];
  return {
    events,
    o: {
      model: "test-model", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 4,
      router: router(), sessionId: "sess-c", userId: "u",
      onEvent: async (e: unknown) => { events.push(e as Ev); },
      ...over,
    },
  };
}

/**
 * A history long enough for compactConversation to have something to cut: it
 * keeps the last 8 turns (16 messages) and bails unless there is more than
 * that plus the head.
 */
function longHistory(head: Message): Message[] {
  const out: Message[] = [head];
  for (let i = 0; i < 12; i++) {
    out.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "read", input: {} }] });
    out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "ok" }] });
  }
  return out;
}

function resume(messages: Message[]): CheckpointState {
  return {
    messages, turns_completed: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
    text_parts: [], error_count: 0, tool_calls_by_name: {}, total_tool_calls: 0,
    elapsed_ms_before: 0, setup_commands: [],
  };
}

async function compactionCount(result: string): Promise<number> {
  const m = registry.getSingleMetric("claw_brain_compaction_total");
  if (!m) return NaN;                       // unregistered: invisible on /metrics
  const v = await m.get();
  return v.values.find((x: any) => x.labels?.result === result)?.value ?? 0;
}

const compacted = (events: Ev[]) =>
  events.filter((e) => e.type === "statusUpdate" && (e as any).event === "context_compacted");

test("compaction fires on a nearly all-cached turn", async () => {
  // The shape a working prompt cache produces: input_tokens is a handful of
  // tokens because everything else was read from cache, while the prompt is
  // 905K. Reading input_tokens here yields 6 and the guard never fires.
  // Note the turn must CONTINUE: an end_turn turn returns from runTurn before
  // the compaction block, so the last turn of a run never compacts.
  const s = session([
    { usage: { input_tokens: 6, output_tokens: 10, cache_read: 2_000, cache_create: 500 },
      promptTokens: 2_506, stopReason: "tool_use",
      content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
    { usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
      promptTokens: 1, stopReason: "end_turn" },
  ]);
  const { o, events } = opts({ llmSession: s, resumeFrom: resume(longHistory({ role: "user", content: "go" })) });

  await agentLoop([], [] as ToolSchema[], o);

  const ev = compacted(events);
  assert.equal(ev.length, 1, "a 2.5K prompt over a 1K trigger must compact");
  assert.equal((ev[0] as any).trigger_input_tokens, 2_506, "report the prompt size, not the remainder");
});

test("an uncached turn below the trigger does not compact", async () => {
  const s = session([
    { usage: { input_tokens: 500, output_tokens: 10, cache_read: 0, cache_create: 0 },
      promptTokens: 500, stopReason: "tool_use",
      content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
    { usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 }, stopReason: "end_turn" },
  ]);
  const { o, events } = opts({ llmSession: s, resumeFrom: resume(longHistory({ role: "user", content: "go" })) });
  await agentLoop([], [] as ToolSchema[], o);
  assert.equal(compacted(events).length, 0);
});

test("a session that reports no promptTokens falls back to input_tokens", async () => {
  // Every existing test double omits it, and test/ is outside the tsconfig
  // include so nothing would have told them. The fallback keeps their
  // behaviour exactly as it was.
  const s = session([
    { usage: { input_tokens: 2_000, output_tokens: 10, cache_read: 0, cache_create: 0 },
      stopReason: "tool_use", content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
    { usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 }, stopReason: "end_turn" },
  ]);
  const { o, events } = opts({ llmSession: s, resumeFrom: resume(longHistory({ role: "user", content: "go" })) });
  await agentLoop([], [] as ToolSchema[], o);
  assert.equal(compacted(events).length, 1);
});

test("the compacted history is shorter and carries the summary", async () => {
  const s = session([
    { usage: { input_tokens: 6, output_tokens: 10, cache_read: 2_000, cache_create: 0 },
      promptTokens: 2_006, stopReason: "tool_use",
      content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
    { usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
      promptTokens: 1, stopReason: "end_turn" },
  ]);
  const { o } = opts({ llmSession: s, resumeFrom: resume(longHistory({ role: "user", content: "go" })) });
  await agentLoop([], [] as ToolSchema[], o);

  const before = s.calls[0].messages.length;
  const after = s.calls[1].messages.length;
  assert.ok(after < before, `history did not shrink: ${before} -> ${after}`);
  const text = JSON.stringify(s.calls[1].messages);
  assert.ok(text.includes("COMPACTED-SUMMARY"), "the summary must reach the next turn");
});

test("sub-agents do not compact", async () => {
  const s = session([
    { usage: { input_tokens: 6, output_tokens: 10, cache_read: 2_000, cache_create: 0 },
      promptTokens: 2_006, stopReason: "tool_use",
      content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
    { usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 }, stopReason: "end_turn" },
  ]);
  const { o, events } = opts({
    llmSession: s, depth: 1,
    resumeFrom: resume(longHistory({ role: "user", content: "go" })),
  });
  await agentLoop([], [] as ToolSchema[], o);
  assert.equal(compacted(events).length, 0, "depth > 0 has its own short-lived context");
});

test("a summariser failure leaves the history untouched and the loop running", async () => {
  const s = session(
    [
      { usage: { input_tokens: 6, output_tokens: 10, cache_read: 900_000, cache_create: 0 },
        promptTokens: 900_006, stopReason: "tool_use",
        content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
      { usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
        promptTokens: 1, stopReason: "end_turn" },
    ],
    async () => { throw new Error("summariser down"); },
  );
  const { o, events } = opts({ llmSession: s, resumeFrom: resume(longHistory({ role: "user", content: "go" })) });

  const res = await agentLoop([], [] as ToolSchema[], o);
  assert.equal(compacted(events).length, 0, "a failed compaction must not claim it happened");
  assert.equal(res.turns, 2, "and the loop must carry on uncompacted");
});

test("a history led by a system message compacts, keeping the system run at the front", async () => {
  // This used to bail. compactConversation refused any history whose
  // messages[0] was not a user message, which meant a conversation carrying a
  // leading system message could only ever grow -- until it reached the
  // context window and died on a 400 that streamTurnWithRetry does not retry.
  // Since compaction is Brain's only context-size guard, "left alone" was not
  // a safe default; it was the one path with no guard at all.
  const s = session([
    { usage: { input_tokens: 6, output_tokens: 10, cache_read: 2_000, cache_create: 0 },
      promptTokens: 2_006, stopReason: "tool_use",
      content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
    { usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
      promptTokens: 1, stopReason: "end_turn" },
  ]);
  const history = longHistory({ role: "user", content: "the original goal" });
  history.unshift({ role: "system", content: "you are terse" });
  const { o, events } = opts({ llmSession: s, resumeFrom: resume(history) });

  await agentLoop([], [] as ToolSchema[], o);

  assert.equal(compacted(events).length, 1, "a system-headed history must still compact");
  const next = s.calls[1].messages;
  assert.ok(next.length < history.length, "and it must actually get shorter");
  // The system run has to stay contiguous at index 0: the hoist and the
  // tools -> system -> messages cache prefix both depend on it.
  assert.equal(next[0].role, "system");
  assert.equal(next[1].role, "user", "the original prompt is preserved too");
  assert.ok(JSON.stringify(next).includes("COMPACTED-SUMMARY"));
});

test("a summariser failure is reported as failed, not as a no-op", async () => {
  // The caller used to infer the outcome from array identity, which cannot
  // tell "nothing to compact" from "compaction broke" -- both come back as the
  // same array. That made result="failed" a metric value no production line
  // could emit, and a counter that cannot report the bad case is worse than no
  // counter at all.
  const before = await compactionCount("failed");
  const s = session(
    [
      { usage: { input_tokens: 6, output_tokens: 10, cache_read: 2_000, cache_create: 0 },
        promptTokens: 2_006, stopReason: "tool_use",
        content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
      { usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
        promptTokens: 1, stopReason: "end_turn" },
    ],
    async () => { throw new Error("summariser down"); },
  );
  const { o, events } = opts({ llmSession: s, resumeFrom: resume(longHistory({ role: "user", content: "go" })) });

  await agentLoop([], [] as ToolSchema[], o);
  assert.equal(compacted(events).length, 0, "and it must not claim it happened");
  assert.equal(await compactionCount("failed"), before + 1);
});

test("a turn with nothing worth compacting is reported as a no-op, not a failure", async () => {
  const before = { noop: await compactionCount("noop"), failed: await compactionCount("failed") };
  const s = session([
    { usage: { input_tokens: 2_006, output_tokens: 10, cache_read: 0, cache_create: 0 },
      promptTokens: 2_006, stopReason: "tool_use",
      content: [{ type: "tool_use", id: "x", name: "read", input: {} }] },
    { usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
      promptTokens: 1, stopReason: "end_turn" },
  ]);
  // Too short for COMPACTION_MIN_MESSAGES, so there is nothing to do.
  const { o } = opts({ llmSession: s, resumeFrom: resume([{ role: "user", content: "go" }]) });
  await agentLoop([], [] as ToolSchema[], o);
  assert.equal(await compactionCount("noop"), before.noop + 1);
  assert.equal(await compactionCount("failed"), before.failed, "a no-op must not read as a failure");
});

test("the miss right after a compaction is not counted as a lost cache entry", async () => {
  // Compaction replaces everything between the head and the summary, so the
  // prefix the next turn would have matched no longer exists. It cannot read,
  // and blaming the cache for that would make every compaction look like a
  // TTL problem.
  const lost = async () => {
    const m = registry.getSingleMetric("claw_brain_llm_cache_entry_lost_total");
    if (!m) return NaN;
    const v = await m.get();
    return v.values.reduce((n: number, x: any) => n + (x.value ?? 0), 0);
  };
  const before = await lost();
  const marked = { breakpointsSent: 3, enabled: true, reported: ["cache_read", "cache_create"] as const };
  const s = session([
    // Writes, and crosses the trigger so compaction fires at the end of the turn.
    { usage: { input_tokens: 6, output_tokens: 10, cache_read: 2_000, cache_create: 500 },
      promptTokens: 2_506, stopReason: "tool_use",
      content: [{ type: "tool_use", id: "x", name: "read", input: {} }],
      cacheReport: marked },
    // The turn after: markers sent, nothing read -- because the prefix is gone.
    { usage: { input_tokens: 900, output_tokens: 1, cache_read: 0, cache_create: 0 },
      promptTokens: 900, stopReason: "end_turn", cacheReport: marked },
  ]);
  const { o, events } = opts({ llmSession: s, resumeFrom: resume(longHistory({ role: "user", content: "go" })) });

  await agentLoop([], [] as ToolSchema[], o);
  assert.equal(compacted(events).length, 1, "precondition: compaction actually fired");
  assert.equal(await lost(), before, "the post-compaction miss must not be blamed on the cache");
});

test("compaction exempts every turn until a new entry exists, not just one", async () => {
  // A one-turn boolean left the pre-compaction timestamp standing, so the
  // SECOND miss after a compaction was reported as an expired entry -- naming
  // an entry the compaction had itself thrown away. Clearing the timestamp
  // makes the exemption structural: nothing to lose until something is written.
  const lost = async () => {
    const m = registry.getSingleMetric("claw_brain_llm_cache_entry_lost_total");
    if (!m) return NaN;
    const v = await m.get();
    return v.values.reduce((n: number, x: any) => n + (x.value ?? 0), 0);
  };
  const before = await lost();
  const marked = { breakpointsSent: 3, enabled: true, reported: ["cache_read", "cache_create"] as const };
  const s = session([
    { usage: { input_tokens: 6, output_tokens: 10, cache_read: 2_000, cache_create: 500 },
      promptTokens: 2_506, stopReason: "tool_use",
      content: [{ type: "tool_use", id: "x", name: "read", input: {} }],
      cacheReport: marked },
    // First miss after the compaction -- and it keeps the loop running.
    { usage: { input_tokens: 900, output_tokens: 1, cache_read: 0, cache_create: 0 },
      promptTokens: 900, stopReason: "tool_use",
      content: [{ type: "tool_use", id: "y", name: "read", input: {} }],
      cacheReport: marked },
    // Second miss after the compaction: the one the boolean stopped covering.
    { usage: { input_tokens: 900, output_tokens: 1, cache_read: 0, cache_create: 0 },
      promptTokens: 900, stopReason: "end_turn", cacheReport: marked },
  ]);
  const { o, events } = opts({ llmSession: s, resumeFrom: resume(longHistory({ role: "user", content: "go" })) });

  await agentLoop([], [] as ToolSchema[], o);
  assert.equal(compacted(events).length, 1, "precondition: compaction actually fired");
  assert.equal(await lost(), before, "neither post-compaction miss is blamed on the cache");
});
