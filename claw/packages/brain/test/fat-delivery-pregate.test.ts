// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A fat delivery holds its lease before it queues for an execution slot.
 *
 * The window this closes is the one nothing could observe: between a message
 * arriving and the run starting, a pod could sit on `gate.acquire()` for the
 * length of another run with no durable state saying so. Nothing could tell
 * that delivery it had been stopped, nothing could tell whether it existed at
 * all, and a second pod could be given the same work. So acceptance is the
 * first lease -- one statement, before the gate -- and the renewal that keeps
 * it is also the channel a Stop arrives on.
 *
 * Coverage:
 *   F1  the first lease completes before gate.acquire() begins
 *   F2  which payloads take the path, and which are left alone
 *   F3  an acceptance with no generation is still an acceptance
 *   F4  every inconclusive answer refuses the delivery without running it
 *   F5  gone acks, superseded naks, neither handles
 *   F6  the pre-gate heartbeat renews under the generation while the gate blocks
 *   F7  the heartbeat stops only once the handler has taken renewal over
 *   F8  a refusal mid-wait stops the delivery before the handler
 *   F9  a Stop taken while queued settles visibly and leaks no slot
 *   F10 the accepted generation reaches the run's own heartbeat and completion
 *   F14 a drain gives the accepted lease back with the message
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import {
  runDelivery, createFatPreGate, currentFatDelivery, DeliveryResidency,
  type DeliveryDeps, type FatPreGate, type FatPreGateDeps,
} from "../src/delivery/dispatch.js";
import { ExecutionGate } from "../src/tasks/execution-gate.js";
import type { LeaseAnswer, LeaseRenewal } from "../src/tasks/callback.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { Engine } from "../src/agent/index.js";
import {
  bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";

const SESSION = "sess-fat";
const HEARTBEAT_MS = 5;

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
const tick = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, HEARTBEAT_MS));
};

function fatRequest(extra: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    session_id: SESSION,
    message_id: "m-1",
    user_id: "u1",
    task_id: "t-1",
    prompt: "hi",
    run_lease: { url: "http://api.test/lease", token: "tok" },
    ...extra,
  } as ExecuteRequest;
}

function msgFor(payload: unknown): JsMsg {
  const verdicts: string[] = [];
  return {
    verdicts,
    data: new TextEncoder().encode(JSON.stringify(payload)),
    info: { deliveryCount: 1 },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  } as unknown as JsMsg;
}

const verdictsOf = (msg: JsMsg): string[] => (msg as unknown as { verdicts: string[] }).verdicts;

interface Harness {
  deps: DeliveryDeps;
  gate: ExecutionGate;
  /** Every lease body the pre-gate sent, acceptance first. */
  leases: LeaseRenewal[];
  /** Events the pre-gate emitted on behalf of a stopped delivery. */
  events: Array<Record<string, unknown>>;
  handled: JsMsg[];
  errors: unknown[];
  /** Resolve the handler that is running, as a real run finishing would. */
  finish(): void;
}

/**
 * A pod wired with the real pre-gate, answering the lease from a script.
 *
 * The mapping from an HTTP answer to an acceptance is the part worth
 * exercising, so only the POST itself is replaced.
 */
function harness(opts: {
  answers: (n: number, renewal: LeaseRenewal, request: ExecuteRequest) => LeaseAnswer;
  max?: number;
  handle?: (msg: JsMsg, h: Harness) => Promise<void>;
  /** Re-asked per delivery, so a case can start the drain while one is queued. */
  draining?: () => boolean;
  /** The settle-and-release POST, for the case that asserts the lease goes back. */
  settle?: FatPreGateDeps["settle"];
}): Harness {
  const gate = new ExecutionGate(opts.max ?? 1, opts.max ?? 1);
  const leases: LeaseRenewal[] = [];
  const events: Array<Record<string, unknown>> = [];
  const handled: JsMsg[] = [];
  const errors: unknown[] = [];
  let finishRun: () => void = () => {};
  const h: Harness = {
    gate, leases, events, handled, errors,
    finish: () => finishRun(),
    deps: {
      keepAlive: () => () => {},
      gate,
      residency: new DeliveryResidency(64),
      // Past the refusal allowance, which is the state that makes a busy pod
      // keep a delivery and queue it rather than hand it back.
      canRefuse: () => false,
      surplusNakMs: () => 1_000,
      isDraining: () => opts.draining?.() ?? false,
      fatPreGate: createFatPreGate({
        emit: async (_sessionId, evt) => { events.push(evt); },
        ask: async (request, renewal) => {
          leases.push(renewal);
          return opts.answers(leases.length, renewal, request);
        },
        ...(opts.settle ? { settle: opts.settle } : {}),
        brainId: "brain-7",
        leaseTtlMs: 60_000,
        heartbeatMs: HEARTBEAT_MS,
      }),
      handle: async (msg) => {
        handled.push(msg);
        if (opts.handle) return opts.handle(msg, h);
        await new Promise<void>((resolve) => { finishRun = resolve; });
      },
      onError: (err) => { errors.push(err); },
    },
  };
  return h;
}

