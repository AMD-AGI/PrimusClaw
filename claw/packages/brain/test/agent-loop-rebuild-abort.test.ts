// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Does a cancelled task still provision a sandbox?
//
// Session cleanup does two things at once: it aborts the running task and it
// destroys that session's resources. Those happen on different replicas, so in
// no fixed order, and a teardown that lands first is indistinguishable from a
// dead sandbox in here — the tool calls fail with connection errors and trip
// the in-flight rebuild. Deleting a session could therefore build a new sandbox
// for it, and spend the two-minute create doing so.
//
// The loop checks the abort signal rather than relying on the ordering, which
// is what makes the race moot. These tests pin that, and alongside it the rest
// of the loop's side of recovery: what it counts, when it asks for a repair,
// and what it tells the model afterwards. Which repair to make is not its
// decision -- see incident-sandbox-rebuild.test.ts for that.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import type { HandsRecoveryAction } from "../src/agent/index.js";

function scriptedSession(
  turns: Array<Partial<LlmTurnResult>>,
  /** Every prompt the loop builds, so a test can assert what the model was told. */
  seen?: Message[][],
): LlmSession {
  let i = 0;
  return {
    async streamTurn(messages: Message[], _tools: ToolSchema[]) {
      seen?.push(structuredClone(messages));
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

const TOOLS: ToolSchema[] = [
  { name: "bash", description: "run a command", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

/** The shape undici reports when the sandbox stops accepting connections. */
function connectionRefused(): Error {
  const err = new Error("fetch failed") as Error & { cause?: unknown };
  err.cause = { code: "ECONNREFUSED" };
  return err;
}

function socketError(): Error {
  const err = new Error("fetch failed") as Error & { cause?: unknown };
  err.cause = { code: "UND_ERR_SOCKET" };
  return err;
}

interface BatchOutcome {
  recoveries: number;
  events: Array<Record<string, unknown>>;
  /** Text blocks the loop appended to the tool results, in order. */
  notices: string[];
  /** Clients handed to the router, in order. */
  swapped: unknown[];
}

/**
 * Drive one turn whose whole tool batch fails against an unreachable sandbox —
 * enough consecutive failures to trip the recovery — and report what the loop
 * did about it.
 *
 * `onFirstCall` runs inside the first tool call, which is where a concurrent
 * session cleanup would land: mid-batch, not before the loop starts.
 */
async function runBatchAgainstDeadSandbox(opts: {
  signal?: AbortSignal;
  onFirstCall?: () => void;
  fail?: () => Error;
  action?: HandsRecoveryAction;
  recreateThrows?: string;
  calls?: number;
}): Promise<BatchOutcome> {
  const out: BatchOutcome = { recoveries: 0, events: [], notices: [], swapped: [] };
  const prompts: Message[][] = [];
  let call = 0;
  const fail = opts.fail ?? connectionRefused;
  const router = {
    route: async () => {
      if (++call === 1) opts.onFirstCall?.();
      throw fail();
    },
    setHands: (h: unknown) => { out.swapped.push(h); },
  } as unknown as ToolRouter;

  const loopOpts = {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: 3,
    router,
    onEvent: async (evt: Record<string, unknown>) => { out.events.push(evt); },
    sessionId: "sess-cleanup",
    userId: "user-1",
    signal: opts.signal,
    llmSession: scriptedSession([
      {
        content: Array.from({ length: opts.calls ?? 3 }, (_, i) => toolUse(`t${i + 1}`, "bash")),
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" } as LlmContentBlock], stopReason: "end_turn" },
    ], prompts),
    recreateHands: async () => {
      out.recoveries++;
      if (opts.recreateThrows) throw new Error(opts.recreateThrows);
      return { hands: { id: out.recoveries } as never, action: opts.action ?? "rebuilt" };
    },
  } as unknown as LoopOptions;

  await agentLoop([{ role: "user", content: "run something long" }], TOOLS, loopOpts);
  // Read the notice off the prompt of the turn that followed the batch: it is
  // appended as a text block among the tool results, and that prompt is the
  // only place it reaches the model at all.
  out.notices = (prompts.at(-1) ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b): b is { type: "text"; text: string } =>
      (b as { type?: string })?.type === "text")
    .map((b) => b.text);
  return out;
}

function statuses(out: BatchOutcome, status: string): Array<Record<string, unknown>> {
  return out.events.filter((e) => e.type === "sandboxStatus" && e.status === status);
}

test("a task cancelled mid-batch does not rebuild the sandbox it just lost", async () => {
  const ac = new AbortController();

  const { recoveries } = await runBatchAgainstDeadSandbox({
    signal: ac.signal,
    // Session cleanup aborting the task while its tool calls are in flight,
    // which is exactly when a concurrent teardown makes them fail.
    onFirstCall: () => ac.abort(),
  });

  assert.equal(recoveries, 0, "a cancelled task must not provision a replacement sandbox");
});

test("an uncancelled task still rebuilds when its sandbox dies", async () => {
  // The guard must not disarm ordinary recovery: a sandbox that dies on its own
  // is still the case the rebuild exists for.
  const { recoveries } = await runBatchAgainstDeadSandbox({});

  assert.equal(recoveries, 1, "a live task must still recover from a dead sandbox");
});

test("every class of MCP network error reaches recovery the same way", async () => {
  // The loop used to sort these itself, guessing from the error code whether
  // the container might still be there, and never counting the ambiguous ones.
  // It has no opinion now: it counts them and asks. What the sandbox actually
  // is gets established by looking at it.
  for (const fail of [socketError, connectionRefused]) {
    const out = await runBatchAgainstDeadSandbox({ fail });
    assert.equal(out.recoveries, 1, fail.name);
    assert.deepEqual(
      statuses(out, "tool_unreachable").map((e) => e.consecutive_errors),
      [1, 3],
      fail.name,
    );
  }
});

test("one batch asks for one recovery, however many calls failed in it", async () => {
  // Three failures, one repair: recovery runs after the batch so it cannot pull
  // the sandbox out from under calls still in flight, and the threshold being
  // crossed twice mid-batch must not queue two of them.
  const out = await runBatchAgainstDeadSandbox({});
  assert.equal(out.recoveries, 1);
  assert.equal(out.swapped.length, 1, "the router is handed the new client exactly once");
});

test("past the threshold, a long batch stays quiet", async () => {
  // The three-call batch cannot tell `=== threshold` from `>= threshold`:
  // its last call is both. With six, `>=` would let calls 3-6 through and put
  // four more events on the wire, which is the flood in slower motion. Only
  // the crossing itself is worth an event; after it, a repair is already
  // queued and every further failure in the batch says the same thing.
  const out = await runBatchAgainstDeadSandbox({ calls: 6 });
  assert.deepEqual(
    statuses(out, "tool_unreachable").map((e) => e.consecutive_errors),
    [1, 3],
    "only the first error and the threshold crossing are announced",
  );
});

test("a failing batch reports its first error and its threshold, not every call", async () => {
  // Both ends of the 5s window. The batch is three calls on one tool, so an
  // unthrottled emit ships three near-identical events -- and a real batch can
  // be twenty. What a reader needs is the two moments that differ: the sandbox
  // stopped answering, and a repair is about to run.
  //
  // The window is keyed on `${status}:${tool}` alone. Putting the per-emit
  // counter in that key instead gives every event a key of its own, which
  // reads like throttling and does nothing. The threshold event gets through
  // by asking for no throttle, which is visible at the call site.
  const out = await runBatchAgainstDeadSandbox({});
  assert.deepEqual(
    statuses(out, "tool_unreachable").map((e) => e.consecutive_errors),
    [1, 3],
    "the middle of the batch is repetition and is collapsed",
  );
});

test("the model is told which repair happened, not just that one did", async () => {
  // Accuracy is load-bearing: a model told the sandbox was replaced assumes its
  // background shells are gone and re-runs finished work, and one told nothing
  // changed keeps polling a shell id that a rebuild dropped.
  const cases: Array<[HandsRecoveryAction, RegExp]> = [
    ["rebuilt", /has been replaced/],
    ["reconnected", /reachable all along/],
    ["hands_restarted", /same container/],
    ["left_alone", /could not be repaired/],
  ];
  for (const [action, expected] of cases) {
    const out = await runBatchAgainstDeadSandbox({ action });
    assert.ok(
      out.notices.some((n) => expected.test(n)),
      `${action} must be described to the model: ${out.notices.join(" / ")}`,
    );
    assert.equal(statuses(out, `recovery_${action}`).length, 1, action);
  }
});

test("a recovery that refuses outright is reported, not swallowed", async () => {
  // The clearest case is a DAG node declining to destroy a sandbox it inherited.
  // The loop cannot fix that, and hiding it would leave the model retrying a
  // tool that will never work with no idea why.
  const out = await runBatchAgainstDeadSandbox({
    recreateThrows: "sandbox_spec.use='train' inherited a sandbox that is gone",
  });
  assert.equal(out.recoveries, 1);
  const failed = statuses(out, "recovery_failed");
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.error), /inherited a sandbox/);
  assert.ok(out.notices.some((n) => /could not be recovered/.test(n)));
});
