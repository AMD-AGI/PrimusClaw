// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What stops a doomed sandbox from being recovered forever?
//
// The two per-task budgets only bind if every attempt is charged to one of
// them, and both ways of not charging one have shipped:
//
//   - A rebuild is counted when it returns `rebuilt`. A rebuild that destroyed
//     the workload and then failed to provision a replacement returns nothing,
//     so it was charged to the non-destructive budget instead -- leaving the
//     rebuild budget at zero and the allowance to rebuild permanently granted.
//     Every later batch destroyed another workload.
//   - A refusal for a spent budget is reported and then forgotten. Which budget
//     an attempt needs is decided by the probe, inside the recovery, so the
//     loop's own `exhaustedBudget` cannot see the refusal coming: it gates on
//     both counters and one of them is still under its cap. The next batch
//     therefore paid for another probe and was refused identically.
//
// Both show up only across batches, which is why these drive several rather
// than the single one agent-loop-rebuild-abort.test.ts uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import {
  HandsRebuildFailed,
  HandsRecoveryBudgetExhausted,
  HandsRecoveryRefused,
  type HandsRecoveryAllowance,
} from "../src/agent/index.js";
import {
  SANDBOX_REBUILD_MAX_PER_TASK,
  SANDBOX_REBUILD_THRESHOLD,
} from "../src/config.js";

