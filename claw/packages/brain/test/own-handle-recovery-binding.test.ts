// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the own-handle recovery owes the sandbox it recovers onto.
 *
 * `reuseOwnDagHandle` recovers the SANDBOX: a DAG whose session slot has
 * expired out from under it, but whose `dag-handles.<dagRoot>` row still names
 * a healthy workload, is handed that workload back instead of failing the
 * task. What it does not recover is the bookkeeping that keeps the workload
 * alive afterwards -- and `hands.<session>` is not a cache of that, it is the
 * only place the evidence "there is still background work in here" can live.
 *
 * The chain, end to end, is four steps long and has no race in it:
 *
 *   1. the recovery hands back the sandbox and writes no binding;
 *   2. the turn ends, `markHandsIdle` finds nothing to park and answers `gone`,
 *      so no idle period is ever opened on this sandbox;
 *   3. the keepalive sweep publishes background-work verdicts onto the session
 *      entry an idle period was opened on -- there is none, so the measurement
 *      that a shell is running lands nowhere;
 *   4. the API's orphan-handle sweep reads the session binding before it stops
 *      a workload whose DAG is over (`readSessionBackgroundWork` in
 *      packages/api/src/tasks/sandbox-stopper.ts). No binding reads as
 *      `no_binding`, `no_binding` classifies as reclaimable, and the workload
 *      is stopped with the user's shell still running inside it.
 *
 * These pin steps 2 and 3, which are Brain's half and the half the recovery
 * path broke. The verdict rule is `usableSharedVerdict`, imported from
 * @claw/protocol -- the same function the API sweep reads the binding with,
 * rather than a restatement of it here -- so "the sweep would defer" is read
 * off the real predicate over the real entry the real sweep publishes.
 *
 * Coverage:
 *   R1 a recovered sandbox ends the chat named by a binding carrying the
 *      verdict that says its background shell is alive
 *   R2 the control: a DAG that kept its binding ends the chat the same way
 *   R3 a sibling holding the session slot keeps it -- one slot per session, and
 *      taking it would strand the sandbox the sibling is running on
 */
import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { StringCodec } from "nats";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import { usableSharedVerdict } from "@claw/protocol";

import {
  bindSandboxReuseEffects,
  registerReusedDagHandle,
  requestSpecFingerprint,
  tryReuseSessionSandbox,
} from "../src/sandbox/ensure-hands.js";
import {
  bindDagHandleKvForTest,
  initDagHandles,
  releaseHandlesForWorkload,
  replaceDagHandle,
} from "../src/sandbox/handles.js";
import {
  markHandsIdle,
  registerSandbox,
  resetBackgroundWorkStateForTest,
  runKeepaliveTickForTest,
  unregisterSandbox,
} from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { resolveSandboxAction } from "../src/sandbox/params.js";
import { handsSessionKey } from "../src/sandbox/hands-key.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const IMAGE = "example.io/torch@sha256:aaaa";

/** The DAG_HANDLES bucket, with NATS' revision semantics. */
function fakeHandlesBucket() {
  const rows: Record<string, unknown> = {};
  const revs: Record<string, number> = {};
  const kv = {
    async get(key: string) {
      const v = rows[key];
      return v === undefined
        ? null
        : { key, value: sc.encode(JSON.stringify(v)), revision: revs[key] ?? 1, operation: "PUT" };
    },
    async create(key: string, value: Uint8Array) {
      if (rows[key] !== undefined) throw new Error("wrong last sequence: key exists");
      rows[key] = JSON.parse(sc.decode(value));
      revs[key] = 1;
      return 1;
    },
    async update(key: string, value: Uint8Array, rev: number) {
      if ((revs[key] ?? 0) !== rev) throw new Error(`wrong last sequence: ${revs[key]}`);
      rows[key] = JSON.parse(sc.decode(value));
      revs[key] = rev + 1;
      return revs[key];
    },
    async put(key: string, value: Uint8Array) {
      rows[key] = JSON.parse(sc.decode(value));
      revs[key] = (revs[key] ?? 0) + 1;
      return revs[key];
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      if (opts?.previousSeq !== undefined && opts.previousSeq !== revs[key]) {
        throw new Error(`wrong last sequence: ${revs[key]}`);
      }
      delete rows[key]; delete revs[key];
    },
    async keys() { return (async function* () { for (const k of Object.keys(rows)) yield k; })(); },
  };
  return { rows, kv, js: { views: { kv: async () => kv } } as never };
}

