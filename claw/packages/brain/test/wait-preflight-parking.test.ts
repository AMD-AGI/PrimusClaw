// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * When a `wait` hands the pod's execution slot back, and when it must not.
 *
 * Parking every wait looks harmless and is not: a wait on a shell nobody can
 * ever emit an exit event for -- one whose process is gone, whose claim never
 * became a process, or whose state could not be read -- returns at once, so the
 * slot is released and reacquired around a call that never blocked. Worse, the
 * decision has to be taken before the call is routed, because that is where the
 * slot is handed back, while the class is a fact only the call would return.
 *
 * So the class is read first, without blocking and without consuming output,
 * and the same value decides both.
 *
 * The park key is the other half. The run-phase ledger is keyed by the run's
 * gate/lock key while the parking sites used to pass its addressing scope; under
 * the default gate configuration those differ, the lookup missed, and the slot
 * was held for the whole of every wait with nothing logged or counted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { createServer } from "node:http";
import { HandsClient } from "../src/clients/hands.js";
import { beginRun, endRun, setParkHooks } from "../src/tasks/run-phase.js";

const TOOLS: ToolSchema[] = [
  { name: "wait", description: "wait", input_schema: { type: "object", properties: {} } },
];

function scripted(turns: Array<Partial<LlmTurnResult>>): LlmSession {
  let i = 0;
  return {
    async streamTurn(_messages: Message[], _tools: ToolSchema[]) {
      const turn = turns[i++];
      if (!turn) throw new Error("scripted session exhausted");
      return {
        content: turn.content ?? [],
        stopReason: turn.stopReason ?? "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
      } as LlmTurnResult;
    },
    async complete() { return "summary"; },
  };
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): LlmContentBlock =>
  ({ type: "tool_use", id, name, input }) as unknown as LlmContentBlock;
const textBlock = (text: string): LlmContentBlock =>
  ({ type: "text", text }) as unknown as LlmContentBlock;

/** A router answering one class, and recording what it was asked and routed. */
function classifyingRouter(shellClass: string, collectorLive = false) {
  const classified: string[] = [];
  const routed: string[] = [];
  return {
    classified,
    routed,
    router: {
      classifyShell: async (shellId: string) => {
        classified.push(shellId);
        return { shellClass, collectorLive };
      },
      route: async (name: string) => {
        routed.push(name);
        return "waited";
      },
      setHands: () => {},
    } as unknown as ToolRouter,
  };
}

/** Runs one `wait` tool call through the real loop and reports what parked. */
async function runWait(
  routerLike: ToolRouter,
  over: Partial<LoopOptions> = {},
): Promise<string[]> {
  const parkEvents: string[] = [];
  setParkHooks({
    park: () => { parkEvents.push("park"); return true; },
    unpark: async () => { parkEvents.push("unpark"); },
  });
  const opts: LoopOptions = {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: 4,
    router: routerLike,
    onEvent: async () => {},
    sessionId: "sess-1",
    userId: "user-1",
    llmSession: scripted([
      { content: [toolUse("t1", "wait", { shell_id: "bg-1" })], stopReason: "tool_use" },
      { content: [textBlock("ok")], stopReason: "end_turn" },
    ]),
    runKey: "addressing-scope",
    parkKey: "gate-lock-key",
    ...over,
  };

  beginRun((over.parkKey ?? "gate-lock-key") as string);
  try {
    await agentLoop([{ role: "user", content: "wait" }], TOOLS, opts);
  } finally {
    endRun((over.parkKey ?? "gate-lock-key") as string);
    setParkHooks(null);
  }
  return parkEvents;
}

test("a wait on a running shell parks, and classifies before it routes", async () => {
  // Order matters as much as the fact: the slot is handed back before the call
  // is entered, so a decision taken from the call's own answer is too late.
  const order: string[] = [];
  const router = {
    classifyShell: async () => { order.push("classify"); return { shellClass: "running", collectorLive: false }; },
    route: async () => { order.push("route"); return "waited"; },
    setHands: () => {},
  } as unknown as ToolRouter;

  const parkEvents: string[] = [];
  setParkHooks({
    park: () => { order.push("park"); parkEvents.push("park"); return true; },
    unpark: async () => { order.push("unpark"); parkEvents.push("unpark"); },
  });
  const opts: LoopOptions = {
    model: "test-model", apiUrl: "http://localhost:0", apiKey: "test-key", maxTurns: 4,
    router, onEvent: async () => {}, sessionId: "sess-1", userId: "user-1",
    llmSession: scripted([
      { content: [toolUse("t1", "wait", { shell_id: "bg-1" })], stopReason: "tool_use" },
      { content: [textBlock("ok")], stopReason: "end_turn" },
    ]),
    runKey: "addressing-scope", parkKey: "gate-lock-key",
  };
  beginRun("gate-lock-key");
  try {
    await agentLoop([{ role: "user", content: "wait" }], TOOLS, opts);
  } finally {
    endRun("gate-lock-key");
    setParkHooks(null);
  }

  assert.deepEqual(order, ["classify", "park", "route", "unpark"],
    "the class decides the park, and both happen before the routed call");
  assert.deepEqual(parkEvents, ["park", "unpark"]);
});