const granted = (status: string, claimCount?: number): LeaseAnswer =>
  claimCount === undefined
    ? { kind: "granted", status }
    : { kind: "granted", status, claimCount };

/**
 * The 409 a stopped row nobody holds answers an acceptance with.
 *
 * Not a grant: `acquireFatLease` filters on the acquirable statuses and returns
 * the row it wrote, so no server version hands out a lease whose status is
 * `cancelling`. The row says so by refusing, and says beside the refusal that
 * this delivery is the only thing left that can settle it.
 */
const stoppedRow = (claimCount: number): LeaseAnswer =>
  ({ kind: "refused", refusal: "gone", stop: "cancelling", claimCount });

describe("the pre-gate lease", () => {
  it("F1 completes before the delivery queues for a slot", async () => {
    // Recorded by kind, not by count. Once the acceptance is granted the
    // pre-gate heartbeat starts renewing while the gate is blocked -- that is
    // the whole point of it -- so counting lease POSTs races the heartbeat
    // interval and says nothing about the ordering this case is named for.
    const order: string[] = [];
    const h = harness({
      answers: (_n, renewal) => {
        order.push(renewal.accept ? "accept" : "renew");
        return granted("preparing", 1);
      },
    });
    const acquire = h.gate.acquire.bind(h.gate);
    h.gate.acquire = async () => { order.push("gate"); return acquire(); };

    void runDelivery(msgFor(fatRequest()), h.deps);
    await settle();
    await tick();

    assert.deepEqual(
      order.filter((step) => step !== "renew"), ["accept", "gate"],
      "exactly one acceptance, and it completed before the delivery queued for a slot",
    );
    assert.ok(
      order.indexOf("gate") < order.lastIndexOf("renew"),
      "and the lease keeps being renewed while the gate is blocked",
    );
    assert.equal(h.deps.fatPreGate!.target(msgFor(fatRequest())) !== null, true);
  });

  it("F2 takes only the deliveries the protocol is for", () => {
    const preGate: FatPreGate = harness({ answers: () => granted("preparing", 1) })
      .deps.fatPreGate!;
    const target = (payload: unknown) => preGate.target(msgFor(payload));

    assert.ok(target(fatRequest()), "a chat delivery carries a lease and no callback url");
    assert.ok(
      target(fatRequest({
        callback_url: "http://api.test/cb",
        run_lease: { url: "http://api.test/lease", token: "t", accept_before_execution: true },
      })),
      "the marker is what a message published after it exists says",
    );
    assert.equal(
      target(fatRequest({ callback_url: "http://api.test/cb" })), null,
      "a DAG or script run has a callback and is not this path's work",
    );
    assert.equal(target({ ...fatRequest(), run_lease: undefined }), null);
    assert.equal(
      target({ type: "run_doorbell", session_id: SESSION, task_id: "t-1", semantics: 1 }), null,
      "a doorbell is a wakeup, and its claim is the holder protocol",
    );
  });

  it("F3 treats an acceptance carrying no generation as an acceptance", async () => {
    // What an API that predates the generation answers. A 2xx without one is
    // never malformed and never a reason to hand the delivery back.
    let seen: number | undefined | "absent" = "absent";
    const h = harness({
      answers: () => granted("preparing"),
      handle: async () => {
        seen = currentFatDelivery()?.runClaim;
        await tick(2);
      },
    });

    await runDelivery(msgFor(fatRequest()), h.deps);

    assert.equal(h.leases[0].accept, true);
    assert.equal(seen, undefined, "a worker with no generation must omit it, not invent one");
    assert.ok(h.leases.length > 1, "the pre-gate still renews");
    for (const renewal of h.leases.slice(1)) {
      assert.equal("runClaim" in renewal, false);
      assert.equal(renewal.accept, undefined, "only an acceptance may carry the flag");
    }
  });

});

