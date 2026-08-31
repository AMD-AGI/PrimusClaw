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