test("the execution slot is observably free while the wait is parked", async () => {
  // The whole purpose: a second run is admitted and executes while the first
  // sits on its wait. A fixture that only counts park calls cannot see whether
  // the slot actually went back.
  let held = 1;
  const observed: number[] = [];
  const router = {
    classifyShell: async () => ({ shellClass: "running", collectorLive: false }),
    route: async () => { observed.push(held); return "waited"; },
    setHands: () => {},
  } as unknown as ToolRouter;

  setParkHooks({
    park: () => { held -= 1; return true; },
    unpark: async (had: boolean) => { if (had) held += 1; },
  });
  const opts: LoopOptions = {
    model: "test-model", apiUrl: "http://localhost:0", apiKey: "test-key", maxTurns: 4,
    router, onEvent: async () => {}, sessionId: "sess-1", userId: "user-1",
    llmSession: scripted([
      { content: [toolUse("t1", "wait", { shell_id: "bg-1" })], stopReason: "tool_use" },
      { content: [textBlock("ok")], stopReason: "end_turn" },
    ]),
    runKey: "addressing-scope", parkKey: "gate-lock-key",
  };
  beginRun("gate-lock-key");
  try {
    await agentLoop([{ role: "user", content: "wait" }], TOOLS, opts);
  } finally {
    endRun("gate-lock-key");
    setParkHooks(null);
  }

  assert.deepEqual(observed, [0], "the slot was still held while the wait was in progress");
  assert.equal(held, 1, "and was reacquired exactly once on unpark");
});

test("every class that cannot block returns without touching the slot", async () => {
  // Each of these is settled already: blocking on it would hold the slot for
  // the whole timeout waiting for an event nothing present can deliver.
  for (const cls of ["finished", "lost", "unknown", "spawn_indeterminate", "unverified_running"]) {
    const { router, routed } = classifyingRouter(cls);
    const parkEvents = await runWait(router);
    assert.deepEqual(parkEvents, [], `${cls} released the execution slot`);
    assert.deepEqual(routed, ["wait"], `${cls} did not reach the tool`);
  }
});

test("a site that cannot park under a usable key says so rather than skipping", async () => {
  // The ledger helper cannot report this: a missing entry is the legitimate
  // sub-agent case there. Only the site knows it holds its own slot and can
  // name the key it passed.
  const { registry } = await import("../src/infra/metrics.js");
  const counted = async (): Promise<number> => {
    const m = (await registry.getMetricsAsJSON())
      .find((x) => x.name === "claw_brain_park_key_unusable_total") as
        { values?: Array<{ labels: Record<string, string>; value: number }> };
    return (m?.values ?? []).reduce((n, v) => n + v.value, 0);
  };

  const before = await counted();
  const { router } = classifyingRouter("running");
  const parkEvents: string[] = [];
  setParkHooks({
    park: () => { parkEvents.push("park"); return true; },
    unpark: async () => { parkEvents.push("unpark"); },
  });
  const opts: LoopOptions = {
    model: "test-model", apiUrl: "http://localhost:0", apiKey: "test-key", maxTurns: 4,
    router, onEvent: async () => {}, sessionId: "sess-1", userId: "user-1",
    llmSession: scripted([
      { content: [toolUse("t1", "wait", { shell_id: "bg-1" })], stopReason: "tool_use" },
      { content: [textBlock("ok")], stopReason: "end_turn" },
    ]),
    runKey: "addressing-scope",
    // Well-formed, and simply not the one the ledger was begun under.
    parkKey: "not-the-ledgers-key",
  };
  beginRun("gate-lock-key");
  try {
    await agentLoop([{ role: "user", content: "wait" }], TOOLS, opts);
  } finally {
    endRun("gate-lock-key");
    setParkHooks(null);
  }

  assert.deepEqual(parkEvents, [], "the wrong key parks nothing, as the helper's contract says");
  assert.ok(await counted() > before, "and the site that could not park recorded it");
});