describe("the pre-gate lease refusing a delivery", () => {
  for (const [name, answer] of [
    ["a timeout or network failure", { kind: "unresolved" } as LeaseAnswer],
    ["a 5xx or unparseable body", { kind: "unresolved" } as LeaseAnswer],
    ["status unknown", granted("unknown")],
    ["a status no live row has", granted("completed")],
  ] as Array<[string, LeaseAnswer]>) {
    it(`F4 refuses the delivery on ${name}, without handling it`, async () => {
      const h = harness({ answers: () => answer });
      const msg = msgFor(fatRequest());

      await runDelivery(msg, h.deps);

      assert.deepEqual(verdictsOf(msg), ["nak:1000"]);
      assert.deepEqual(h.handled, []);
      assert.equal(h.gate.inflight, 0);
    });
  }

  it("F5 acks a gone row and naks a superseded one, handling neither", async () => {
    const gone = harness({ answers: () => ({ kind: "refused", refusal: "gone" }) });
    const goneMsg = msgFor(fatRequest());
    await runDelivery(goneMsg, gone.deps);
    assert.deepEqual(verdictsOf(goneMsg), ["ack"]);
    assert.deepEqual(gone.handled, []);

    const taken = harness({ answers: () => ({ kind: "refused", refusal: "superseded" }) });
    const takenMsg = msgFor(fatRequest());
    await runDelivery(takenMsg, taken.deps);
    assert.deepEqual(verdictsOf(takenMsg), ["nak:1000"]);
    assert.deepEqual(taken.handled, []);
  });
});

describe("the pre-gate heartbeat", () => {
  it("F6 renews under the accepted generation while the gate is blocked", async () => {
    const h = harness({ answers: () => granted("preparing", 7) });
    // One delivery takes the only slot; the second is the one under test.
    void runDelivery(msgFor(fatRequest()), h.deps);
    await settle();
    const queued = msgFor(fatRequest({ task_id: "t-2" }));
    void runDelivery(queued, h.deps);
    await tick();

    assert.ok(h.gate.queued >= 1, "the second delivery has to actually be waiting");
    const renewals = h.leases.filter((l) => !l.accept);
    assert.ok(renewals.length >= 2, "a delivery waiting for a slot has to keep its lease");
    for (const renewal of renewals) assert.equal(renewal.runClaim, 7);
    h.finish();
  });

  it("F7 keeps renewing until the handler takes renewal over", async () => {
    let handedOff = false;
    const h = harness({
      answers: () => granted("preparing", 3),
      handle: async () => {
        await tick(2);
        currentFatDelivery()!.handOffRenewal();
        handedOff = true;
        await tick(2);
      },
    });

    const msg = msgFor(fatRequest());
    const run = runDelivery(msg, h.deps);
    await tick(2);
    const beforeHandoff = h.leases.length;
    assert.ok(beforeHandoff > 1, "the delivery layer owns renewal until it is taken over");
    await run;

    assert.equal(handedOff, true);
    assert.deepEqual(h.errors, []);
    // Whatever arrived in the same tick as the handoff is allowed; what is not
    // allowed is renewal continuing for the rest of the run.
    const afterHandoff = h.leases.length;
    await tick(3);
    assert.equal(h.leases.length, afterHandoff, "two owners must not both renew");
  });

  it("F8 stops the delivery when a renewal is refused as superseded", async () => {
    const h = harness({
      answers: (n) => (n === 1
        ? granted("preparing", 2)
        : { kind: "refused", refusal: "superseded" }),
      max: 1,
    });
    void runDelivery(msgFor(fatRequest()), h.deps);
    await settle();
    const queued = msgFor(fatRequest({ task_id: "t-2" }));

    await runDelivery(queued, h.deps);

    assert.deepEqual(verdictsOf(queued), ["nak:1000"]);
    assert.equal(h.handled.length, 1, "only the delivery that holds the slot ran");
    h.finish();
  });
});

