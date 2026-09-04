// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// llm-cache-metrics.test.ts
//
// Drives the real agent loop and reads the shared prom-client registry
// afterwards. Reading the registry by metric name proves two things at once:
// that a production line calls the helper, and that the metric is registered
// where the /metrics route can actually scrape it.
//
// metrics-labels.test.ts deliberately only proves the helpers do not throw --
// it says so itself. That is not enough for a metric whose entire job is to
// make a silent failure visible: a counter nothing increments looks exactly
// like a counter reporting good news.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { registry } from "../src/infra/metrics.js";

async function counter(name: string, labels?: Record<string, string>): Promise<number> {
  const m = registry.getSingleMetric(name);
  if (!m) return NaN; // unregistered: invisible on /metrics
  const v = await m.get();
  const row = v.values.find((x: any) =>
    !labels || Object.entries(labels).every(([k, val]) => x.labels?.[k] === val));
  return row?.value ?? 0;
}

function session(turn: Partial<LlmTurnResult>): LlmSession {
  let sent = false;
  return {
    async streamTurn() {
      const t: LlmTurnResult = {
        content: [], stopReason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
        ...turn,
      } as LlmTurnResult;
      if (sent) throw new Error("one turn only");
      sent = true;
      return t;
    },
    async complete() { return "s"; },
  };
}

function run(turn: Partial<LlmTurnResult>, events: Record<string, unknown>[] = []) {
  const opts: LoopOptions = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 2,
    router: ({ route: async () => "ok", setHands: () => {} }) as unknown as ToolRouter,
    sessionId: "s", userId: "u",
    llmSession: session(turn),
    onEvent: async (e: unknown) => { events.push(e as Record<string, unknown>); },
  };
  return agentLoop([{ role: "user", content: "hi" } as Message], [] as ToolSchema[], opts);
}

test("a cache hit is counted, and reported kinds decide which series exist", async () => {
  const before = {
    hit: await counter("claw_brain_llm_cache_turns_total", { state: "hit" }),
    read: await counter("claw_brain_llm_tokens_total", { kind: "cache_read" }),
    create: await counter("claw_brain_llm_tokens_total", { kind: "cache_create" }),
  };
  await run({
    usage: { input_tokens: 12, output_tokens: 3, cache_read: 500_000, cache_create: 900 },
    cacheReport: { breakpointsSent: 3, enabled: true, reported: ["cache_read", "cache_create"] },
  });
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "hit" }), before.hit + 1);
  assert.equal(await counter("claw_brain_llm_tokens_total", { kind: "cache_read" }), before.read + 500_000);
  assert.equal(await counter("claw_brain_llm_tokens_total", { kind: "cache_create" }), before.create + 900);
});

test("a large uncached turn is counted as a miss -- the incident's own signal", async () => {
  const before = await counter("claw_brain_llm_cache_turns_total", { state: "miss" });
  await run({
    usage: { input_tokens: 600_000, output_tokens: 3, cache_read: 0, cache_create: 0 },
    cacheReport: { breakpointsSent: 3, enabled: true, reported: ["cache_read", "cache_create"] },
  });
  // Markers went out and nothing came back: exactly the shape that ran for
  // 2,282 calls unnoticed.
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "miss" }), before + 1);
});

test("a provider that cannot report writes emits no cache_create series entry", async () => {
  const before = await counter("claw_brain_llm_tokens_total", { kind: "cache_create" });
  await run({
    // A non-zero value the provider has NOT vouched for. `reported` governs,
    // not the number: whatever is in the field, a provider that did not claim
    // to observe it must not have it recorded as an observation. Testing this
    // with a zero would pass whether the branch existed or not.
    usage: { input_tokens: 100, output_tokens: 3, cache_read: 40, cache_create: 999 },
    cacheReport: { breakpointsSent: 0, enabled: false, reported: ["cache_read"] },
  });
  assert.equal(
    await counter("claw_brain_llm_tokens_total", { kind: "cache_create" }), before,
    "an unreportable field must not be recorded as an observed zero",
  );
});

test("breakpoints sent are observed off the turn", async () => {
  const m = registry.getSingleMetric("claw_brain_llm_cache_breakpoints_sent");
  assert.ok(m, "histogram must be registered on the shared registry");
  const before = (await m.get()).values.find((v: any) => v.metricName?.endsWith("_count"))?.value ?? 0;
  await run({
    usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
    cacheReport: { breakpointsSent: 3, enabled: true, reported: ["cache_read", "cache_create"] },
  });
  const after = (await m.get()).values.find((v: any) => v.metricName?.endsWith("_count"))?.value ?? 0;
  assert.equal(after, before + 1);
});

