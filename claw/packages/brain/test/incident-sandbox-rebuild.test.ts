// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Incident-shaped coverage for the Hyperloom holder-kill path.
 *
 * Both production incidents had the same killer: Hands MCP network errors were
 * treated as "sandbox is dead", so recreateHands destroyed the pod and
 * SIGTERM'd the in-container GPU holder. The container itself was still
 * answering data-plane exec.
 *
 *   INCIDENT-20260818  UND_ERR_SOCKET during NFS flush; exec still worked.
 *   INCIDENT-20260801  UND_ERR_SOCKET then ECONNREFUSED after codeinterpreter
 *                      died; keepalive exec still succeeded.
 *
 * A holder flag stands in for that process: only a destroy may clear it.
 *
 * The first fix for these kept the holder by declining to recover at all, which
 * bought the holder's life at the price of never repairing anything -- so a
 * container that outlived its tool server produced an unbounded run of
 * identical failures. These tests now assert both halves: the holder survives,
 * *and* something is attempted, *and* the attempts stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import {
  HandsRecoveryBudgetExhausted,
  type HandsRecoveryAction,
  type HandsRecoveryAllowance,
} from "../src/agent/index.js";
import type { ContainerProbeVerdict } from "../src/sandbox/container-probe.js";

const TOOLS: ToolSchema[] = [
  { name: "bash", description: "run a command", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

function scriptedSession(turns: Array<Partial<LlmTurnResult>>): LlmSession {
  let i = 0;
  return {
    async streamTurn(_messages: Message[], _tools: ToolSchema[]) {
      const turn = turns[i++];
      if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: turn.content ?? [],
        stopReason: turn.stopReason ?? "end_turn",
        usage: turn.usage ?? { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: turn.firstByteMs ?? 1,
      };
    },
    async complete() {
      return "summary";
    },
  } as unknown as LlmSession;
}

function toolUse(id: string, name: string): LlmContentBlock {
  return { type: "tool_use", id, name, input: {} } as LlmContentBlock;
}

function netErr(code: string): Error {
  const err = new Error("fetch failed") as Error & { cause?: unknown };
  err.cause = { code };
  return err;
}

interface HolderWorld {
  holderAlive: boolean;
  destroyCount: number;
  recreateCalls: number;
  actions: HandsRecoveryAction[];
  events: Array<Record<string, unknown>>;
}

interface SandboxWorldState {
  /** What data-plane exec would say about the container. */
  probe: ContainerProbeVerdict;
  /** Whether Hands answers /health inside that container. */
  handsHealthy: boolean;
  /** Whether starting Hands again in place would succeed. */
  restartOk?: boolean;
}

/**
 * The decision TaskRunner.recreateHands makes, in the terms the sandbox is
 * actually in. Duplicated here rather than imported because the point of these
 * tests is the loop's behaviour given each outcome, and standing up the real
 * runner would drag in KV, S3 and a provider to get at it.
 */
function decide(state: SandboxWorldState): HandsRecoveryAction {
  if (state.probe !== "dead") {
    if (state.handsHealthy) return "reconnected";
    if (state.probe === "alive" && state.restartOk) return "hands_restarted";
    return "left_alone";
  }
  return "rebuilt";
}

async function runIncidentBatch(opts: {
  fails: Array<() => Error>;
  state: SandboxWorldState;
  turns?: number;
}): Promise<HolderWorld> {
  const world: HolderWorld = {
    holderAlive: true,
    destroyCount: 0,
    recreateCalls: 0,
    actions: [],
    events: [],
  };
  let call = 0;
  const router = {
    route: async () => {
      const fail = opts.fails[Math.min(call, opts.fails.length - 1)];
      call++;
      throw fail();
    },
    setHands: () => {},
  } as unknown as ToolRouter;

  const toolTurns = opts.turns ?? 1;
  const scripted: Array<Partial<LlmTurnResult>> = [];
  for (let t = 0; t < toolTurns; t++) {
    scripted.push({
      content: [toolUse(`t${t}a`, "bash"), toolUse(`t${t}b`, "bash"), toolUse(`t${t}c`, "bash")],
      stopReason: "tool_use",
    });
  }
  scripted.push({
    content: [{ type: "text", text: "done" } as LlmContentBlock],
    stopReason: "end_turn",
  });

  const loopOpts = {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: toolTurns + 1,
    router,
    onEvent: async (evt: Record<string, unknown>) => {
      world.events.push(evt);
    },
    sessionId: "sess-incident",
    userId: "user-1",
    llmSession: scriptedSession(scripted),
    recreateHands: async (
      allowance: HandsRecoveryAllowance = { rebuild: true, nondestructive: true },
    ) => {
      const action = decide(opts.state);
      if (action === "rebuilt" && !allowance.rebuild) {
        throw new HandsRecoveryBudgetExhausted("rebuild");
      }
      if (action !== "rebuilt" && !allowance.nondestructive) {
        throw new HandsRecoveryBudgetExhausted("recovery");
      }
      world.recreateCalls++;
      world.actions.push(action);
      if (action === "rebuilt") {
        world.holderAlive = false;
        world.destroyCount++;
      }
      return { hands: {} as never, action };
    },
  } as unknown as LoopOptions;

  await agentLoop(
    [{ role: "user", content: "continue while a background holder is running" }],
    TOOLS,
    loopOpts,
  );
  return world;
}

function sandboxStatuses(world: HolderWorld, status: string): Array<Record<string, unknown>> {
  return world.events.filter((e) => e.type === "sandboxStatus" && e.status === status);
}

test("INCIDENT-20260818: UND_ERR_SOCKET during a live exec does not SIGTERM the holder", async () => {
  const world = await runIncidentBatch({
    fails: [() => netErr("UND_ERR_SOCKET")],
    state: { probe: "alive", handsHealthy: true },
  });
  assert.equal(world.holderAlive, true, "the in-container holder must survive an MCP socket blip");
  assert.equal(world.destroyCount, 0);
  // The recovery is entered now, where before it was skipped outright. That is
  // the point: the sandbox was fine and the *client* was stale, and only
  // something that looks at the sandbox can tell those apart.
  assert.deepEqual(world.actions, ["reconnected"]);
  assert.equal(sandboxStatuses(world, "recovery_rebuilt").length, 0);
  assert.equal(sandboxStatuses(world, "recovery_reconnected").length, 1);
});

test("every MCP failure counts, so a live container cannot mask a dead Hands", async () => {
  // The regression that mattered most: these errors used to reset the counter
  // to zero whenever the container answered, so the threshold was unreachable
  // and no recovery ever ran.
  const world = await runIncidentBatch({
    fails: [() => netErr("UND_ERR_SOCKET")],
    state: { probe: "alive", handsHealthy: true },
  });
  // The count advances on every failure; the event stream shows the first and
  // the one that reaches the threshold, with the repetition between them
  // collapsed by the 5s window. Reaching 3 is what proves nothing reset it.
  assert.deepEqual(
    sandboxStatuses(world, "tool_unreachable").map((e) => e.consecutive_errors),
    [1, 3],
  );
});

test("INCIDENT-20260801: a dead Hands in a live container is restarted, not replaced", async () => {
  const world = await runIncidentBatch({
    fails: [() => netErr("UND_ERR_SOCKET"), () => netErr("ECONNREFUSED")],
    state: { probe: "alive", handsHealthy: false, restartOk: true },
  });
  assert.equal(world.holderAlive, true, "codeinterpreter dying must not stop a live container");
  assert.equal(world.destroyCount, 0);
  assert.deepEqual(world.actions, ["hands_restarted"]);
  const unreachable = sandboxStatuses(world, "tool_unreachable");
  assert.equal(unreachable[0]?.reason, "UND_ERR_SOCKET");
  assert.equal(unreachable[1]?.reason, "ECONNREFUSED");
});

test("INCIDENT-20260801 destroy gate: ECONNREFUSED keeps the holder when exec works", async () => {
  const world = await runIncidentBatch({
    fails: [() => netErr("ECONNREFUSED")],
    state: { probe: "alive", handsHealthy: true },
  });
  assert.equal(world.holderAlive, true);
  assert.equal(world.destroyCount, 0);
  assert.equal(sandboxStatuses(world, "recovery_rebuilt").length, 0);
});

test("an unreachable control plane destroys nothing, having established nothing", async () => {
  const world = await runIncidentBatch({
    fails: [() => netErr("ECONNREFUSED")],
    state: { probe: "unknown", handsHealthy: false },
  });
  assert.equal(world.holderAlive, true, "a probe that could not answer is not a licence to destroy");
  assert.equal(world.destroyCount, 0);
  assert.deepEqual(world.actions, ["left_alone"]);
});

test("a genuinely dead container still replaces the sandbox and the holder is gone", async () => {
  const world = await runIncidentBatch({
    fails: [() => netErr("ECONNREFUSED")],
    state: { probe: "dead", handsHealthy: false },
  });
  assert.equal(world.holderAlive, false);
  assert.equal(world.destroyCount, 1);
  assert.equal(world.recreateCalls, 1);
  assert.deepEqual(
    sandboxStatuses(world, "tool_unreachable").map((e) => e.consecutive_errors),
    [1, 3],
  );
  assert.ok(sandboxStatuses(world, "recovery_rebuilt").length > 0);
});

test("a sandbox that cannot be repaired stops being retried, and says so", async () => {
  // The activelock, from the other side. Nothing here can ever work: the
  // container is up, Hands will not start, and the holder means a rebuild is
  // the wrong answer. The run must still stop attempting.
  const world = await runIncidentBatch({
    fails: [() => netErr("UND_ERR_SOCKET")],
    state: { probe: "alive", handsHealthy: false, restartOk: false },
    turns: 5,
  });
  assert.equal(world.holderAlive, true);
  assert.equal(
    world.recreateCalls, 3,
    "recovery must stop at the per-task budget instead of running every batch",
  );
  assert.ok(
    sandboxStatuses(world, "recovery_exhausted").length > 0,
    "the model has to be told that tools will keep failing",
  );
});