const TOOLS: ToolSchema[] = [
  { name: "bash", description: "run a command", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

/** The shape undici reports when the sandbox stops accepting connections. */
function connectionRefused(): Error {
  const err = new Error("fetch failed") as Error & { cause?: unknown };
  err.cause = { code: "ECONNREFUSED" };
  return err;
}

function toolUse(id: string): LlmContentBlock {
  return { type: "tool_use", id, name: "bash", input: {} } as LlmContentBlock;
}

/**
 * A turn whose whole batch fails against an unreachable sandbox.
 *
 * SANDBOX_REBUILD_THRESHOLD consecutive errors are what set `recoveryPending`,
 * and the count resets after each recovery, so one batch has to carry the whole
 * threshold for the next batch to trip it again.
 */
function deadBatchTurn(n: number): Partial<LlmTurnResult> {
  return {
    content: Array.from({ length: SANDBOX_REBUILD_THRESHOLD }, (_, i) => toolUse(`t${n}-${i}`)),
    stopReason: "tool_use",
  };
}

function scriptedSession(turns: Array<Partial<LlmTurnResult>>): LlmSession {
  let i = 0;
  return {
    async streamTurn() {
      const turn = turns[i++];
      if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: turn.content ?? [],
        stopReason: turn.stopReason ?? "end_turn",
        usage: turn.usage ?? { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: turn.firstByteMs ?? 1,
      };
    },
    async complete() { return "summary"; },
  } as unknown as LlmSession;
}

interface Attempt {
  rebuildAllowed: boolean;
  nondestructiveAllowed: boolean;
}

/**
 * Drive `batches` failing tool batches past a recovery hook that never
 * succeeds, and report every allowance it was handed.
 *
 * `recover` stands in for task-runner's `recreateHands`: the loop cannot see
 * which repair was chosen, so what the hook throws is the only thing that tells
 * it what the attempt cost.
 */
async function runFailingBatches(
  batches: number,
  recover: (allowance: HandsRecoveryAllowance, attempt: number) => never,
): Promise<{ attempts: Attempt[]; events: Array<Record<string, unknown>> }> {
  const attempts: Attempt[] = [];
  const events: Array<Record<string, unknown>> = [];
  const turns: Array<Partial<LlmTurnResult>> = [];
  for (let i = 0; i < batches; i++) turns.push(deadBatchTurn(i));
  turns.push({ content: [{ type: "text", text: "done" } as LlmContentBlock], stopReason: "end_turn" });

  await agentLoop([{ role: "user", content: "go" }], TOOLS, {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: batches + 2,
    router: {
      route: async () => { throw connectionRefused(); },
      setHands: () => {},
    } as unknown as ToolRouter,
    onEvent: async (evt: Record<string, unknown>) => { events.push(evt); },
    sessionId: "sess-budget",
    userId: "user-1",
    llmSession: scriptedSession(turns),
    recreateHands: async (allowance: HandsRecoveryAllowance) => {
      attempts.push({
        rebuildAllowed: allowance.rebuild,
        nondestructiveAllowed: allowance.nondestructive,
      });
      return recover(allowance, attempts.length);
    },
  } as unknown as LoopOptions);

  return { attempts, events };
}

function statuses(
  events: Array<Record<string, unknown>>,
  status: string,
): Array<Record<string, unknown>> {
  return events.filter((e) => e.type === "sandboxStatus" && e.status === status);
}

test("a rebuild that destroys and then fails to provision still spends the rebuild budget", async () => {
  // The hook honours its allowance the way task-runner does: it rebuilds while
  // it may, and refuses once the budget says no. Before the fix the failure was
  // charged to the non-destructive budget, `rebuild` stayed true on every
  // allowance, and this ran a destroy per batch for the life of the task.
  const BATCHES = SANDBOX_REBUILD_MAX_PER_TASK + 4;
  const { attempts } = await runFailingBatches(BATCHES, (allowance) => {
    if (!allowance.rebuild) throw new HandsRecoveryBudgetExhausted("rebuild");
    throw new HandsRebuildFailed(new Error("provision failed after destroy"));
  });

  const destructive = attempts.filter((a) => a.rebuildAllowed).length;
  assert.equal(destructive, SANDBOX_REBUILD_MAX_PER_TASK,
    `a failed rebuild must consume the budget: expected ${SANDBOX_REBUILD_MAX_PER_TASK} `
    + `destroys, got ${destructive} across ${BATCHES} batches`);
  assert.ok(attempts.length <= SANDBOX_REBUILD_MAX_PER_TASK + 1,
    `the refusal must stop the loop asking again, got ${attempts.length} attempts`);
});

test("a repair that leaves the sandbox alone is not charged to the rebuild budget", async () => {
  // The other side of the same rule: only a rebuild spends a rebuild. A plain
  // throw is the recovery declining to act, and must keep coming back while the
  // non-destructive budget lasts.
  const { attempts } = await runFailingBatches(4, () => {
    throw new Error("sandbox left alone");
  });

  assert.ok(attempts.every((a) => a.rebuildAllowed),
    "a non-destructive refusal must not burn the rebuild budget");
});

test("a budget refusal is remembered, so the next batch does not pay for the same probe", async () => {
  // The refusal costs a probe -- 8s on the tool-batch path -- and nothing about
  // it can change: neither counter ever decreases, so the same evidence gives
  // the same answer. Asking again is pure latency.
  const BATCHES = 5;
  const { attempts, events } = await runFailingBatches(BATCHES, () => {
    throw new HandsRecoveryBudgetExhausted("rebuild");
  });

  assert.equal(attempts.length, 1,
    `a refused recovery must not be re-attempted, got ${attempts.length} attempts `
    + `across ${BATCHES} batches`);
  assert.ok(statuses(events, "recovery_exhausted").length >= 1,
    "the model must still be told, on every batch that hits the latch");
});

test("the exhaustion notice names the budget that actually refused", async () => {
  const { events } = await runFailingBatches(2, () => {
    throw new HandsRecoveryBudgetExhausted("rebuild");
  });

  const exhausted = statuses(events, "recovery_exhausted");
  assert.ok(exhausted.length >= 1, "an exhausted recovery must be announced");
  assert.equal(exhausted[0]!.budget, "rebuild",
    "reporting the wrong budget sends an operator to the wrong knob");
});

test("a sandbox call that works again clears the refusal, not just the budget", async () => {
  // The latch stands for a spent budget. A successful sandbox call resets that
  // budget -- so keeping the latch turns the next unrelated failure away while
  // quoting a budget that is no longer spent.
  const attempts = [];
  const events = [];
  let toolCalls = 0;
  // Batches 1-2 fail (trip a recovery, which is refused and latches); batch 3
  // succeeds (resetting the budget); batches 4-5 fail again and must be able to
  // ask for a recovery a second time.
  const turns = [deadBatchTurn(0), deadBatchTurn(1), deadBatchTurn(2), deadBatchTurn(3), deadBatchTurn(4)];
  turns.push({ content: [{ type: "text", text: "done" }], stopReason: "end_turn" });

  await agentLoop([{ role: "user", content: "go" }], TOOLS, {
    model: "test-model", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: turns.length + 1,
    router: {
      route: async () => {
        toolCalls++;
        // The middle batch works, which is the evidence that resets the budget.
        if (toolCalls > SANDBOX_REBUILD_THRESHOLD * 2
            && toolCalls <= SANDBOX_REBUILD_THRESHOLD * 3) return "ok";
        throw connectionRefused();
      },
      setHands: () => {},
    },
    onEvent: async (e) => { events.push(e); },
    sessionId: "sess-latch", userId: "u",
    llmSession: scriptedSession(turns),
    recreateHands: async (allowance) => {
      attempts.push(allowance);
      throw new HandsRecoveryBudgetExhausted("rebuild");
    },
  });

  assert.ok(attempts.length >= 2,
    `a cleared refusal must let recovery be asked for again; attempts=${attempts.length}`);
});

test("a status publish that fails after a repair succeeded does not charge both budgets", async () => {
  // The budgets are incremented inside the same try that reports the repair,
  // and the report reaches JetStream. A transient publish failure there used
  // to fall into the failure handler for a recovery that had already
  // succeeded: it charged a second budget unit, recorded a `failed` decision
  // for a working sandbox, and told the model its sandbox could not be
  // recovered while handing it a healthy client.
  //
  // The counters are not reachable from out here, so they are read off the
  // next `recovering` event, which reports both before the attempt starts.
  const events: Array<Record<string, unknown>> = [];
  const turns: Array<Partial<LlmTurnResult>> = [
    deadBatchTurn(0),
    deadBatchTurn(1),
    { content: [{ type: "text", text: "done" } as LlmContentBlock], stopReason: "end_turn" },
  ];

  await agentLoop([{ role: "user", content: "go" }], TOOLS, {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: 4,
    router: {
      route: async () => { throw connectionRefused(); },
      setHands: () => {},
    } as unknown as ToolRouter,
    onEvent: async (evt: Record<string, unknown>) => {
      events.push(evt);
      // Only the success announcement fails, and only as a publish: the repair
      // itself completed and the loop is holding the new client.
      if (evt.type === "sandboxStatus" && evt.status === "recovery_rebuilt") {
        throw new Error("jetstream publish timeout");
      }
    },
    sessionId: "sess-emit-fails",
    userId: "user-1",
    llmSession: scriptedSession(turns),
    recreateHands: async () => ({
      hands: {} as unknown as Record<string, unknown>,
      action: "rebuilt",
      detail: "provisioned",
    }),
  } as unknown as LoopOptions);

  const recovering = statuses(events, "recovering");
  assert.equal(recovering.length, 2,
    `both batches must reach recovery, got ${recovering.length}`);
  assert.deepEqual(
    { rebuilds: recovering[1].rebuilds_used, recoveries: recovering[1].recoveries_used },
    { rebuilds: 1, recoveries: 0 },
    "one successful rebuild must charge the rebuild budget once and the "
    + "non-destructive budget not at all, however the announcement went",
  );
  assert.equal(statuses(events, "recovery_failed").length, 0,
    "a repair that succeeded must not be reported as a failed one");
});

/**
 * Drive `batches` failing tool batches, letting the caller decide what the
 * recovery hook does and which status emit blows up.
 *
 * Returns without rethrowing: several of these check that the loop survived a
 * failed announcement, and a rejected loop is one of the outcomes under test.
 */
async function runWithFailingEmit(
  batches: number,
  failOnStatus: string,
  recover: (attempt: number) => Promise<Record<string, unknown>>,
): Promise<{ attempts: number; events: Array<Record<string, unknown>>; rejected: unknown }> {
  const events: Array<Record<string, unknown>> = [];
  let attempts = 0;
  let rejected: unknown = null;
  const turns: Array<Partial<LlmTurnResult>> = [];
  for (let i = 0; i < batches; i++) turns.push(deadBatchTurn(i));
  turns.push({ content: [{ type: "text", text: "done" } as LlmContentBlock], stopReason: "end_turn" });

  await agentLoop([{ role: "user", content: "go" }], TOOLS, {
    model: "test-model",
    apiUrl: "http://localhost:0",
    apiKey: "test-key",
    maxTurns: batches + 2,
    router: {
      route: async () => { throw connectionRefused(); },
      setHands: () => {},
    } as unknown as ToolRouter,
    onEvent: async (evt: Record<string, unknown>) => {
      events.push(evt);
      if (evt.type === "sandboxStatus" && evt.status === failOnStatus) {
        throw new Error(`jetstream publish timeout on ${failOnStatus}`);
      }
    },
    sessionId: `sess-emit-${failOnStatus}`,
    userId: "user-1",
    llmSession: scriptedSession(turns),
    recreateHands: async () => { attempts += 1; return recover(attempts) as never; },
  } as unknown as LoopOptions).catch((e) => { rejected = e; });

  return { attempts, events, rejected };
}

test("a failed `recovering` announcement does not cancel the repair it announces", async () => {
  // This emit sits before the try, so an unguarded throw here aborts the
  // recovery before `recreateHands` is ever called: the sandbox is never
  // repaired, and nothing is charged for the attempt that did not happen.
  const { attempts, rejected } = await runWithFailingEmit(1, "recovering", async () => ({
    hands: {} as unknown as Record<string, unknown>,
    action: "rebuilt",
    detail: "provisioned",
  }));

  assert.equal(attempts, 1,
    "the repair must be attempted even when announcing it failed");
  assert.equal(rejected, null, "and the turn must not die on the announcement");
});

test("a failed `recovery_failed` announcement still lets the run continue", async () => {
  // The failure handler's own emit. Unguarded, a throw here escapes the catch
  // that exists to keep a failed repair from ending the run -- so the very
  // path meant to degrade gracefully is the one that kills the turn, and the
  // model never receives the notice that its sandbox is broken.
  const { attempts, events, rejected } = await runWithFailingEmit(2, "recovery_failed", async () => {
    throw new Error("sandbox left alone");
  });

  assert.equal(rejected, null, "a failed announcement of a failed repair must not end the run");
  assert.equal(attempts, 2,
    `the next batch must still reach recovery; got ${attempts} attempt(s)`);
  assert.equal(statuses(events, "recovering").length, 2,
    "both batches announce their recovery");
});

test("a failed `recovery_exhausted` announcement still lets the run finish", async () => {
  // The last thing a doomed run does. Unguarded, the throw escapes the catch
  // and the run ends on an exception instead of the report the budget logic
  // exists to produce.
  const BATCHES = SANDBOX_REBUILD_MAX_PER_TASK + 2;
  const { events, rejected } = await runWithFailingEmit(BATCHES, "recovery_exhausted", async () => {
    throw new HandsRecoveryBudgetExhausted("recovery");
  });

  assert.equal(rejected, null,
    "the run has to end with its report, not with the exception from announcing it");
  assert.ok(statuses(events, "recovery_exhausted").length >= 1,
    "the exhaustion is still announced (the publish is what failed, not the decision)");
});

test("a refusal that can never change is asked for once, not once per batch", async () => {
  // The DAG case: a node given `sandbox_spec.use` may not rebuild the sandbox
  // it inherited, and that is a fact about the node, not about this moment. It
  // used to be raised as a plain Error, which the loop charges to the
  // non-destructive budget and latches nothing -- so every later batch paid for
  // another probe, and pushed the same paragraph at the model, until the turn
  // cap. Neither counter can stop it: rebuildsUsed never moves, so
  // exhaustedBudget() never fires however high recoveriesUsed climbs.
  const BATCHES = 8;
  const { attempts } = await runFailingBatches(BATCHES, () => {
    throw new HandsRecoveryRefused(
      "sandbox_spec.use='train' inherited a sandbox that is no longer reachable",
    );
  });

  assert.equal(attempts.length, 1,
    `an answer that cannot change is worth asking once; got ${attempts.length} `
    + `probes across ${BATCHES} batches`);
});
