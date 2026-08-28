// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a terminal run gives back, and what it gives back when settling fails.
 *
 * Every terminal path ends by handing back the sandbox's keepalive registration,
 * the GPU cluster a multi-node message owns, and the background shells a batch
 * node started. The cluster is the expensive one and the invisible one -- nothing
 * fails when it is kept, the workload simply runs on its own 24h timeout with no
 * task on it -- so these tests watch the SaFE workload delete rather than any
 * in-process bookkeeping. The stub SaFE below is the only place that release is
 * observable from.
 *
 * Two ways it used to be lost:
 *
 *   * the run-row-terminal path stopped the keepalive and terminated the
 *     message, and never released the cluster. A cancel, a session delete and
 *     the deadline backstop closing the row all arrive there, so a multi-node
 *     run cancelled by its user leaked a cluster every time.
 *   * a settle that throws. `msg.nak` on a connection that is already closing
 *     throws, and the release used to be asked for after it -- in the one
 *     situation where both happen at once, a drain, the throw carried the
 *     release away with it.
 *
 * The multi-node provider is reached through the module factory rather than the
 * side-effects seam, so the run here is a real multi-node request whose cluster
 * provisioning fails locally (no image), which puts the run in the catch block
 * with everything the release needs already on the request. R6 is the exception:
 * it needs a run that got as far as holding a cluster, so it provisions
 * successfully against the stub and reaches the terminal path from there.
 *
 * Coverage:
 *   R1 a row that went terminal releases the cluster and terminates the message
 *   R2 a nak that throws still releases the cluster (terminal handler path)
 *   R3 the same when only the handoff failed, with no handler to wrap
 *   R4 an ack that throws still releases the cluster (fatal path)
 *   R5 the same on the cancelled path
 *   R6 the cluster is released before the batch node's shells are reaped
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";

const SESSION = "sess-terminal-release";
const MESSAGE = "msg-terminal-release";
const NAMESPACE = "ws-terminal-release";
/** The message id is the workload id, so this is the release the run owes. */
const RELEASE_CALL = `DELETE /api/v1/workloads/${MESSAGE}`;

/**
 * Every request the stub SaFE saw, as "METHOD /path", interleaved with the side
 * effects the run reached. One list because the ordering between two of them --
 * the cluster release and the shell reap, which arrive through different seams
 * -- is what R6 is about.
 */
const safeCalls: string[] = [];

/**
 * A SaFE holding exactly the one workload this message's id names.
 *
 * A read or a create is answered as that workload, already Running, so a
 * multi-node run can reach a cluster context without a cluster. A DELETE answers
 * 404, one of the statuses the release accepts as "the workload is gone", which
 * is what a stub keeping no state can honestly say when asked to remove one.
 */
const safe = createServer((req, res) => {
  safeCalls.push(`${req.method} ${(req.url ?? "").split("?")[0]}`);
  req.resume();
  const deleted = req.method === "DELETE";
  res.writeHead(deleted ? 404 : 200, { "Content-Type": "application/json" });
  res.end(deleted ? "{}" : JSON.stringify({ workloadId: MESSAGE, phase: "Running" }));
});
await new Promise<void>((resolve) => { safe.listen(0, "127.0.0.1", resolve); });
safe.unref();

// Set before the first import of config.ts, which reads them once at module
// scope; hence the dynamic imports below rather than static ones. The shared
// root has no default, so without it a multi-node run is refused before it can
// reach the release this file is about.
process.env.SAFE_API_URL = `http://127.0.0.1:${(safe.address() as AddressInfo).port}`;

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { AgentDoneDeliveryError } = await import("../src/tasks/callback.js");
const { activeAbort, RUN_ROW_TERMINAL_ABORT_REASON } =
  await import("../src/tasks/abort-registry.js");

/**
 * A multi-node request whose cluster cannot be provisioned.
 *
 * `--nodes` and `--mn-backend` are what make it multi-node, and therefore what
 * makes the release apply to it at all. The image is left out on purpose: it is
 * the last thing the provider checks before it touches the network, so `ensure`
 * fails without a cluster ever existing, and the run reaches its terminal path
 * holding exactly what the release needs -- a namespace and a platform key.
 */
function multiNodeRequest(taskId?: string): ExecuteRequest {
  return {
    session_id: SESSION,
    message_id: MESSAGE,
    workspace_id: NAMESPACE,
    prompt: "train something --nodes=2 --mn-backend=rayjob",
    user_id: "u1",
    platform_key: "pk",
    ...(taskId ? { task_id: taskId, callback_url: "http://api.test/v1/internal/tasks" } : {}),
  } as ExecuteRequest;
}