test("a session with no cacheReport is counted as off, not as a hit", async () => {
  // Every pre-existing test double omits cacheReport, and so would a provider
  // that forgot to fill it. Silence must not read as success.
  const before = await counter("claw_brain_llm_cache_turns_total", { state: "off" });
  await run({ usage: { input_tokens: 5, output_tokens: 1, cache_read: 0, cache_create: 0 } });
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "off" }), before + 1);
});

test("per-turn events carry the cache numbers", async () => {
  // The structural blindness this fixes: cache_read and cache_create used to
  // appear only in the terminal ResultMessage, and a twelve-hour monitor
  // session never reaches one.
  const events: Record<string, unknown>[] = [];
  await run({
    content: [{ type: "text", text: "hello" }],
    usage: { input_tokens: 12, output_tokens: 3, cache_read: 777, cache_create: 88 },
    cacheReport: { breakpointsSent: 2, enabled: true, reported: ["cache_read", "cache_create"] },
  }, events);
  const msg = events.find((e) => e.type === "AssistantMessage");
  assert.ok(msg, "expected a per-turn AssistantMessage");
  assert.equal(msg.turn_cache_read_tokens, 777);
  assert.equal(msg.turn_cache_create_tokens, 88);
  assert.equal(msg.cache_breakpoints_sent, 2);
});

async function ttlWrite(ttl: string): Promise<number> {
  return counter("claw_brain_llm_cache_write_tokens_total", { ttl });
}

test("a write is counted under the lifetime the gateway actually granted", async () => {
  const before = await ttlWrite("1h");
  await run({
    usage: { input_tokens: 2, output_tokens: 1, cache_read: 0, cache_create: 900 },
    cacheReport: {
      breakpointsSent: 2, enabled: true, reported: ["cache_read", "cache_create"],
      createdEphemeral5m: 0, createdEphemeral1h: 900,
    },
  });
  assert.equal(await ttlWrite("1h"), before + 900);
});

test("a 1h request answered with a 5m write is visible as such", async () => {
  // The failure this exists for is a 200 OK: the request succeeds, the cache
  // works, and the entry expires under the sleep it was chosen to outlast.
  // Nothing else in the usage numbers distinguishes it.
  const before = await ttlWrite("5m");
  await run({
    usage: { input_tokens: 2, output_tokens: 1, cache_read: 0, cache_create: 900 },
    cacheReport: {
      breakpointsSent: 2, enabled: true, reported: ["cache_read", "cache_create"],
      createdEphemeral5m: 900, createdEphemeral1h: 0,
    },
  });
  assert.equal(await ttlWrite("5m"), before + 900, "a silent downgrade must show up under ttl=5m");
});

test("a gateway that sends no breakdown is recorded as unreported, not as a lifetime", async () => {
  const before = { m5: await ttlWrite("5m"), h1: await ttlWrite("1h"), un: await ttlWrite("unreported") };
  await run({
    usage: { input_tokens: 2, output_tokens: 1, cache_read: 0, cache_create: 700 },
    cacheReport: { breakpointsSent: 2, enabled: true, reported: ["cache_read", "cache_create"] },
  });
  assert.equal(await ttlWrite("unreported"), before.un + 700);
  assert.equal(await ttlWrite("5m"), before.m5, "must not be attributed to a lifetime nobody stated");
  assert.equal(await ttlWrite("1h"), before.h1);
});

test("the per-turn event carries the split when the gateway sent one", async () => {
  const events: Record<string, unknown>[] = [];
  await run({
    content: [{ type: "text", text: "hi" }],
    usage: { input_tokens: 2, output_tokens: 1, cache_read: 10, cache_create: 500 },
    cacheReport: {
      breakpointsSent: 3, enabled: true, reported: ["cache_read", "cache_create"],
      createdEphemeral5m: 0, createdEphemeral1h: 500,
    },
  }, events);
  const msg = events.find((e) => e.type === "AssistantMessage");
  assert.equal(msg?.turn_cache_create_1h, 500);
  assert.equal(msg?.turn_cache_create_5m, 0);
});