const handles = fakeHandlesBucket();
before(async () => {
  await initDagHandles(handles.js);
  bindDagHandleKvForTest(handles.kv as never);
});

/**
 * The BRAIN_REGISTRY bucket, remembering what is written to it.
 *
 * Every one of the four steps above is a read or a write of this bucket by a
 * different actor, so a stub whose `get` replays a seed value would hide the
 * write this file is about. `create` refuses an occupied key the way NATS
 * does -- R3 is written around that refusal.
 */
function fakeHandsKv(seed: Record<string, Record<string, unknown>> = {}) {
  const rows = new Map<string, unknown>();
  const revs = new Map<string, number>();
  for (const [k, v] of Object.entries(seed)) { rows.set(k, v); revs.set(k, 3); }
  const deleted: string[] = [];
  const kv = {
    async get(key: string) {
      const v = rows.get(key);
      return v === undefined
        ? null
        : { key, value: sc.encode(JSON.stringify(v)), revision: revs.get(key) ?? 1, operation: "PUT" };
    },
    async create(key: string, value: Uint8Array) {
      if (rows.has(key)) throw new Error("wrong last sequence: key exists");
      rows.set(key, JSON.parse(sc.decode(value)));
      revs.set(key, 1);
      return 1;
    },
    async put(key: string, value: Uint8Array) {
      rows.set(key, JSON.parse(sc.decode(value)));
      revs.set(key, (revs.get(key) ?? 0) + 1);
      return revs.get(key)!;
    },
    async update(key: string, value: Uint8Array, rev: number) {
      if ((revs.get(key) ?? 0) !== rev) throw new Error(`wrong last sequence: ${revs.get(key)}`);
      rows.set(key, JSON.parse(sc.decode(value)));
      revs.set(key, rev + 1);
      return revs.get(key)!;
    },
    async delete(key: string) { rows.delete(key); revs.delete(key); deleted.push(key); },
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...rows.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
  };
  return {
    kv: kv as unknown as KV,
    deleted,
    read: (key: string) => (rows.get(key) ?? null) as Record<string, unknown> | null,
  };
}