describe("a Stop taken while the delivery is queued", () => {
  it("F9 settles it visibly, runs nothing, and leaks no slot", async () => {
    const h = harness({
      answers: (_n, _renewal, request) =>
        (request.task_id === "t-2" ? stoppedRow(4) : granted("preparing", 4)),
      max: 1,
    });
    const running = msgFor(fatRequest());
    void runDelivery(running, h.deps);
    await settle();
    const stopped = msgFor(fatRequest({ task_id: "t-2" }));

    await runDelivery(stopped, h.deps);

    assert.deepEqual(verdictsOf(stopped), ["ack"]);
    assert.equal(h.handled.length, 1, "the stopped delivery never entered the handler");
    const completion = h.events.find((e) => e.type === "exec_complete");
    assert.ok(completion, "the row only reaches cancelled if the completion is emitted");
    assert.equal(completion.interrupted, true);
    assert.equal(completion.task_id, "t-2");
    assert.equal(completion.run_claim, 4);

    // The queued acquire the stop walked away from still has to be released by
    // somebody, or the slot is granted to nobody and lost for the pod's life.
    h.finish();
    await settle();
    assert.equal(h.gate.inflight, 0);
    assert.equal(h.gate.queued, 0);
    void runDelivery(msgFor(fatRequest({ task_id: "t-3" })), h.deps);
    await tick(1);
    assert.equal(h.gate.inflight, 1, "the pod can still fill every slot it has");
    assert.deepEqual(h.errors, []);
    h.finish();
  });

  it("F9b names the row it stopped even when only the lease URL carries its id", async () => {
    // F13's legacy shape on the stop path. `settleStopped` emits the only
    // completion this delivery will ever produce -- the handler never runs --
    // so an unnamed one leaves the `cancelling` row with nothing to settle it:
    // the user's interrupt is acked on the wire and the row waits out the
    // lost-lease reaper instead of reaching `cancelled`.
    const legacy = fatRequest({
      task_id: undefined,
      run_lease: { url: "http://api.test/v1/internal/tasks/t-legacy/lease", token: "tok" },
    } as Partial<ExecuteRequest>);
    const h = harness({
      answers: (_n, _renewal, request) => (
        request.run_lease?.url?.includes("t-legacy")
          ? stoppedRow(4)
          : granted("preparing", 4)
      ),
      max: 1,
    });
    void runDelivery(msgFor(fatRequest()), h.deps);
    await settle();

    await runDelivery(msgFor(legacy), h.deps);

    assert.equal(h.handled.length, 1, "the stopped delivery never entered the handler");
    const completion = h.events.find((e) => e.type === "exec_complete");
    assert.ok(completion, "the stop is reported");
    assert.equal(completion.interrupted, true);
    assert.equal(
      completion.task_id, "t-legacy",
      "recovered from the only place this payload says it",
    );
    h.finish();
  });

  it("F9c settles a Stop an API too old to refuse the acceptance granted instead", async () => {
    // The other side of a rolling upgrade. An API that predates the acceptance
    // flag serves the first lease from its renewal statement, whose renewable
    // set includes `cancelling`, so it answers 200 with that status and no
    // generation at all. Still a Stop, still nobody else to report it, and the
    // completion has to go out quoting nothing -- which is admissible exactly
    // because such an API never fenced the row either.
    const h = harness({
      answers: (_n, _renewal, request) =>
        (request.task_id === "t-2" ? granted("cancelling") : granted("preparing", 4)),
      max: 1,
    });
    void runDelivery(msgFor(fatRequest()), h.deps);
    await settle();
    const legacyStop = msgFor(fatRequest({ task_id: "t-2" }));

    await runDelivery(legacyStop, h.deps);

    assert.deepEqual(verdictsOf(legacyStop), ["ack"]);
    assert.equal(h.handled.length, 1, "the stopped delivery never entered the handler");
    const completion = h.events.find((e) => e.type === "exec_complete");
    assert.ok(completion, "the interrupt is still reported");
    assert.equal(completion.interrupted, true);
    assert.equal(completion.run_claim, undefined, "an API that issued none is quoted none");
    h.finish();
  });
});

