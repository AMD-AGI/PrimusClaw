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
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import {
  runDelivery, createFatPreGate, currentFatDelivery, DeliveryResidency,
  type DeliveryDeps, type FatPreGate,
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
      isDraining: () => false,
      fatPreGate: createFatPreGate({
        emit: async (_sessionId, evt) => { events.push(evt); },
        ask: async (request, renewal) => {
          leases.push(renewal);
          return opts.answers(leases.length, renewal, request);
        },
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
        (request.task_id === "t-2" ? granted("cancelling", 4) : granted("preparing", 4)),
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
});

/** The task runner, reduced to the two things this file asks of it. */
function runnerFixture() {
  const renewals: LeaseRenewal[] = [];
  const events: Array<Record<string, unknown>> = [];
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
  } as unknown as TaskRunnerSideEffects;
  const emitter = {
    async emit(_sessionId: string, evt: Record<string, unknown>) { events.push(evt); },
  } as unknown as NatsEmitter;
  const engine: Engine = { async execute() { return result; } };
  bindTaskRunnerDeps({ kv, kvCkpt: fakeKv(), emitter, engine, sideEffects });

  return {
    renewals,
    events,
    run: (msg: JsMsg) => runHandleTask(
      msg, fatRequest(), SESSION, `lock.${SESSION}`, "m-1", "u1", new AbortController(),
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