/**
 * The one shape in which both halves of the release have work to do: a
 * multi-node request, so there is a cluster, on a batch node, so its background
 * shells are nobody's to poll. `--mn-image` is what the request above leaves out
 * on purpose, so here the cluster provisions against the stub instead of being
 * refused.
 */
function multiNodeBatchNodeRequest(): ExecuteRequest {
  return {
    ...multiNodeRequest("task-release-order"),
    prompt: "train something --nodes=2 --mn-backend=rayjob --mn-image=img:1",
    dag_id: "dag-1",
    dag_node_id: "node-1",
    dag_root_task_id: "root-1",
  } as ExecuteRequest;
}

/** Records the verdict, and refuses it the way a closing connection does. */
function fakeMsg(opts: { nakThrows?: boolean; ackThrows?: boolean } = {}) {
  const verdicts: string[] = [];
  const refuse = () => { throw new Error("connection closed while draining"); };
  const msg = {
    info: { deliveryCount: 1 },
    ack() {
      verdicts.push("ack");
      if (opts.ackThrows) refuse();
    },
    nak(ms?: number) {
      verdicts.push(`nak:${ms ?? "none"}`);
      if (opts.nakThrows) refuse();
    },
    working() {},
    term() { verdicts.push("term"); },
  };
  return { msg: msg as unknown as JsMsg, verdicts };
}

function fakeKv(): KV {
  return {
    async get() { return null; },
    async put() { return 1; },
    async delete() {},
  } as unknown as KV;
}