test("a backend that caches on its own is a hit, not 'off'", async () => {
  // Genuine OpenAI caches automatically: a turn can come back with a read on a
  // request where we sent no markers. Labelling that "off" while the same turn
  // increments cache_read said two contradictory things about one request.
  const before = {
    hit: await counter("claw_brain_llm_cache_turns_total", { state: "hit" }),
    off: await counter("claw_brain_llm_cache_turns_total", { state: "off" }),
  };
  await run({
    usage: { input_tokens: 100, output_tokens: 3, cache_read: 4_000, cache_create: 0 },
    cacheReport: { breakpointsSent: 0, enabled: false, reported: ["cache_read"] },
  });
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "hit" }), before.hit + 1);
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "off" }), before.off);
});

test("off means we sent nothing AND the response said nothing", async () => {
  const before = await counter("claw_brain_llm_cache_turns_total", { state: "off" });
  await run({
    usage: { input_tokens: 100, output_tokens: 3, cache_read: 0, cache_create: 0 },
    cacheReport: { breakpointsSent: 0, enabled: false, reported: [] },
  });
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "off" }), before + 1);
});

test("a backend that caches on its own gets misses, not off", async () => {
  // We sent no markers, but the response reported a read of zero -- genuine
  // OpenAI does exactly this on the turns it does not hit. Filing those under
  // "off" while its hits count as "hit" leaves a denominator with no misses
  // in it, i.e. a hit rate that can only ever read 100%.
  const before = {
    off: await counter("claw_brain_llm_cache_turns_total", { state: "off" }),
    miss: await counter("claw_brain_llm_cache_turns_total", { state: "miss" }),
  };
  await run({
    usage: { input_tokens: 100, output_tokens: 3, cache_read: 0, cache_create: 0 },
    cacheReport: { breakpointsSent: 0, enabled: false, reported: ["cache_read"] },
  });
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "miss" }), before.miss + 1);
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "off" }), before.off);
});

test("a turn whose usage never arrived is unreported, not a miss", async () => {
  // Both cache numbers default to zero, so a dropped final usage chunk
  // produces the digits of a genuine miss. Counting it as one moves a hit-rate
  // denominator on a measurement that was never taken.
  const before = {
    miss: await counter("claw_brain_llm_cache_turns_total", { state: "miss" }),
    unreported: await counter("claw_brain_llm_cache_turns_total", { state: "unreported" }),
  };
  await run({
    usage: { input_tokens: 100, output_tokens: 3, cache_read: 0, cache_create: 0 },
    cacheReport: { breakpointsSent: 2, enabled: true, reported: [] },
  });
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "unreported" }), before.unreported + 1);
  assert.equal(await counter("claw_brain_llm_cache_turns_total", { state: "miss" }), before.miss);
});

test("every cache series carries the wire protocol that produced it", async () => {
  // Without this label the two shapes are summed into one number that is true
  // of neither: OpenAI's input_tokens already contains the cached portion and
  // Anthropic's does not, so cache_read/(input+cache_read+cache_create) means
  // something different depending on a mix the reader cannot see. A fleet
  // mid-rollout speaks both at once. The label is what makes the sum legible,
  // so an unlabelled series is a bug, not a cosmetic gap.
  const { getProvider } = await import("../src/llm/index.js");
  const wire = getProvider().name;

  const before = await counter("claw_brain_llm_tokens_total", { kind: "cache_read", provider: wire });
  await run({
    usage: { input_tokens: 7, output_tokens: 3, cache_read: 4_242, cache_create: 11 },
    cacheReport: { breakpointsSent: 1, enabled: true, reported: ["cache_read", "cache_create"] },
  });
  assert.equal(
    await counter("claw_brain_llm_tokens_total", { kind: "cache_read", provider: wire }),
    before + 4_242,
    "tokens must be attributed to a wire protocol",
  );

  // No row of any of the three may be missing it -- an unlabelled row would
  // silently rejoin the blended total the label exists to split.
  const { registry } = await import("../src/infra/metrics.js");
  for (const name of [
    "claw_brain_llm_tokens_total",
    "claw_brain_llm_cache_turns_total",
    "claw_brain_llm_cache_write_tokens_total",
  ]) {
    const m = registry.getSingleMetric(name);
    assert.ok(m, `${name} must be registered`);
    const v = await m!.get();
    for (const row of v.values as Array<{ labels?: Record<string, unknown> }>) {
      assert.ok(row.labels?.provider, `${name} has a row with no provider label`);
    }
  }
});