describe("a drain that starts while the delivery is queued", () => {
  it("F14 gives the accepted lease back before it hands the message back", async () => {
    // The drain is re-asked only after the gate returns, so the whole queue
    // wait -- which is as long as another run -- passes with an accepted lease
    // renewed on the row. Naking without releasing it leaves every redelivery
    // classified `superseded` and naking in turn, so the turn stands still for
    // a full lease TTL on a pod that already knows it will not run it. This is
    // the ordinary precursor to every rolling upgrade: a version drain leaves
    // the pod alive with its consumer running, and each delivery parked on the
    // gate takes this branch as the running tasks finish.
    let draining = false;
    const order: string[] = [];
    const settles: Array<Record<string, unknown>> = [];
    const h = harness({
      answers: (_n, _renewal, request) =>
        granted("preparing", request.task_id === "t-2" ? 7 : 3),
      max: 1,
      draining: () => draining,
      settle: (async (taskId, claimCount, runTime, releaseLease, as) => {
        order.push("release");
        settles.push({ taskId, claimCount, runTime, releaseLease, as });
      }) as NonNullable<FatPreGateDeps["settle"]>,
    });

    void runDelivery(msgFor(fatRequest()), h.deps);
    await settle();
    const queued = msgFor(fatRequest({ task_id: "t-2" }));
    const nak = queued.nak.bind(queued);
    queued.nak = (ms?: number) => { order.push("nak"); nak(ms); };
    const drained = runDelivery(queued, h.deps);
    await settle();
    assert.deepEqual(verdictsOf(queued), [], "it is queued for a slot, not refused on arrival");

    draining = true;
    h.finish();
    await drained;

    assert.deepEqual(order, ["release", "nak"],
      "the lease goes back before the message does, so the redelivery can take it");
    assert.deepEqual(verdictsOf(queued), ["nak:5000"]);
    assert.equal(h.handled.length, 1, "the drained delivery never entered the handler");
    assert.equal(settles.length, 1);
    assert.equal(settles[0].taskId, "t-2");
    assert.equal(settles[0].claimCount, 7,
      "the generation the acceptance issued, which the settle is fenced on");
    assert.equal(settles[0].releaseLease, true,
      "owner null and expiry in the past is the shape the acceptance's released arm takes");
    assert.deepEqual(settles[0].as, { brainId: "brain-7", attempts: 1 },
      "under the identity that took the lease -- a mismatch answers 409, which this "
      + "client reads as success, and the lease would leak with nothing logged");
    assert.deepEqual(h.errors, []);
    assert.equal(h.gate.inflight, 0, "and the slot it briefly held went back");
  });
});

describe("the accepted generation", () => {
  it("F10 reaches the run's own lease renewals and its completion", async () => {
    const runner = runnerFixture();
    const h = harness({
      answers: () => granted("preparing", 9),
      handle: (msg) => runner.run(msg),
    });

    await runDelivery(msgFor(fatRequest()), h.deps);

    assert.ok(runner.renewals.length >= 1, "the run has to renew its own lease");
    assert.equal(runner.renewals[0].runClaim, 9,
      "a fenced row refuses a generation-less renewal, so the first tick must carry it");
    const completion = runner.events.find((e) => e.type === "exec_complete");
    assert.ok(completion);
    assert.equal(completion.task_id, "t-1");
    assert.equal(completion.run_claim, 9);
  });

  it("F13 names the row even when only the lease URL carries its id", async () => {
    // The shape an API published before `task_id` was on the wire: a lease URL
    // and nothing else. The pre-gate accepts it -- and every acceptance fences
    // the row -- so the completion it eventually emits has to name the row, or
    // it is closed by `closeUnnamedChatRun`, whose predicate excludes exactly
    // the rows acceptance fences. The turn finishes, the user gets the answer,
    // and the row stays open until a reaper calls the worker lost.
    //
    // `resolveRunIdentity` has read the URL for this all along; the completion
    // was the one place that did not.
    const legacy = fatRequest({
      task_id: undefined,
      run_lease: { url: "http://api.test/v1/internal/tasks/t-legacy/lease", token: "tok" },
    } as Partial<ExecuteRequest>);
    const runner = runnerFixture();
    const h = harness({
      answers: () => granted("preparing", 4),
      handle: (msg) => runner.run(msg, legacy),
    });

    await runDelivery(msgFor(legacy), h.deps);

    const completion = runner.events.find((e) => e.type === "exec_complete");
    assert.ok(completion, "the turn still reports");
    assert.equal(
      completion.task_id, "t-legacy",
      "recovered from the only place this payload says it",
    );
    assert.equal(completion.run_claim, 4);
  });

  it("F12 travels with the settle behind a retry, not only with the renewals", async () => {
    // `attempt.claimCount` is 0 on this path and always was: it was minted when
    // a fat delivery genuinely took no claim. `acquireFatLease` takes one now
    // -- `claim_count + 1` on acceptance -- so 0 is a stale answer, and
    // `/settle-attempt` fences on it. Sending it returns `not_holder`: the
    // coverage is never banked, the row keeps this attempt's token, and its
    // lease turns the redelivery's first heartbeat away until it lapses on its
    // own. The renewals already ask the delivery context for the real one;
    // this is the other reader that did not.
    const runner = runnerFixture({ failEngine: true });
    const h = harness({
      answers: () => granted("preparing", 9),
      handle: (msg) => runner.run(msg),
    });

    await runDelivery(msgFor(fatRequest()), h.deps);

    assert.equal(runner.settles.length, 1, "a fat retry settles its own attempt");
    assert.equal(runner.settles[0].taskId, "t-1");
    assert.equal(
      runner.settles[0].claimCount, 9,
      "the generation the acceptance minted, not the 0 the attempt was born with",
    );
    assert.equal(runner.settles[0].releaseLease, true);
  });
});

