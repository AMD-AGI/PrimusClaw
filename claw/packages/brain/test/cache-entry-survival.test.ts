// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// cache-entry-survival.test.ts
//
// Asks whether the entry we wrote survived the gap, rather than whether the
// gateway claims it wrote a 1h one.
//
// The TTL label reports a claim, and on the OpenAI-shaped streaming response
// there is no claim to report -- the ephemeral breakdown is absent, so a 1h
// request answered with a 5m entry is invisible there (measured: present in
// the non-streaming response from the same gateway, absent in streaming).
// This counts behaviour instead, so it works on any transport.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import type { CheckpointState } from "../src/agent/index.js";
import { registry } from "../src/infra/metrics.js";

async function lost(gap: string): Promise<number> {
  const m = registry.getSingleMetric("claw_brain_llm_cache_entry_lost_total");
  if (!m) return NaN;                       // unregistered: invisible on /metrics
  const v = await m.get();
  return v.values.find((x: any) => x.labels?.gap === gap)?.value ?? 0;
}

const REPORTED = ["cache_read", "cache_create"] as const;
const toolUse = { type: "tool_use", id: "c", name: "read", input: {} };

/** Replays turns, and lets a test move the clock between them. */
function session(
  turns: Array<Partial<LlmTurnResult> & { advanceMsAfter?: number }>,
  clock: { now: number },
): LlmSession {
  let i = 0;
  return {
    async streamTurn() {
      const t = turns[i++];
      if (!t) throw new Error("scripted session exhausted");
      const result = {
        content: t.content ?? [],
        stopReason: t.stopReason ?? "end_turn",
        usage: t.usage ?? { input_tokens: 1, output_tokens: 1, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
        promptTokens: 100,
        cacheReport: t.cacheReport ?? { breakpointsSent: 3, enabled: true, reported: REPORTED },
      } as LlmTurnResult;
      // Advanced AFTER this turn's result, i.e. between it and the next turn's
      // request. The loop anchors both the recorded use and the measured gap
      // at the REQUEST, so a clock moved mid-turn would be invisible to it --
      // which is exactly the confusion the production change is about.
      if (t.advanceMsAfter) clock.now += t.advanceMsAfter;
      return result;
    },
    async complete() { return "SUMMARY"; },
  };
}

function run(s: LlmSession, over: Partial<LoopOptions> = {}) {
  const opts: LoopOptions = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 6,
    router: ({ route: async () => "ok", setHands: () => {} }) as unknown as ToolRouter,
    sessionId: "s", userId: "u", onEvent: async () => {}, ...over,
  };
  return agentLoop([{ role: "user", content: "go" } as Message], [] as ToolSchema[], { ...opts, llmSession: s });
}

/** Freeze Date.now so a gap is a decision, not a race. */
function withClock<T>(clock: { now: number }, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => clock.now;
  return fn().finally(() => { Date.now = real; });
}

const wrote = { usage: { input_tokens: 2, output_tokens: 1, cache_create: 5000, cache_read: 0 },
                stopReason: "tool_use" as const, content: [toolUse] };
const missed = { usage: { input_tokens: 5000, output_tokens: 1, cache_create: 0, cache_read: 0 },
                 stopReason: "end_turn" as const };

test("an entry gone after longer than the configured TTL is counted as the long gap", async () => {
  // The shape a silent TTL downgrade produces: we asked for an hour, the entry
  // did not last one, and the polling loop slept past it. The threshold is the
  // TTL this deployment configured, not a constant -- on a 5m deployment every
  // normal expiry would otherwise be reported as a defect.
  const before = await lost("over_ttl");
  const clock = { now: 1_000_000 };
  await withClock(clock, () => run(session([{ ...wrote, advanceMsAfter: 70 * 60 * 1000 }, missed], clock)));
  assert.equal(await lost("over_ttl"), before + 1);
});

test("an entry gone well inside the TTL points at the prefix, not the lifetime", async () => {
  // No TTL can explain this one: the entry should still be alive, so what
  // changed is the prefix -- a tool list, a backend switch, an eviction.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 2_000_000 };
  await withClock(clock, () => run(session([{ ...wrote, advanceMsAfter: 30 * 1000 }, missed], clock)));
  assert.equal(await lost("under_ttl"), before.under + 1);
  assert.equal(await lost("over_ttl"), before.over);
});

test("a turn that reads is not a loss", async () => {
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 3_000_000 };
  const hit = { usage: { input_tokens: 2, output_tokens: 1, cache_create: 10, cache_read: 4990 },
                stopReason: "end_turn" as const };
  await withClock(clock, () => run(session([{ ...wrote, advanceMsAfter: 9 * 60 * 1000 }, hit], clock)));
  assert.equal(await lost("over_ttl"), before.over);
  assert.equal(await lost("under_ttl"), before.under);
});

