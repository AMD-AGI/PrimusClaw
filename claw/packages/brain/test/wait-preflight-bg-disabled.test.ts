// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The pre-routing probe must not reach a sandbox for a call that is refused.
 *
 * A `wait` is classified before it is routed, because the execution slot is
 * handed back before the call is entered. With `BG_SHELL_ENABLED=false` that
 * ordering put the probe in front of the refusal: `classifyShell` went through
 * `requireHands()`, which on a lazily-attached run provisions a whole sandbox
 * for a call `route()` is about to turn away, and on a run with no sandbox at
 * all throws "No sandbox is attached to this run" -- which the loop then
 * reports in place of the refusal, so the model is never told the feature is
 * off and keeps retrying. Neither needs a model that guessed: a resumed
 * transcript still containing one `wait` is enough.
 *
 * The flag is read at module load and this file leaves it at its shipped
 * default (off), which is the case under test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import { ToolRouter } from "../src/tools/router.js";
import type { HandsClient } from "../src/clients/hands.js";
import { BG_SHELL_ENABLED } from "../src/config.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { beginRun, endRun, setParkHooks } from "../src/tasks/run-phase.js";
import { testRunIdentity } from "./support/run-identity.js";

const RUN = testRunIdentity("run-1");

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

/**
 * A run whose sandbox is not open yet, with the attach recorded rather than
 * stubbed away -- opening one is the cost this guards against, so a fixture
 * that quietly hands a client back could not see it happen.
 */
function lazyRouter(): { router: ToolRouter; attaches: number } {
  const state = { attaches: 0 };
  const hands = {
    async callToolFull() { return { text: "ok", isError: false }; },
    async classifyShell() { return { shellClass: "running", collectorLive: true }; },
  } as unknown as HandsClient;
  // The attach callback is the router's fourth parameter. `tsc` covers `src`
  // only, so a constructor change that shifts it is invisible here: the
  // callback would land past the end, `attachHands` would stay undefined, and
  // every `attaches === 0` below would hold for the wrong reason. The control
  // test after this fixture is what notices.
  const router = new ToolRouter(
    null, undefined, undefined,
    async () => {
      state.attaches += 1;
      return hands;
    },
  );
  return { router, get attaches() { return state.attaches; } };
}

test("the flag this file tests is off", () => {
  assert.equal(BG_SHELL_ENABLED, false,
    "every assertion below is about the disabled deployment and would pass "
      + "vacuously against the other one");
});

test("the fixture's attach callback is wired: a sandbox call opens exactly one", async () => {
  // Control for the two `attaches === 0` assertions below. A callback that
  // never reaches the router makes them pass whatever the router does, so
  // prove here that a call which really needs a sandbox does provision one.
  const lazy = lazyRouter();
  await lazy.router.route("bash", { command: "echo hi" });
  assert.equal(lazy.attaches, 1,
    "the lazy-attach callback never reached the router, so the zero-attach "
      + "assertions in this file prove nothing");
});

test("classifying a shell opens no sandbox when the wait would be refused", async () => {
  const lazy = lazyRouter();
  const probe = await lazy.router.classifyShell("bg-1");

  assert.equal(lazy.attaches, 0,
    "a sandbox provisioned for a call that is about to be turned away");
  assert.ok(!["running", "unverified_running", "spawn_indeterminate"].includes(probe.shellClass),
    "a refused call never runs, so it must not read as one that can block");
});

test("a run with no sandbox at all classifies without throwing", async () => {
  // `requireHands()` has nothing to fall back on here and throws; reaching it
  // is the defect, and the throw is how it reached the model.
  const router = new ToolRouter(null);
  const probe = await router.classifyShell("bg-1");
  assert.equal(probe.collectorLive, false);
});

/** One `wait` through the real loop and the real router. */
async function runWait(router: ToolRouter): Promise<{ parks: string[]; results: string[] }> {
  const parks: string[] = [];
  const results: string[] = [];
  setParkHooks({
    park: () => { parks.push("park"); return true; },
    unpark: async () => { parks.push("unpark"); },
  });
  const opts: LoopOptions = {
    model: "test-model", apiUrl: "http://localhost:0", apiKey: "test-key", maxTurns: 4,
    router,
    onEvent: async (e: Record<string, unknown>) => {
      if (e.type === "toolUsed") results.push(String(e.description ?? ""));
    },
    sessionId: "sess-1", userId: "user-1",
    llmSession: scripted([
      { content: [toolUse("t1", "wait", { shell_id: "bg-1" })], stopReason: "tool_use" },
      { content: [textBlock("ok")], stopReason: "end_turn" },
    ]),
    runIdentity: RUN,
  } as unknown as LoopOptions;

  beginRun(RUN.key);
  try {
    await agentLoop([{ role: "user", content: "wait" }], TOOLS, opts);
  } finally {
    endRun(RUN.key);
    setParkHooks(null);
  }
  return { parks, results };
}

test("a resumed wait is answered with the refusal, not with a missing sandbox", async () => {
  const router = new ToolRouter(null);
  const { parks, results } = await runWait(router);

  assert.ok(results.some((r) => /disabled/.test(r)),
    `the model must read the refusal it can act on, got ${JSON.stringify(results)}`);
  assert.ok(!results.some((r) => /No sandbox is attached/.test(r)),
    "the probe's failure stood in for the answer");
  assert.deepEqual(parks, [],
    "a call that is refused before it is sent blocks on nothing, so no "
      + "execution slot is handed back for it");
});

test("the loop's wait does not provision a sandbox for a refused call", async () => {
  const lazy = lazyRouter();
  const { results } = await runWait(lazy.router);

  assert.equal(lazy.attaches, 0);
  assert.ok(results.some((r) => /disabled/.test(r)));
});
