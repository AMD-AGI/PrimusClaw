// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which sandbox a DAG recovers onto, when the two records disagree about it.
 *
 * `hands.<sessionId>` is one slot per session; `dag-handles.<dagRoot>` is keyed
 * by (DAG, handle). Only the second is keyed by the question a redelivered
 * `create` node is actually asking -- "which sandbox is MY `main`" -- and until
 * now only the `use` path ever consulted it. A `create` walked straight past it
 * into the session slot, adopted whatever that named, and then had the adoption
 * refused by `replaceDagHandle`, because its own handle still named the sandbox
 * it built. Both sandboxes healthy, the DAG's own one abandoned with its
 * workspace on it, the sibling's idle markers cleared and re-parked underneath a
 * DAG still running on it, and a node that failed identically on every
 * redelivery until its delivery budget ran out.
 *
 * The session slot comes to name something other than this DAG's sandbox by
 * several routes, none of which need a race to be reached: two DAG roots under
 * a session-scoped run gate, a replica that dies between a create's pending
 * write and its READY write, or simply the hands bucket's TTL expiring a slot
 * that DAG_HANDLES -- which has no TTL -- still holds a handle against.
 *
 * What these pin is the OUTCOME: which workload the turn ends up on, what the
 * handle map holds afterwards, whether the turn survived, and which sandboxes
 * were stopped. The handle map is the real one (`initDagHandles` over a bucket
 * with NATS' revision semantics), the registration is the real
 * `replaceDagHandle` through the real `registerReusedDagHandle`, and `/health`
 * is answered by real `node:http` servers -- so "both sandboxes are healthy" is
 * a fact here rather than an assertion.
 *
 * Coverage:
 *   D1 a redelivery recovers onto its OWN sandbox, not the slot's
 *   D2 a handle left pending by a dead replica is released, and the turn lives
 *   D3 a workload another DAG also holds is never stopped to free the name
 *   D4 when the two records agree, the session record still decides (no change)
 *   D5 a DAG with no handle of its own still adopts a warm sibling sandbox
 *   D6 a sandbox whose spec changed is not stopped while work is running in it
 *   D7 -- and is stopped, and the name freed, when nothing is
 */
import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { StringCodec } from "nats";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";

import {
  bindSandboxReuseEffects,
  registerReusedDagHandle,
  requestSpecFingerprint,
  tryReuseSessionSandbox,
} from "../src/sandbox/ensure-hands.js";
import {
  bindDagHandleKvForTest,
  initDagHandles,
  lookupDagHandle,
  releaseHandlesForWorkload,
  replaceDagHandle,
} from "../src/sandbox/handles.js";
import { resolveSandboxAction } from "../src/sandbox/params.js";
import { handsSessionKey } from "../src/sandbox/hands-key.js";

const sc = StringCodec();

/**
 * The DAG_HANDLES bucket, with real revision semantics: `create` refuses an
 * existing key and `update` refuses a stale revision, the way NATS does. A fake
 * that accepted both would supply the refusal these tests are written around.
 */
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

// `initDagHandles` memoises, so the first call binds the map for the whole file.
// Each test uses its own DAG ids, so they share one store without sharing state.
const handles = fakeHandlesBucket();
before(async () => {
  await initDagHandles(handles.js);
  bindDagHandleKvForTest(handles.kv as never);
});

/** A real Hands endpoint: answers `/health` 200 until it is closed. */
async function liveSandbox(): Promise<{ mcpUrl: string; close: () => Promise<void>; alive: () => Promise<boolean> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    mcpUrl: `${base}/mcp`,
    alive: async () => (await fetch(`${base}/health`)).ok,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
let restoreEffects: (() => void) | null = null;
afterEach(async () => {
  restoreEffects?.(); restoreEffects = null;
  while (servers.length) await servers.pop()!.close();
});

async function sandbox() {
  const s = await liveSandbox();
  servers.push(s);
  return s;
}

/** The `hands.<sessionId>` slot, in the shape the reuse path reads it back. */
function fakeHandsKv(sessionId: string, entry: Record<string, unknown> | null): KV {
  const key = handsSessionKey(sessionId);
  let revision = 7;
  const kv = {
    async get(k: string) {
      if (!entry || k !== key) return null;
      return { key: k, value: sc.encode(JSON.stringify(entry)), revision, operation: "PUT" };
    },
    async put() { return ++revision; },
    async update() { return ++revision; },
    async delete() {},
    // No retentions in the bucket, which is what `retainedTaker` scans for.
    async keys() { return (async function* () {})(); },
  };
  return kv as unknown as KV;
}

const IMAGE = "example.io/torch@sha256:aaaa";

function requestFor(dagRoot: string, taskId: string, image = IMAGE): ExecuteRequest {
  return {
    session_id: "s-1",
    task_id: taskId,
    dag_root_task_id: dagRoot,
    prompt: "carry on",
    sandbox_spec: { handle: "main", image, resources: { cpu: "2" } },
  } as unknown as ExecuteRequest;
}

function actionFor(request: ExecuteRequest) {
  const action = resolveSandboxAction(request);
  assert.equal(action.kind, "create");
  return action as Extract<ReturnType<typeof resolveSandboxAction>, { kind: "create" }>;
}

/**
 * What the create path really does with a reuse, in the order production does
 * it: ensure-hands.ts:1212-1231. Returns the sandbox the turn ended up on, or
 * null when the caller would go on to provision, and throws whatever the turn
 * would have thrown -- which is the fate being asserted on.
 */
async function recoverTurn(a: Parameters<typeof tryReuseSessionSandbox>[0]) {
  const reused = await tryReuseSessionSandbox(a);
  if (!reused) return null;
  await registerReusedDagHandle(a.kv, a.request, a.action as never, reused);
  return reused;
}

/**
 * The teardown and keepalive side of the world, recorded rather than performed
 * -- except the handle release, which is performed for real, because freeing
 * the name is exactly what `destroyHands` contributes to these paths and a stub
 * that skipped it would prove the opposite of what it looks like it proves.
 */
function stubEffects(over: Record<string, unknown> = {}) {
  const stopped: string[] = [];
  const registered: Array<Record<string, unknown>> = [];
  restoreEffects = bindSandboxReuseEffects({
    destroyHands: (async (_s: string, known?: { workloadId?: string }) => {
      stopped.push(known?.workloadId ?? "(unnamed)");
      await releaseHandlesForWorkload(known?.workloadId ?? "");
    }) as never,
    registerSandbox: ((_s: string, target: Record<string, unknown>) => {
      registered.push(target);
    }) as never,
    probeSandboxContainer: (async () => ({ verdict: "dead", reason: "exec_404" })) as never,
    restartHandsInSandbox: (async () => ({ ok: false, detail: "no_process" })) as never,
    countLiveWork: (async () => ({ verdict: "clear", classes: {}, reason: "clear" })) as never,
    ...over,
  });
  return { stopped, registered };
}

function attemptFor(
  request: ExecuteRequest,
  entry: Record<string, unknown> | null,
): Parameters<typeof tryReuseSessionSandbox>[0] {
  const action = actionFor(request);
  return {
    kv: fakeHandsKv("s-1", entry),
    sessionId: "s-1",
    request,
    action,
    requestedSpec: requestSpecFingerprint(request, action),
    onEvent: async () => {},
  } as Parameters<typeof tryReuseSessionSandbox>[0];
}

test("D1 a redelivery recovers onto its own sandbox, not the one the session slot names", async () => {
  // Two DAG roots in one session, each with its own live sandbox and its own
  // handle row. `hands.<session>` is one slot, so it names whichever create
  // wrote it last -- here DAG A's. DAG B's create node is then redelivered.
  //
  // Before the own-handle gate this adopted W-a and `registerReusedDagHandle`
  // refused it ("dag-handle main for dag-b1 still names wl-b"), failing a node
  // whose own sandbox was healthy and three metres away.
  const wA = await sandbox();
  const wB = await sandbox();
  await replaceDagHandle("dag-a1", "main", {
    workload_id: "wl-a", hands_url: wA.mcpUrl, token: "tok-a", image: IMAGE, namespace: "ns",
  });
  await replaceDagHandle("dag-b1", "main", {
    workload_id: "wl-b", hands_url: wB.mcpUrl, token: "tok-b", image: IMAGE, namespace: "ns",
  });

  const request = requestFor("dag-b1", "task-b");
  const { stopped, registered } = stubEffects();
  const a = attemptFor(request, {
    status: "ready", workloadId: "wl-a", handsUrl: wA.mcpUrl, token: "tok-a",
    specFingerprint: (a2 => a2)(requestSpecFingerprint(request, actionFor(request))),
    taskId: "task-a", dagRootTaskId: "dag-a1", namespace: "ns",
  });

  const result = await recoverTurn(a);

  assert.equal(result?.identity?.workloadId, "wl-b", "the DAG recovers onto the sandbox it built");
  assert.equal(result?.handsUrl, wB.mcpUrl);
  assert.equal(result?.token, "tok-b");
  assert.equal(result?.created, false, "and is not told to rehydrate a workspace it still has");
  assert.deepEqual(registered.map((r) => r.workloadId), ["wl-b"],
    "keepalive is registered against its own sandbox");
  assert.deepEqual(stopped, [], "nothing was stopped: both sandboxes are healthy and in use");
  assert.equal((await lookupDagHandle("dag-b1", "main"))?.workload_id, "wl-b");
  assert.equal((await lookupDagHandle("dag-a1", "main"))?.workload_id, "wl-a",
    "the sibling's handle is untouched");
  assert.ok(await wA.alive(), "and the sibling's sandbox was never adopted or parked");
  assert.ok(await wB.alive());
});

test("D2 a handle a dead replica left pending is released, and the turn survives", async () => {
  // The route that needs no concurrency at all. A replica died between
  // `makeOnProvisioned`'s handle write and the READY write, so DAG A's handle
  // names a workload that never served anything and `hands.<session>` has moved
  // on to DAG B's. `reapPendingHands` only ever runs in-process and DAG_HANDLES
  // has no TTL, so nothing else will ever clear that row.
  //
  // The pending workload is this DAG's, it served nobody, and it has to go
  // before its name can be used -- otherwise the adoption below is refused and
  // the node dies with a live sandbox standing.
  const wB = await sandbox();
  await replaceDagHandle("dag-a2", "main", {
    workload_id: "wl-1", pending: true, platform_key: "pk", namespace: "ns",
  });

  const request = requestFor("dag-a2", "task-a2");
  const { stopped, registered } = stubEffects();
  const a = attemptFor(request, {
    status: "ready", workloadId: "wl-2", handsUrl: wB.mcpUrl, token: "tok-2",
    specFingerprint: requestSpecFingerprint(request, actionFor(request)),
    taskId: "task-b2", dagRootTaskId: "dag-b2", namespace: "ns",
  });

  const result = await recoverTurn(a);

  assert.deepEqual(stopped, ["wl-1"], "the half-created workload is stopped, not leaked");
  assert.equal(result?.identity?.workloadId, "wl-2", "and the turn goes on with the live sandbox");
  assert.deepEqual(registered.map((r) => r.workloadId), ["wl-2"]);
  assert.equal(
    (await lookupDagHandle("dag-a2", "main"))?.workload_id, "wl-2",
    "the handle now names what this DAG is actually running on -- the registration committed",
  );
  assert.ok(await wB.alive());
});

test("D3 a workload another DAG also holds is never stopped to free the name", async () => {
  // The guard that must survive the fix. Having registered this handle is not
  // the same as being the only holder: a sibling DAG that adopted this workload
  // registered its own handle on it, and a probe against MY row says nothing
  // about theirs. Stopping it would pull a pod out from under a running DAG.
  //
  // The scan here is the real `workloadHeldByOtherDag` over the real bucket.
  const wB = await sandbox();
  await replaceDagHandle("dag-a3", "main", {
    workload_id: "wl-3", pending: true, platform_key: "pk", namespace: "ns",
  });
  await replaceDagHandle("dag-c3", "main", {
    workload_id: "wl-3", hands_url: "http://unused.invalid/mcp", token: "tok-3", namespace: "ns",
  });

  const request = requestFor("dag-a3", "task-a3");
  const { stopped } = stubEffects();
  const a = attemptFor(request, {
    status: "ready", workloadId: "wl-9", handsUrl: wB.mcpUrl, token: "tok-9",
    specFingerprint: requestSpecFingerprint(request, actionFor(request)),
    taskId: "task-b3", dagRootTaskId: "dag-b3", namespace: "ns",
  });

  await assert.rejects(
    () => recoverTurn(a),
    /another DAG is holding that workload/,
    "the turn fails saying why, instead of stopping somebody else's sandbox",
  );
  assert.deepEqual(stopped, [], "nothing was stopped");
  assert.equal((await lookupDagHandle("dag-c3", "main"))?.workload_id, "wl-3",
    "the other DAG's handle still names its sandbox");
});

test("D4 when the two records agree the session record still decides the rebuild", async () => {
  // A no-regression pin rather than a bug: this passes before the fix too, and
  // it is here because the fix could so easily have broken it. When the handle
  // and the session slot name the SAME sandbox, the slot is the better informed
  // of the two -- it carries the full spec fingerprint, which a handle row does
  // not -- so the own-handle gate must stand aside and let the spec comparison
  // rebuild, rather than hand back a sandbox built for a spec nobody asked for.
  const w = await sandbox();
  await replaceDagHandle("dag-a4", "main", {
    workload_id: "wl-4", hands_url: w.mcpUrl, token: "tok-4", image: IMAGE, namespace: "ns",
  });

  const request = requestFor("dag-a4", "task-a4");
  const { stopped } = stubEffects();
  const a = attemptFor(request, {
    status: "ready", workloadId: "wl-4", handsUrl: w.mcpUrl, token: "tok-4",
    // Built for something else entirely.
    specFingerprint: "3:0000000000000000",
    taskId: "task-a4", dagRootTaskId: "dag-a4", namespace: "ns",
  });

  assert.equal(await recoverTurn(a), null, "the caller goes on to build a fresh sandbox");
  assert.deepEqual(stopped, ["wl-4"], "and the stale-spec sandbox was torn down first");
});

test("D5 a DAG with no handle of its own still adopts a warm sibling sandbox", async () => {
  // The other no-regression pin. Cross-DAG reuse inside a session is the point
  // of `registerReusedDagHandle`, and the obvious-looking fix -- asking
  // `entryOwnedByAnother` before adopting -- would have ended it: for a fresh
  // DAG adopting a warm pod, `entryRoot !== mineRoot` and it holds no handle on
  // that workload, so the answer is always "somebody else's" and every session
  // would pay for a second GPU.
  const w = await sandbox();
  await replaceDagHandle("dag-a5", "main", {
    workload_id: "wl-5", hands_url: w.mcpUrl, token: "tok-5", image: IMAGE, namespace: "ns",
  });

  const request = requestFor("dag-b5", "task-b5");
  const { stopped, registered } = stubEffects();
  const a = attemptFor(request, {
    status: "ready", workloadId: "wl-5", handsUrl: w.mcpUrl, token: "tok-5",
    specFingerprint: requestSpecFingerprint(request, actionFor(request)),
    taskId: "task-a5", dagRootTaskId: "dag-a5", namespace: "ns",
  });

  const result = await recoverTurn(a);

  assert.equal(result?.identity?.workloadId, "wl-5", "the warm sandbox is shared, as designed");
  assert.deepEqual(stopped, []);
  assert.deepEqual(registered.map((r) => r.workloadId), ["wl-5"]);
  assert.equal(
    (await lookupDagHandle("dag-b5", "main"))?.workload_id, "wl-5",
    "and the adopting DAG now holds a handle on it, so its cancel can find it",
  );
});

test("D6 a sandbox whose spec changed is not stopped while work is still running in it", async () => {
  // The own-handle path may release a sandbox to free its name, and a changed
  // image is the one reason it does that over a container that is ALIVE. A
  // background shell outlives the turn that started it, and "the spec changed"
  // is not a reason to kill work that is still going -- while this sandbox is
  // named by no session slot, so there is nothing to retain it under either.
  // Refusing leaves the work running; succeeding by killing it does not.
  const w = await sandbox();
  await replaceDagHandle("dag-a6", "main", {
    workload_id: "wl-6", hands_url: w.mcpUrl, token: "tok-6",
    image: "example.io/torch@sha256:bbbb", namespace: "ns",
  });

  const request = requestFor("dag-a6", "task-a6");
  const { stopped } = stubEffects({
    countLiveWork: (async () => ({
      verdict: "protected", classes: { bg_shell: 1 }, reason: "bg_shell_running",
    })) as never,
  });
  const other = await sandbox();
  const a = attemptFor(request, {
    status: "ready", workloadId: "wl-other", handsUrl: other.mcpUrl, token: "tok-other",
    specFingerprint: requestSpecFingerprint(request, actionFor(request)),
    taskId: "task-b6", dagRootTaskId: "dag-b6", namespace: "ns",
  });

  await assert.rejects(() => recoverTurn(a), /still holds work that is running/);
  assert.deepEqual(stopped, [], "the container with work in it was left alone");
  assert.equal((await lookupDagHandle("dag-a6", "main"))?.workload_id, "wl-6",
    "and its handle still names it, so a teardown can still find it");
  assert.ok(await w.alive());
});

test("D7 -- and is stopped, and the name freed, when nothing is running in it", async () => {
  // The other half of D6: once the container is clear, a spec change on the
  // disagreement path still rebuilds, which means the name has to be released
  // or the replacement's registration is refused in turn.
  const w = await sandbox();
  await replaceDagHandle("dag-a7", "main", {
    workload_id: "wl-7", hands_url: w.mcpUrl, token: "tok-7",
    image: "example.io/torch@sha256:bbbb", namespace: "ns",
  });

  const request = requestFor("dag-a7", "task-a7");
  const { stopped } = stubEffects();
  const other = await sandbox();
  const a = attemptFor(request, {
    status: "ready", workloadId: "wl-other", handsUrl: other.mcpUrl, token: "tok-other",
    specFingerprint: requestSpecFingerprint(request, actionFor(request)),
    taskId: "task-b7", dagRootTaskId: "dag-b7", namespace: "ns",
  });

  const result = await recoverTurn(a);

  assert.deepEqual(stopped, ["wl-7"], "the old-spec sandbox is stopped");
  // Freeing the name is what lets the turn go anywhere at all. Here the session
  // slot happens to hold a sibling's sandbox built to the spec this request
  // does ask for, so the ordinary warm-pod adoption takes it; had it not, the
  // caller would have provisioned, and that registration would have committed
  // for the same reason this one did -- the name was released.
  assert.equal(result?.identity?.workloadId, "wl-other");
  assert.equal(
    (await lookupDagHandle("dag-a7", "main"))?.workload_id, "wl-other",
    "the handle names what the DAG is now on, and the registration was not refused",
  );
});