test("the first turn of a run has nothing to lose", async () => {
  // Nothing has been written yet, so a cold miss is not a symptom.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 4_000_000 };
  await withClock(clock, () => run(session([missed], clock)));
  assert.equal(await lost("over_ttl"), before.over);
  assert.equal(await lost("under_ttl"), before.under);
});

test("a turn that sent no markers is not blamed for reading nothing", async () => {
  // After the latch disables markers, or on a path that renders none, a miss
  // is the expected outcome rather than a lost entry.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 5_000_000 };
  await withClock(clock, () => run(session([
    { ...wrote, advanceMsAfter: 9 * 60 * 1000 },
    { ...missed,
      cacheReport: { breakpointsSent: 0, enabled: false, reported: REPORTED } },
  ], clock)));
  assert.equal(await lost("over_ttl"), before.over);
  assert.equal(await lost("under_ttl"), before.under);
});

test("markers enabled but none placed is also not a loss", async () => {
  // Reachable on the OpenAI wire: the deployment has opted in, so the report
  // says enabled, but the conversation offered no position a marker could sit
  // on and zero went out. Nothing was asked of the cache, so nothing was lost.
  // Distinct from the disabled case above -- `enabled` alone does not cover it.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 7_000_000 };
  await withClock(clock, () => run(session([
    { ...wrote, advanceMsAfter: 9 * 60 * 1000 },
    { ...missed,
      cacheReport: { breakpointsSent: 0, enabled: true, reported: REPORTED } },
  ], clock)));
  assert.equal(await lost("over_ttl"), before.over);
  assert.equal(await lost("under_ttl"), before.under);
});

test("a turn whose usage never mentioned the cache is not a loss", async () => {
  // cache_read defaults to zero, so a gateway that drops its final usage chunk
  // hands the loop the digits of a genuine miss. Blaming the cache for a turn
  // we could not measure is the shape of the incident this whole change is
  // about, so `reported` -- built to tell the two apart -- has to be consumed.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 8_000_000 };
  await withClock(clock, () => run(session([
    { ...wrote, advanceMsAfter: 9 * 60 * 1000 },
    { ...missed, cacheReport: { breakpointsSent: 3, enabled: true, reported: [] } },
  ], clock)));
  assert.equal(await lost("over_ttl"), before.over);
  assert.equal(await lost("under_ttl"), before.under);
});

test("a read refreshes the entry, so the gap runs from the last use", async () => {
  // Reading an entry restarts its lifetime. Timing from the original WRITE
  // would call this miss "over_ttl" -- nine minutes after the write -- when the
  // entry was in fact touched four minutes ago and its lifetime is not the
  // suspect. The distinction is the whole point of splitting the two gaps.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 9_000_000 };
  await withClock(clock, () => run(session([
    { ...wrote, advanceMsAfter: 5 * 60 * 1000 },
    // Must keep the loop running, so it reads AND there is a third turn.
    { usage: { input_tokens: 2, output_tokens: 1, cache_create: 0, cache_read: 5000 },
      stopReason: "tool_use" as const, content: [toolUse], advanceMsAfter: 4 * 60 * 1000 },
    missed,
  ], clock)));
  assert.equal(await lost("under_ttl"), before.under + 1, "measured from the read, not the write");
  assert.equal(await lost("over_ttl"), before.over);
});

test("the turn's own generation time is not charged to the gap", async () => {
  // The gateway starts the entry's clock when it receives the prompt, so the
  // gap that matters ends at THIS turn's request -- not after its tokens have
  // finished streaming. A long answer would otherwise push a four-minute gap
  // over the five-minute line and blame the lifetime for a prefix problem.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 10_000_000 };
  await withClock(clock, () => run(session([
    { ...wrote, advanceMsAfter: 4 * 60 * 1000 },
    // Four minutes since the write when the request goes out, plus two more
    // spent generating: 4 by the request clock, 6 by the response clock.
    { ...missed, advanceMsAfter: 2 * 60 * 1000 },
  ], clock)));
  assert.equal(await lost("under_ttl"), before.under + 1, "measured to the request");
  assert.equal(await lost("over_ttl"), before.over);
});