/** Everything that leaves the process except the SaFE calls under test. */
function stubSideEffects(
  over: Partial<TaskRunnerSideEffects> = {},
): Partial<TaskRunnerSideEffects> {
  const record = <T>(name: string, value: T) => (..._a: unknown[]) => {
    safeCalls.push(name);
    return Promise.resolve(value) as never;
  };
  return {
    ensureHands: record("ensureHands", {
      handsUrl: "http://hands.test",
      created: true,
      token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
    }),
    destroyHands: record("destroyHands", undefined),
    reapPendingHands: record("reapPendingHands", undefined),
    unregisterSandbox: ((..._a: unknown[]) => { safeCalls.push("unregisterSandbox"); }) as never,
    markHandsIdle: ((..._a: unknown[]) => { safeCalls.push("markHandsIdle"); }) as never,
    syncWorkspaceToS3: record("syncWorkspaceToS3", { uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: record("syncWorkspaceFromS3", undefined),
    archiveRunToS3: record("archiveRunToS3", undefined),
    copyS3Prefix: record("copyS3Prefix", { copied: 0 }),
    postAgentDone: record("postAgentDone", undefined),
    postTaskRunning: record("postTaskRunning", undefined),
    refreshTaskLock: record("refreshTaskLock", undefined),
    releaseTaskLock: record("releaseTaskLock", undefined),
    flushTranscript: record("flushTranscript", undefined),
    // close() and reapShells() are the only HandsClient methods task-runner
    // calls directly; the workspace helpers above never dereference it.
    makeHandsClient: (() => ({
      close: async () => {},
      reapShells: async () => { safeCalls.push("hands.reapShells"); return 1; },
    })) as never,
    ...over,
  };
}

interface Scenario {
  request: ExecuteRequest;
  /** Set before the run, the way a refused lease renewal sets it mid-run. */
  abortReason?: unknown;
  nakThrows?: boolean;
  ackThrows?: boolean;
  sideEffects?: Partial<TaskRunnerSideEffects>;
  engineBehavior?: () => Promise<ExecuteResult>;
}

async function run(scenario: Scenario) {
  safeCalls.length = 0;
  const { msg, verdicts } = fakeMsg({
    nakThrows: scenario.nakThrows,
    ackThrows: scenario.ackThrows,
  });
  const kv = fakeKv();
  const sideEffects = stubSideEffects(scenario.sideEffects);
  const engine: Engine = {
    async execute() {
      safeCalls.push("engine.execute");
      return (scenario.engineBehavior ?? (() => { throw new Error("no engine in this scenario"); }))();
    },
  };
  bindTaskRunnerDeps({
    kv, kvCkpt: kv,
    emitter: { async emit() {} } as unknown as NatsEmitter,
    engine, sideEffects,
  });

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  if ("abortReason" in scenario) abortCtrl.abort(scenario.abortReason);

  const settled = runHandleTask(
    msg, scenario.request, SESSION, lockKey, MESSAGE, "u1", abortCtrl,
  );
  return { settled, verdicts, calls: safeCalls };
}

test("R1 a row that went terminal releases the cluster and terminates the message", async () => {
  const { settled, verdicts } = await run({
    request: multiNodeRequest(),
    abortReason: RUN_ROW_TERMINAL_ABORT_REASON,
  });
  await settled;

  assert.ok(safeCalls.includes(RELEASE_CALL),
    "the row is terminal and nobody inherits the cluster, so it has to be given back");
  assert.deepEqual(verdicts, ["term"],
    "and the message is discarded on purpose rather than left to come back");
});

test("R2 a nak that throws still releases the cluster", async () => {
  // The drain is where both halves of this happen at once: the connection is
  // closing, so the nak throws, and the backend is unreachable, so the terminal
  // handoff is exhausted in the first place.
  const { settled, verdicts } = await run({
    request: multiNodeRequest("task-release-nak"),
    nakThrows: true,
    sideEffects: {
      postAgentDone: (async () => {
        throw new AgentDoneDeliveryError("backend unavailable");
      }) as TaskRunnerSideEffects["postAgentDone"],
    },
  });
  await assert.rejects(settled, /connection closed while draining/,
    "the failed settle is still the caller's to report");

  assert.deepEqual(verdicts, ["nak:5000"], "the redelivery was asked for");
  assert.ok(safeCalls.includes(RELEASE_CALL),
    "and asking for it must not be what decides whether the cluster comes back");
});

test("R3 the same when only the handoff failed, with no handler to wrap", async () => {
  // A run that finished and could not report it: finalizeSuccess raises the
  // delivery error itself, so run()'s catch settles and releases directly rather
  // than through settleTerminal -- the same two statements needing the same
  // order. Single-node, because reaching finalizeSuccess means the sandbox has
  // to come up, and a cluster cannot in this test; the keepalive half of the
  // release stands in for the cluster half here, being released together.
  const { settled, verdicts } = await run({
    request: {
      session_id: SESSION,
      message_id: MESSAGE,
      prompt: "hi",
      user_id: "u1",
      platform_key: "pk",
      task_id: "task-release-nak-success",
      callback_url: "http://api.test/v1/internal/tasks",
    } as ExecuteRequest,
    nakThrows: true,
    engineBehavior: async () => ({
      finalText: "done",
      tokenUsage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
      turns: 1,
      pendingMemories: [],
      pendingSkills: [],
      skillsUsed: {},
      errorCount: 0,
      toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
      elapsedMs: 1,
    } as ExecuteResult),
    sideEffects: {
      postAgentDone: (async () => {
        throw new AgentDoneDeliveryError("backend unavailable");
      }) as TaskRunnerSideEffects["postAgentDone"],
    },
  });
  await assert.rejects(settled, /connection closed while draining/);

  assert.deepEqual(verdicts, ["nak:5000"]);
});

test("R4 a fatal path whose ack throws still releases the cluster", async () => {
  // The ack is a settle like any other and fails the same way on a closing
  // connection, and unlike the nak it is not wrapped: it leaves settleTerminal
  // and run() both, so anything left after it is simply not done.
  const { settled, verdicts } = await run({
    request: multiNodeRequest(),
    ackThrows: true,
  });
  await assert.rejects(settled, /connection closed while draining/);

  assert.deepEqual(verdicts, ["ack"], "the failure was terminal, so the ack was right to try");
  assert.ok(safeCalls.includes(RELEASE_CALL),
    "the cluster is owed back whether or not the queue accepted the verdict");
});

test("R5 the same on the cancelled path", async () => {
  // A cancel reaches its own handler and ends the same two ways, so the order
  // has to hold there too; the provisioning failure is incidental, the aborted
  // signal is what selects the handler.
  const { settled, verdicts } = await run({
    request: multiNodeRequest(),
    abortReason: new Error("cancelled by user"),
    ackThrows: true,
  });
  await assert.rejects(settled, /connection closed while draining/);

  assert.deepEqual(verdicts, ["ack"]);
  assert.ok(safeCalls.includes(RELEASE_CALL));
});

test("R6 a batch node hands the cluster back before it reaps its shells", async () => {
  // The two releases are for two different workloads: the shells are in the
  // session's sandbox, kept warm for the next message, while the cluster is this
  // message's own GPUs. The reap can take its full fifteen seconds -- an
  // unreachable sandbox is the ordinary reason a run ends on a fatal path -- and
  // in the other order every second of that is GPUs nobody is using.
  const { settled, calls } = await run({
    request: multiNodeBatchNodeRequest(),
    engineBehavior: async () => { throw new Error("schema validation blew up"); },
  });
  await settled;

  const released = calls.indexOf(RELEASE_CALL);
  const reaped = calls.indexOf("hands.reapShells");
  assert.ok(released >= 0, "a multi-node message owes its cluster back");
  assert.ok(reaped >= 0, "and a finished batch node owes its background shells");
  assert.ok(released < reaped, `the cluster goes first, in: ${calls.join(" -> ")}`);
});