test("ended_unreaped splits on the collector-live qualifier, not on the class", async () => {
  // The two values differ in exactly the fact a park depends on: whether a
  // party able to emit the resolving event still exists. A suite asserting one
  // of the two would pass with the qualifier ignored.
  const live = classifyingRouter("ended_unreaped", true);
  assert.deepEqual(await runWait(live.router), ["park", "unpark"]);

  const dead = classifyingRouter("ended_unreaped", false);
  assert.deepEqual(await runWait(dead.router), []);
});

test("a sandbox that cannot be classified reads as running, so the wait still parks", async () => {
  // The safe direction: a run parked once too often loses its slot for one
  // call, while one not parked when it should have been holds it for the whole
  // wait timeout. Asserted against the real client rather than a stand-in,
  // because the fallback is the client's and a stub would assert nothing.
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const client = new HandsClient(`http://127.0.0.1:${port}/mcp`, "tok", "sess-1", "run-1");
    assert.deepEqual(
      await client.classifyShell("bg-1"),
      { shellClass: "running", collectorLive: false },
    );
    const parked = await runWait(classifyingRouter("running").router);
    assert.deepEqual(parked, ["park", "unpark"]);
  } finally {
    server.close();
    await new Promise((r) => setTimeout(r, 10));
  }
});

test("the park uses the ledger's key, not the run's addressing scope", async () => {
  // The two strings differ under the default gate configuration, so a site
  // passing the addressing scope misses the ledger and never hands the slot
  // back.
  const { router } = classifyingRouter("running");
  const parked = await runWait(router, { parkKey: "gate-lock-key", runKey: "addressing-scope" });
  assert.deepEqual(parked, ["park", "unpark"]);

  // Derived from the real distinction rather than a shared literal: a site
  // passing the addressing scope finds no entry and parks nothing.
  const { router: other } = classifyingRouter("running");
  const parkEvents: string[] = [];
  setParkHooks({
    park: () => { parkEvents.push("park"); return true; },
    unpark: async () => { parkEvents.push("unpark"); },
  });
  const opts: LoopOptions = {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: 4,
    router: other,
    onEvent: async () => {},
    sessionId: "sess-1",
    userId: "user-1",
    llmSession: scripted([
      { content: [toolUse("t1", "wait", { shell_id: "bg-1" })], stopReason: "tool_use" },
      { content: [textBlock("ok")], stopReason: "end_turn" },
    ]),
    runKey: "addressing-scope",
    parkKey: "addressing-scope",
  };
  beginRun("gate-lock-key");
  try {
    await agentLoop([{ role: "user", content: "wait" }], TOOLS, opts);
  } finally {
    endRun("gate-lock-key");
    setParkHooks(null);
  }
  assert.deepEqual(parkEvents, [], "the wrong key finds no entry and parks nothing");
});

test("consecutive waits on two siblings each park", async () => {
  // N shells, one run. A fixture with a single shell cannot tell a per-run park
  // from a per-wait one.
  const classified: string[] = [];
  const router = {
    classifyShell: async (shellId: string) => {
      classified.push(shellId);
      return { shellClass: "running", collectorLive: false };
    },
    route: async () => "waited",
    setHands: () => {},
  } as unknown as ToolRouter;

  const parkEvents: string[] = [];
  setParkHooks({
    park: () => { parkEvents.push("park"); return true; },
    unpark: async () => { parkEvents.push("unpark"); },
  });
  const opts: LoopOptions = {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: 6,
    router,
    onEvent: async () => {},
    sessionId: "sess-1",
    userId: "user-1",
    llmSession: scripted([
      { content: [toolUse("t1", "wait", { shell_id: "primary" })], stopReason: "tool_use" },
      { content: [toolUse("t2", "wait", { shell_id: "monitor" })], stopReason: "tool_use" },
      { content: [textBlock("ok")], stopReason: "end_turn" },
    ]),
    runKey: "addressing-scope",
    parkKey: "gate-lock-key",
  };
  beginRun("gate-lock-key");
  try {
    await agentLoop([{ role: "user", content: "wait twice" }], TOOLS, opts);
  } finally {
    endRun("gate-lock-key");
    setParkHooks(null);
  }

  assert.deepEqual(classified, ["primary", "monitor"], "each sibling is classified on its own");
  assert.deepEqual(parkEvents, ["park", "unpark", "park", "unpark"]);
});
