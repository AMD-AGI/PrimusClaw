// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Compaction is the case the evidence guard exists to get right.
 *
 * A compaction throws away everything between the head and the summary, so the
 * prefix the next turn would have matched is gone and its miss is the designed
 * outcome, not a defect. The loop clears `lastCacheUseAt` at the moment it
 * compacts for exactly that reason.
 *
 * The guard this replaces inferred "an entry existed" from `initialTurn > 0`,
 * which is true of every compacted run -- they are long by definition, that is
 * why they compacted -- so each one reported a loss with nothing lost. The
 * counter reports a defect, and the first investigation goes wherever it
 * points.
 *
 * Driving the real thing rather than asserting on the source text: the clear
 * is one statement inside a branch with three other exits, and only running it
 * shows that the branch taken is the one that clears. The trigger is lowered
 * through the env because it is read at import, hence the dynamic import
 * below.
 */
process.env.COMPACTION_TRIGGER_INPUT_TOKENS = "1000";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import type { CheckpointState } from "../src/agent/index.js";

const { agentLoop } = await import("../src/agent/agent-loop.js");
const { registry } = await import("../src/infra/metrics.js");

type LoopOptions = Parameters<typeof agentLoop>[2];

async function lost(gap: string): Promise<number> {
  const m = registry.getSingleMetric("claw_brain_llm_cache_entry_lost_total");
  if (!m) return NaN;
  const v = await m.get();
  return v.values.find((x: any) => x.labels?.gap === gap)?.value ?? 0;
}

const REPORTED = ["cache_read", "cache_create"] as const;
const toolUse = { type: "tool_use", id: "c", name: "read", input: {} };

/** A turn that reads the cache and keeps the loop going. */
function reading(promptTokens: number): Partial<LlmTurnResult> {
  return {
    content: [toolUse] as any,
    stopReason: "tool_use",
    usage: { input_tokens: 5, output_tokens: 1, cache_create: 0, cache_read: 4000 },
    promptTokens,
  };
}

/** The turn under test: markers went out, the provider said zero. */
const missed: Partial<LlmTurnResult> = {
  content: [],
  stopReason: "end_turn",
  usage: { input_tokens: 5000, output_tokens: 1, cache_create: 0, cache_read: 0 },
  promptTokens: 100,
};

function session(turns: Array<Partial<LlmTurnResult>>, clock: { now: number }): LlmSession {
  let i = 0;
  return {
    async streamTurn() {
      const t = turns[i++];
      if (!t) throw new Error("scripted session exhausted");
      clock.now += 1000;   // a second per turn, far inside any TTL
      return {
        content: t.content ?? [],
        stopReason: t.stopReason ?? "end_turn",
        usage: t.usage!,
        firstByteMs: 1,
        promptTokens: t.promptTokens ?? 100,
        cacheReport: { breakpointsSent: 3, enabled: true, reported: REPORTED },
      } as LlmTurnResult;
    },
    async complete() { return "SUMMARY"; },
  };
}

function withClock<T>(clock: { now: number }, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => clock.now;
  return fn().finally(() => { Date.now = real; });
}

/**
 * Nine reading turns then a miss. Nine is not decorative: compaction needs the
 * working history past COMPACTION_MIN_MESSAGES *and* past the kept tail, and a
 * tool turn appends two messages, so a shorter run compacts to a no-op and the
 * test would pass without ever exercising the clear.
 */
function script(triggerAtLastReadingTurn: boolean): Array<Partial<LlmTurnResult>> {
  const reads = Array.from({ length: 9 }, (_, i) =>
    reading(i === 8 && triggerAtLastReadingTurn ? 50_000 : 100));
  return [...reads, missed];
}

function run(turns: Array<Partial<LlmTurnResult>>, clock: { now: number },
             over: Partial<LoopOptions> = {}) {
  const opts = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 14,
    router: ({ route: async () => "ok", setHands: () => {} }) as unknown as ToolRouter,
    sessionId: "s", userId: "u", onEvent: async () => {},
    llmSession: session(turns, clock),
    ...over,
  } as LoopOptions;
  return agentLoop([{ role: "user", content: "go" } as Message], [] as ToolSchema[], opts);
}

test("the control: without a compaction the same miss is counted", async () => {
  // Establishes that the script really does reach a countable loss, so the
  // assertion below is about the compaction and not about a script that
  // quietly stopped short.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 1_000_000 };
  const events: string[] = [];
  await withClock(clock, () => run(script(false), clock, {
    onEvent: async (e: any) => { if (e.event) events.push(e.event); },
  }));
  assert.ok(!events.includes("context_compacted"), "the control must not compact");
  assert.equal(await lost("under_ttl"), before.under + 1, "an entry existed and did not come back");
  assert.equal(await lost("over_ttl"), before.over);
});

test("a miss on the turn after a compaction is not counted as a lost entry", async () => {
  // The prefix was deliberately thrown away one turn ago. Counting this is how
  // a long, healthy, frequently-compacting session manufactures a defect rate.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 2_000_000 };
  const events: string[] = [];
  await withClock(clock, () => run(script(true), clock, {
    onEvent: async (e: any) => { if (e.event) events.push(e.event); },
  }));
  assert.ok(events.includes("context_compacted"), "the compaction must actually have happened");
  assert.equal(await lost("under_ttl"), before.under, "no entry to lose, no counter");
  assert.equal(await lost("over_ttl"), before.over);
});

test("the cleared timestamp is what gets checkpointed, so a resume inherits it", async () => {
  // Not a one-turn flag. If the checkpoint kept the pre-compaction timestamp,
  // a redelivery would restore it and report the first miss on the new pod --
  // the same false hit, moved one process along.
  const clock = { now: 3_000_000 };
  const seen: CheckpointState[] = [];
  await withClock(clock, () => run(script(true), clock, {
    onCheckpoint: async (st: CheckpointState) => { seen.push(st); },
  }));
  assert.ok(seen.length > 1, "the run checkpointed");
  assert.ok(
    seen.some((st) => typeof st.last_cache_use_at === "number"),
    "before the compaction there was a real timestamp to carry",
  );
  assert.equal(
    seen[seen.length - 1]!.last_cache_use_at, undefined,
    "and after it the checkpoint must carry nothing rather than the stale one",
  );
});