// ── Resume ──────────────────────────────────────────────────────────────────
//
// A redelivery rebuilds the loop on another pod with nothing in memory, and
// those are the most expensive losses -- a hundreds-of-turns conversation
// paying full price for a prefix it had already written. Counting them needs
// the one fact the new process does not have: whether an entry existed.
//
// That was briefly inferred from the resumed turn count, which is not the same
// question. A run resumed after a compaction has a high turn count and no
// entry, by design; so does one whose markers were refused before the
// interruption. Both were reported as losses with nothing lost, and the
// inference also routed around the two guards meant to prevent exactly that.
// The fact is carried in the checkpoint now, so these two cases can differ.

/** A checkpoint as a resumed loop receives it. */
function checkpoint(over: Partial<CheckpointState> = {}): CheckpointState {
  return {
    messages: [{ role: "user", content: "go" } as Message],
    turns_completed: 40,
    usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 40 },
    text_parts: [], error_count: 0, tool_calls_by_name: {}, total_tool_calls: 0,
    elapsed_ms_before: 0, setup_commands: [],
    ...over,
  } as CheckpointState;
}

test("a resumed run counts a loss when the checkpoint says an entry existed", async () => {
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 5_500_000 };
  await withClock(clock, () => run(
    session([missed], clock),
    { resumeFrom: checkpoint({ last_cache_use_at: clock.now - 30 * 1000 }) },
  ));
  assert.equal(
    await lost("under_ttl"), before.under + 1,
    "the timestamp survived the redelivery, so the gap is measurable and the miss is real",
  );
  assert.equal(await lost("over_ttl"), before.over);
});

test("a resumed run with no recorded cache use counts nothing", async () => {
  // Three situations produce this, and none of them is a defect: a checkpoint
  // written before the field existed, a run that compacted (which clears it
  // deliberately, because the entry is gone), and a run whose markers were
  // refused so nothing was ever written. Turn count cannot tell any of them
  // from a genuine loss, which is why it is no longer asked.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 6_500_000 };
  await withClock(clock, () => run(
    session([missed], clock),
    { resumeFrom: checkpoint() },
  ));
  assert.equal(await lost("under_ttl"), before.under, "no evidence, no counter");
  assert.equal(await lost("over_ttl"), before.over);
});

test("a resumed run records its own cache use for the next redelivery", async () => {
  // Otherwise the evidence dies with the first process that had it, and every
  // resume after the first is uncountable.
  const clock = { now: 7_500_000 };
  const seen: CheckpointState[] = [];
  await withClock(clock, () => run(
    session([{ ...wrote, advanceMsAfter: 1000 }, missed], clock),
    { onCheckpoint: async (st) => { seen.push(st); } },
  ));
  assert.ok(seen.length > 0, "the run checkpointed at least once");
  assert.ok(
    seen.some((st) => typeof st.last_cache_use_at === "number"),
    "a checkpoint written after a cache write must carry the timestamp",
  );
});

test("a resumed run with evidence is still subject to the other two guards", async () => {
  // Restoring the timestamp answers "did an entry exist". It does not answer
  // "were markers sent" or "did the provider say zero", and it must not be
  // read as answering them: the disjunct this replaced routed around both,
  // which is how a resumed run whose markers had been refused was counted.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };

  // Markers off on the resumed turn: a miss is the expected outcome.
  await withClock({ now: 8_500_000 }, () => run(
    session([{ ...missed, cacheReport: { breakpointsSent: 0, enabled: false, reported: REPORTED } }],
      { now: 8_500_000 }),
    { resumeFrom: checkpoint({ last_cache_use_at: 8_500_000 - 30 * 1000 }) },
  ));
  assert.equal(await lost("under_ttl"), before.under, "markers were never sent");

  // Usage that never mentioned the cache: unmeasurable, not a miss.
  await withClock({ now: 8_600_000 }, () => run(
    session([{ ...missed, cacheReport: { breakpointsSent: 3, enabled: true, reported: [] } }],
      { now: 8_600_000 }),
    { resumeFrom: checkpoint({ last_cache_use_at: 8_600_000 - 30 * 1000 }) },
  ));
  assert.equal(await lost("under_ttl"), before.under, "the turn could not be measured");
  assert.equal(await lost("over_ttl"), before.over);
});

test("a restored timestamp older than the TTL lands in the long-gap bucket", async () => {
  // The redelivery this was extended for: a pod died, the replacement picked
  // the task up an hour later, and the entry is gone because it expired. The
  // label has to say that rather than point at the prefix.
  const before = { over: await lost("over_ttl"), under: await lost("under_ttl") };
  const clock = { now: 9_500_000 };
  await withClock(clock, () => run(
    session([missed], clock),
    { resumeFrom: checkpoint({ last_cache_use_at: clock.now - 70 * 60 * 1000 }) },
  ));
  assert.equal(await lost("over_ttl"), before.over + 1);
  assert.equal(await lost("under_ttl"), before.under);
});