/** The task runner, reduced to the two things this file asks of it. */
function runnerFixture(opts: { failEngine?: boolean } = {}) {
  const renewals: LeaseRenewal[] = [];
  const events: Array<Record<string, unknown>> = [];
  const settles: Array<{ taskId: string; claimCount?: number; releaseLease?: boolean }> = [];
  const kv = fakeKv();
  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  const result: ExecuteResult = {
    finalText: "done",
    tokenUsage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
    turns: 1,
    pendingMemories: [],
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
    elapsedMs: 3,
  } as ExecuteResult;
  const sideEffects = {
    ensureHands: noop({ handsUrl: "http://hands.test", created: true, token: "t" }),
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => {}) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }),
    postAgentDone: noop(undefined),
    postTaskRunning: noop(undefined),
    postRunLease: ((_req: unknown, renewal: LeaseRenewal) => {
      renewals.push(renewal);
      return Promise.resolve("running");
    }) as never,
    runScript: noop(result),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({ close: async () => {} })) as never,
    settleRunAttempt: ((taskId: string, claimCount?: number, _r?: unknown, releaseLease?: boolean) => {
      settles.push({ taskId, claimCount, releaseLease });
      return Promise.resolve();
    }) as never,
  } as unknown as TaskRunnerSideEffects;
  const emitter = {
    async emit(_sessionId: string, evt: Record<string, unknown>) { events.push(evt); },
  } as unknown as NatsEmitter;
  const engine: Engine = opts.failEngine
    ? { async execute() { throw new Error("fetch failed"); } }
    : { async execute() { return result; } };
  bindTaskRunnerDeps({ kv, kvCkpt: fakeKv(), emitter, engine, sideEffects });

  return {
    renewals,
    events,
    settles,
    run: (msg: JsMsg, request: ExecuteRequest = fatRequest()) => runHandleTask(
      msg, request, SESSION, `lock.${SESSION}`, "m-1", "u1", new AbortController(),
    ),
  };
}

function fakeKv(): KV {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  return {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV;
}

/**
 * F11 the entrypoint hands the delivery loop a real pre-gate.
 *
 * Everything above builds its own `DeliveryDeps` and puts a `createFatPreGate`
 * in it, so all of it stays green if the pod stops supplying one. The field is
 * optional and every use site inside `runDelivery` is guarded, which is what
 * makes its absence silent: no error, no refusal, no log line -- fat chat
 * deliveries simply queue for a slot with no lease row behind them, and a Stop
 * aimed at the row finds nothing to cancel while the turn goes on to run.
 *
 * Read off the source because `main()` is the only place the wiring exists and
 * it connects to NATS, opens a durable consumer and starts the claim loop
 * before it reaches this object. Same shape as
 * metrics-helpers-wired.test.ts: what cannot be reached by a seam is asserted
 * against the text, with the comments taken out first so that prose about the
 * pre-gate cannot satisfy it.
 */
describe("the pre-gate as the pod wires it", () => {
  it("F11 the brain entrypoint puts a real pre-gate in the delivery deps", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

    assert.match(
      source,
      /fatPreGate:\s*createFatPreGate\(/,
      "the delivery loop is started without a pre-gate, so a queued fat chat turn "
      + "holds no lease, a Stop has no row to reach, and the turn runs anyway",
    );
  });
});
