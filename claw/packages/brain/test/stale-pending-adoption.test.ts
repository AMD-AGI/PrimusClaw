// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run may only name the sandbox it provisioned itself.
 *
 * `hands.<sid>` is per session, not per run, and its PENDING form carries
 * nothing that says which run wrote it. A provision that died between minting
 * its workload and reaping it leaves one behind, and the session's next turn is
 * an ordinary chat turn: under BRAIN_LAZY_SANDBOX it opens no sandbox unless a
 * tool asks for one, so a model-provider refusal ends it without `ensureHands`
 * ever being called. Reading that leftover entry as this run's handle asks SaFE
 * about somebody else's workload and delivers its termination as this task's
 * ending -- a run that failed on an auth error, filed as killed/preempted.
 *
 * `status === "pending"` cannot tell the two apart. What can is the runner's
 * own record of having asked for a sandbox, against the `createdAt` that
 * `onProvisioned` stamps from inside that call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import { handsSessionKey } from "@claw/protocol";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import type { Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort } from "../src/tasks/abort-registry.js";
import type { LeaseRenewal } from "../src/tasks/callback.js";

const SESSION = "sess-stale-pending";
const MESSAGE = "msg-stale-pending";
const OTHER_WORKLOAD = "workload-previous-run";
const OWN_WORKLOAD = "workload-this-run";

/** What SaFE says about the pod the previous run lost. */
const PREEMPTED = {
  message: "Preempted, the node was reclaimed",
  node: "node-3",
  containerReason: "Error",
  exitCode: 137,
};

function fakeKv(seed: Record<string, string> = {}) {
  const enc = new TextEncoder();
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(seed)) store.set(k, enc.encode(v));
  return {
    store,
    kv: {
      async get(key: string) {
        const value = store.get(key);
        return value ? { key, value, revision: 1, operation: "PUT" } : null;
      },
      async put(key: string, value: Uint8Array | string) {
        store.set(key, typeof value === "string" ? enc.encode(value) : value);
        return 1;
      },
      async update(key: string, value: Uint8Array | string) {
        store.set(key, typeof value === "string" ? enc.encode(value) : value);
        return 2;
      },
      async delete(key: string) { store.delete(key); },
    } as unknown as KV,
  };
}

/**
 * One turn of a session that is already holding a stale PENDING entry.
 *
 * `provisions` decides what this turn does about a sandbox: "none" is the chat
 * turn answered from context whose engine then fails, "own" is the same session
 * where a tool does ask, so `ensureHands` runs and writes the entry of its own
 * that it is then killed during.
 */