/** A real Hands endpoint: answers `/health` 200 until it is closed. */
async function liveSandbox(): Promise<{ mcpUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
let restoreEffects: (() => void) | null = null;
let restoreProviders: (() => void) | null = null;
const sessionsToClear: string[] = [];

afterEach(async () => {
  restoreEffects?.(); restoreEffects = null;
  restoreProviders?.(); restoreProviders = null;
  resetBackgroundWorkStateForTest();
  while (sessionsToClear.length) unregisterSandbox(sessionsToClear.pop()!);
  while (servers.length) await servers.pop()!.close();
});

async function sandbox() {
  const s = await liveSandbox();
  servers.push(s);
  return s;
}

/** A provider whose ping succeeds, so nothing is evicted by the fail limit. */
function stubPingableProvider(): void {
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, healthy: true, state: "running" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
}

function requestFor(sessionId: string, dagRoot: string, taskId: string): ExecuteRequest {
  return {
    session_id: sessionId,
    task_id: taskId,
    dag_root_task_id: dagRoot,
    prompt: "carry on",
    sandbox_spec: { handle: "main", image: IMAGE, resources: { cpu: "2" } },
  } as unknown as ExecuteRequest;
}

function actionFor(request: ExecuteRequest) {
  const action = resolveSandboxAction(request);
  assert.equal(action.kind, "create");
  return action as Extract<ReturnType<typeof resolveSandboxAction>, { kind: "create" }>;
}

/** The teardown side recorded rather than performed; the handle release is real. */
function stubEffects() {
  const stopped: string[] = [];
  restoreEffects = bindSandboxReuseEffects({
    destroyHands: (async (_s: string, known?: { workloadId?: string }) => {
      stopped.push(known?.workloadId ?? "(unnamed)");
      await releaseHandlesForWorkload(known?.workloadId ?? "");
    }) as never,
    registerSandbox,
    probeSandboxContainer: (async () => ({ verdict: "dead", reason: "exec_404" })) as never,
    restartHandsInSandbox: (async () => ({ ok: false, detail: "no_process" })) as never,
    countLiveWork: (async () => ({ verdict: "clear", classes: {}, reason: "clear" })) as never,
  });
  return { stopped };
}

/** What the create path does with a reuse, in production's order. */
async function recoverTurn(a: Parameters<typeof tryReuseSessionSandbox>[0]) {
  const reused = await tryReuseSessionSandbox(a);
  if (!reused) return null;
  await registerReusedDagHandle(a.kv, a.request, a.action as never, reused);
  return reused;
}

function attemptFor(
  kv: KV, sessionId: string, request: ExecuteRequest,
): Parameters<typeof tryReuseSessionSandbox>[0] {
  const action = actionFor(request);
  return {
    kv,
    sessionId,
    request,
    action,
    requestedSpec: requestSpecFingerprint(request, action),
    onEvent: async () => {},
  } as Parameters<typeof tryReuseSessionSandbox>[0];
}

/**
 * The rest of the chat: the turn ends and the fleet sweeps twice.
 *
 * `markHandsIdle` is the real end-of-turn park (`stopKeepaliveAfterTask` in
 * tasks/runner.ts calls exactly this), and the two sweeps are what a verdict
 * costs -- the probe deliberately does not block the first one, so the answer
 * is there for the second.
 */
async function endChatAndSweep(
  kv: KV, sessionId: string, identity: unknown, runningShells: number,
): Promise<string> {
  const parked = await markHandsIdle(kv, sessionId, identity as never);
  const deps = {
    kv,
    countActiveShells: async () => runningShells,
    listDagHandles: async () => new Map(),
  };
  await runKeepaliveTickForTest(deps as never);
  await new Promise((r) => setImmediate(r));
  await runKeepaliveTickForTest(deps as never);
  return parked.outcome;
}

/**
 * What the API orphan sweep would make of this session, by its own reader's
 * rule: a binding naming this workload, carrying a verdict it may believe.
 */
function sweepWouldDefer(
  entry: Record<string, unknown> | null, workloadId: string,
): { defer: boolean; why: string } {
  if (!entry) return { defer: false, why: "no_binding" };
  if (entry.workloadId !== workloadId) return { defer: false, why: "other_sandbox" };
  const verdict = usableSharedVerdict(entry as never, Date.now());
  if (verdict?.state === "running") return { defer: true, why: `running(${verdict.running})` };
  if (typeof entry.idleSince !== "number") return { defer: false, why: "no_idle_period" };
  if (!entry.handsUrl || !entry.token) return { defer: false, why: "no_credentials" };
  return { defer: !verdict, why: verdict ? "verdict_idle" : "awaiting" };
}

test("R1 a sandbox recovered onto its own handle still ends the chat with its live shell on record", async () => {
  // The session slot expired out from under a DAG whose handle -- in a bucket
  // with no TTL -- still names its healthy sandbox. The recovery hands that
  // sandbox back; what it owes is the binding that carries the evidence the
  // orphan sweep reads before it stops anything.
  const SESSION = "s-recover";
  sessionsToClear.push(SESSION);
  const w = await sandbox();
  await replaceDagHandle("dag-r1", "main", {
    workload_id: "wl-r1", hands_url: w.mcpUrl, token: "tok-r1", image: IMAGE,
    platform_key: "pk", namespace: "ns",
  });

  const store = fakeHandsKv();
  const { stopped } = stubEffects();
  stubPingableProvider();
  const request = requestFor(SESSION, "dag-r1", "task-r1");

  const result = await recoverTurn(attemptFor(store.kv, SESSION, request));
  assert.equal(result?.identity?.workloadId, "wl-r1", "the DAG recovers onto its own sandbox");
  assert.deepEqual(stopped, [], "and nothing was stopped to do it");

  const outcome = await endChatAndSweep(store.kv, SESSION, result!.identity, 1);
  const entry = store.read(handsSessionKey(SESSION));
  const sweep = sweepWouldDefer(entry, "wl-r1");

  assert.equal(
    sweep.why, "running(1)",
    "the orphan sweep reads the session binding before it stops a workload whose DAG is "
    + `over; it read '${sweep.why}' here, and on anything but a running verdict it issues `
    + "the stop -- against a container whose shell is still alive",
  );
  assert.ok(sweep.defer, "so the sweep defers instead of issuing the stop");
  assert.equal(
    outcome, "parked",
    "and the step that gets it there is the end of the turn finding something to park: "
    + "no binding, no idle period, and nowhere for the verdict above to be published",
  );
});

test("R2 the control: a DAG that kept its binding ends the chat the same way", async () => {
  // Same shell, same sweep, the ordinary path. This is what R1's sandbox is
  // being measured against: nothing about the background work differs, only
  // whether the session slot names the workload at the end of the turn.
  const SESSION = "s-control";
  sessionsToClear.push(SESSION);
  const w = await sandbox();
  await replaceDagHandle("dag-r2", "main", {
    workload_id: "wl-r2", hands_url: w.mcpUrl, token: "tok-r2", image: IMAGE,
    platform_key: "pk", namespace: "ns",
  });

  const request = requestFor(SESSION, "dag-r2", "task-r2");
  const action = actionFor(request);
  const store = fakeHandsKv({
    [handsSessionKey(SESSION)]: {
      status: "ready", provider: "safe-workload", workloadId: "wl-r2",
      handsUrl: w.mcpUrl, token: "tok-r2", platformKey: "pk", namespace: "ns",
      specFingerprint: requestSpecFingerprint(request, action),
      taskId: "task-r2", dagRootTaskId: "dag-r2",
    },
  });
  stubEffects();
  stubPingableProvider();

  const result = await recoverTurn(attemptFor(store.kv, SESSION, request));
  assert.equal(result?.identity?.workloadId, "wl-r2");

  const outcome = await endChatAndSweep(store.kv, SESSION, result!.identity, 1);
  const sweep = sweepWouldDefer(store.read(handsSessionKey(SESSION)), "wl-r2");

  assert.equal(outcome, "parked");
  assert.equal(sweep.why, "running(1)", "the control is never stopped");
});

test("R3 a sibling holding the session slot keeps it", async () => {
  // One slot per session. The recovery path is reached precisely when the slot
  // names something other than this DAG's sandbox, and a sibling's live
  // binding is the case where that something is another running sandbox --
  // overwriting it would strand the sibling exactly the way this gate exists to
  // stop doing.
  const SESSION = "s-sibling";
  sessionsToClear.push(SESSION);
  const mine = await sandbox();
  const sib = await sandbox();
  await replaceDagHandle("dag-r3", "main", {
    workload_id: "wl-r3", hands_url: mine.mcpUrl, token: "tok-r3", image: IMAGE,
    platform_key: "pk", namespace: "ns",
  });

  const request = requestFor(SESSION, "dag-r3", "task-r3");
  const action = actionFor(request);
  const siblingBinding = {
    status: "ready", provider: "safe-workload", workloadId: "wl-sib",
    handsUrl: sib.mcpUrl, token: "tok-sib", platformKey: "pk", namespace: "ns",
    specFingerprint: requestSpecFingerprint(request, action),
    taskId: "task-sib", dagRootTaskId: "dag-sib",
  };
  const store = fakeHandsKv({ [handsSessionKey(SESSION)]: { ...siblingBinding } });
  const { stopped } = stubEffects();

  const result = await recoverTurn(attemptFor(store.kv, SESSION, request));

  assert.equal(result?.identity?.workloadId, "wl-r3", "the DAG still recovers onto its own");
  assert.deepEqual(stopped, [], "and the sibling's sandbox is not stopped");
  assert.deepEqual(
    store.read(handsSessionKey(SESSION)), siblingBinding,
    "the sibling's binding is exactly as it was: the slot is not taken from it",
  );
});