async function runTurn(provisions: "none" | "own") {
  const delivered: ExecuteResult[] = [];
  const renewals: LeaseRenewal[] = [];
  const factsAsked: unknown[][] = [];
  let ensureHandsCalls = 0;

  const msg = {
    seq: 1, info: { deliveryCount: 1 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
  const noop = <T>(v: T) => (() => Promise.resolve(v)) as never;

  // Left behind by an earlier message of this session whose provision died
  // before its own reap could run. Nothing in it names the run that wrote it.
  const { kv } = fakeKv({
    [handsSessionKey(SESSION)]: JSON.stringify({
      status: "pending",
      workloadId: OTHER_WORKLOAD,
      platformKey: "pk",
      token: "hands-token",
      createdAt: new Date(Date.now() - 600_000).toISOString(),
    }),
  });
  const { kv: kvCkpt } = fakeKv();

  const sideEffects = {
    ensureHands: (async () => {
      ensureHandsCalls++;
      // This run's own `onProvisioned`, replacing the leftover entry.
      await kv.put(handsSessionKey(SESSION), JSON.stringify({
        status: "pending",
        workloadId: OWN_WORKLOAD,
        platformKey: "pk",
        token: "hands-token",
        createdAt: new Date().toISOString(),
      }));
      throw new Error("workload pod terminated before becoming ready");
    }) as never,
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    probeSandboxContainer: noop({ verdict: "dead", reason: "x" }),
    fetchPlatformFacts: ((...a: unknown[]) => {
      factsAsked.push(a);
      // SaFE answers for whichever workload it is asked about. The previous
      // run's pod is the one with an ending to report.
      return Promise.resolve(a[0] === OTHER_WORKLOAD ? { ...PREEMPTED } : null);
    }) as never,
    restartHandsInSandbox: noop({ ok: true, detail: "" }),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }),
    postAgentDone: ((req: ExecuteRequest, res: ExecuteResult) => {
      if (req.task_id && req.callback_url) delivered.push(res);
      return Promise.resolve();
    }) as never,
    postTaskRunning: (() => Promise.resolve()) as never,
    postRunLease: ((_r: unknown, renewal: LeaseRenewal) => {
      renewals.push(renewal);
      return Promise.resolve("running");
    }) as never,
    settleRunAttempt: noop(undefined),
    runScript: noop({} as ExecuteResult),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  } as unknown as TaskRunnerSideEffects;

  const engine: Engine = {
    async execute(_r, _e, _s, _h, extras?: ExecuteExtras) {
      if (provisions === "own") {
        return await extras!.attachHands!() as unknown as ExecuteResult;
      }
      // Answered from context: no tool asks for a sandbox, and the provider
      // refuses the request.
      throw new Error("401 {\"error\":{\"message\":\"invalid x-api-key\"}}");
    },
  };
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    session_id: SESSION, task_id: "task-stale-pending", prompt: "hi", user_id: "u1",
    platform_key: "pk",
    callback_url: "http://api.test/v1/internal/tasks",
    run_lease: { url: "http://api.test/v1/internal/tasks/task-stale-pending/lease", token: "tok" },
  } as unknown as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return { delivered, renewals, factsAsked, ensureHandsCalls };
}

test("a turn that never provisioned reports no sandbox and no platform ending", async () => {
  const { delivered, renewals, factsAsked, ensureHandsCalls } = await runTurn("none");

  assert.equal(ensureHandsCalls, 0, "this turn never asked for a sandbox");
  // The platform is never asked about a workload this run cannot show is its
  // own -- the read costs a SaFE call and returns somebody else's ending.
  assert.deepEqual(
    factsAsked.map((a) => a[0]).filter(Boolean), [],
    `no workload of this run's to ask about: ${JSON.stringify(factsAsked)}`,
  );
  // What the client and the row actually get: an LLM auth failure, filed as
  // one. With the leftover entry adopted this delivered PREEMPTED, which
  // `platformFields` turns into platform_message on the callback and the runs
  // API then answers as killed/preempted.
  assert.equal(delivered.length, 1);
  assert.equal((delivered[0] as { platformFacts?: unknown }).platformFacts, undefined,
    "another run's ending is not this run's");
  assert.ok(
    renewals.every((r) => r.sandbox === undefined),
    `and no renewal claims that sandbox either: ${JSON.stringify(renewals.map((r) => r.sandbox))}`,
  );
});

test("but the turn that does provision still reports the workload it minted", async () => {
  // The positive control: the guard must not cost the pre-ready window the
  // handle it was added for. Same session, same leftover entry, one difference
  // -- a tool asked for a sandbox, so this run's own provision overwrote it.
  const { delivered, renewals, factsAsked, ensureHandsCalls } = await runTurn("own");

  assert.equal(ensureHandsCalls, 1);
  assert.deepEqual(factsAsked.map((a) => a[0]), [OWN_WORKLOAD]);
  assert.deepEqual(
    renewals.at(-1)?.sandbox,
    { provider: "safe-workload", handle: OWN_WORKLOAD },
    `the run's own workload still reaches the row: ${
      JSON.stringify(renewals.map((r) => r.sandbox))}`,
  );
  assert.equal(delivered.length, 1);
});
