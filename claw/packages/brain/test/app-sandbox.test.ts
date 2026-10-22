// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The app sandbox: created through the shared provider path, labelled so Pulse
 * and the lookup can find it, never in the hands keyspace the reaper walks, and
 * never duplicated for one run.
 */
import "./sweeper-evict-env.js";

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { listingEndsOnOtherOps } from "./kv-listing-stub.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import { ensureAppSandbox, readSandboxNodeName, type AppSandboxRun } from "../src/apps/app-sandbox.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { bindClusterReclaimForTest, sweepStaleHandsForTest } from "../src/sandbox/reaper.js";
import type { SandboxCreateParams, SandboxInstance, SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const realFetch = globalThis.fetch;
let restore: Array<() => void> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const r of restore.splice(0)) r();
});

/** An in-memory SaFE: the workload list and the provider that fills it. */
function fakeSafe() {
  const workloads: Array<{ id: string; env: Record<string, string>; phase: string }> = [];
  const created: SandboxCreateParams[] = [];
  const stopped: string[] = [];
  let listStatus = 200;
  const provider = {
    kind: "safe-workload",
    async create(p: SandboxCreateParams): Promise<SandboxInstance> {
      created.push(p);
      const id = `wl-${workloads.length + 1}`;
      workloads.push({ id, env: p.env, phase: "Running" });
      await p.onProvisioned?.(id);
      return { provider: "safe-workload", id, sandboxName: id, namespace: p.namespace, handsBaseUrl: "", platformKey: p.platformKey };
    },
    async stop(inst: { id: string }) { stopped.push(inst.id); },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restore.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  const fetch = (async (input: unknown) => {
    const url = new URL(String(input), "http://safe.test");
    if (listStatus !== 200) return new Response("nope", { status: listStatus });
    const envValue = url.searchParams.get("envValue");
    const items = workloads
      .filter((w) => w.env[url.searchParams.get("envKey") ?? ""] === envValue)
      .map((w) => ({ workloadId: w.id, phase: w.phase, groupVersionKind: { kind: "Sandbox" } }));
    return new Response(JSON.stringify({ totalCount: items.length, items }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { workloads, created, stopped, fetch, failList() { listStatus = 503; } };
}

function run(over: Partial<AppSandboxRun> = {}): AppSandboxRun {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    workspaceId: "ws-1",
    platformKey: "pk",
    sandboxSpec: {
      handle: "app",
      image: "registry.example/app:1",
      resources: { cpu: "4", memory: "16Gi" },
      timeout: 600,
      env: { FROM_SPEC: "1" },
      // A manifest must not be able to relabel its sandbox as something else.
      labels: { custom: "x", "primus-claw/session-id": "evil", "primus-claw/component": "hands" },
    },
    ...over,
  };
}

test("an app sandbox carries the session, component and run labels, via the shared provider", async () => {
  const safe = fakeSafe();
  const recorded: Array<[string, string]> = [];
  const out = await ensureAppSandbox(run(), {
    fetch: safe.fetch,
    recordWorkloadId: async (r, w) => { recorded.push([r, w]); },
  });
  assert.equal(out.created, true);
  assert.equal(safe.created.length, 1);
  const p = safe.created[0]!;
  assert.equal(p.labels!["primus-claw/session-id"], "sess-1");
  assert.equal(p.labels!["primus-claw/component"], "app");
  assert.equal(p.labels!["primus-claw/app-run-id"], "run-1");
  assert.equal(p.labels!["team"], "primus-claw");
  assert.equal(p.labels!["custom"], "x");
  assert.equal(p.image, "registry.example/app:1");
  assert.deepEqual(p.resources, { cpu: "4", memory: "16Gi" });
  assert.equal(p.timeoutSec, 600);
  assert.equal(p.namespace, "ws-1");
  assert.equal(p.platformKey, "pk");
  assert.equal(p.env.FROM_SPEC, "1");
  assert.equal(p.env.CLAW_APP_RUN_ID, "run-1");
  assert.equal(p.env.CLAW_SESSION_ID, "sess-1");
  assert.deepEqual(recorded, [["run-1", "wl-1"]], "the id is recorded");
});

test("a second call for the same run returns the same sandbox and creates nothing", async () => {
  const safe = fakeSafe();
  const deps = { fetch: safe.fetch, recordWorkloadId: async () => {} };
  const a = await ensureAppSandbox(run(), deps);
  // A Brain takeover: the recorded id was lost (or never written).
  const b = await ensureAppSandbox(run({ sandboxWorkloadId: null }), deps);
  const c = await ensureAppSandbox(run({ sandboxWorkloadId: a.workloadId }), deps);
  assert.equal(safe.created.length, 1, "exactly one create call for the run");
  assert.equal(b.workloadId, a.workloadId);
  assert.equal(c.workloadId, a.workloadId);
  assert.equal(b.created, false);
  // Another run is not the same sandbox.
  const d = await ensureAppSandbox(run({ runId: "run-2" }), deps);
  assert.notEqual(d.workloadId, a.workloadId);
  assert.equal(safe.created.length, 2);
});

test("a lookup that cannot be read creates nothing", async () => {
  const safe = fakeSafe();
  safe.failList();
  await assert.rejects(
    ensureAppSandbox(run(), { fetch: safe.fetch, recordWorkloadId: async () => {} }),
    /lookup failed/,
  );
  assert.equal(safe.created.length, 0, "an unreadable list is not an empty one");
});

test("a lost sandbox is replaced; the stale recorded id does not stand in for it", async () => {
  const safe = fakeSafe();
  const deps = { fetch: safe.fetch, recordWorkloadId: async () => {} };
  const a = await ensureAppSandbox(run(), deps);
  safe.workloads[0]!.phase = "Failed"; // the list only returns active phases
  safe.workloads[0]!.env = {}; // ...modelled here as no longer matching
  const b = await ensureAppSandbox(run({ sandboxWorkloadId: a.workloadId }), deps);
  assert.notEqual(b.workloadId, a.workloadId);
  assert.equal(b.created, true);
});

// --- the hands keyspace and the reaper ------------------------------------

const REVISION = 3;
function handsBucket(entries: Array<[string, unknown]>) {
  const values = new Map(entries.map(([k, v]) => [k, JSON.stringify(v)]));
  const writes: string[] = [];
  const raw = {
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...values.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      const v = values.get(key);
      return v === undefined ? null : { key, value: sc.encode(v), revision: REVISION, operation: "PUT" };
    },
    async put(k: string) { writes.push(`put ${k}`); return 1; },
    async create(k: string) { writes.push(`create ${k}`); return 1; },
    async update(k: string) { writes.push(`update ${k}`); return REVISION + 1; },
    async delete(k: string) { writes.push(`delete ${k}`); values.delete(k); },
  };
  return { kv: listingEndsOnOtherOps(raw) as unknown as KV, writes, values };
}

function handsEntry(workloadId: string) {
  return {
    status: "ready", provider: "safe-workload", workloadId, platformKey: "pk", namespace: "ns",
    handsUrl: `http://${workloadId}:9100/mcp`, token: "t",
  };
}

function unhealthyEverywhere() {
  globalThis.fetch = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;
}

test("ensureAppSandbox writes nothing under hands.*, and the reaper's sweep never stops it", async () => {
  const safe = fakeSafe();
  const bucket = handsBucket([["hands.s-other", handsEntry("wl-hands-other")]]);
  bindHandsKv(bucket.kv);
  restore.push(bindClusterReclaimForTest(async () => 0));

  const app = await ensureAppSandbox(run(), { fetch: safe.fetch, recordWorkloadId: async () => {} });
  assert.deepEqual(bucket.writes, [], "no KV write of any kind");
  assert.equal([...bucket.values.keys()].some((k) => k.includes("sess-1") || k.includes(app.workloadId)), false);

  unhealthyEverywhere(); // everything the sweep can see is unhealthy
  await sweepStaleHandsForTest();
  assert.ok(!safe.stopped.includes(app.workloadId), "the app sandbox was not stopped");
  assert.deepEqual(safe.stopped, ["wl-hands-other"], "the sweep did run, and stopped only the hands entry");
});

test("control: the same sandbox registered under hands.* IS stopped by the sweep", async () => {
  const safe = fakeSafe();
  const app = await ensureAppSandbox(run(), { fetch: safe.fetch, recordWorkloadId: async () => {} });
  bindHandsKv(handsBucket([["hands.sess-1", handsEntry(app.workloadId)]]).kv);
  restore.push(bindClusterReclaimForTest(async () => 0));
  unhealthyEverywhere();
  await sweepStaleHandsForTest();
  assert.deepEqual(safe.stopped, [app.workloadId],
    "if this fails the test above proves nothing: the sweep would not have stopped it even if registered");
});

// --- node name ------------------------------------------------------------

test("the node name comes from the workload detail, and is null when there is none", async () => {
  const detail = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  assert.equal(
    await readSandboxNodeName("wl-1", "pk", detail({ pods: [{ phase: "Running", adminNodeName: "node-7" }] })),
    "node-7",
  );
  assert.equal(await readSandboxNodeName("wl-1", "pk", detail({ pods: [] })), null);
  assert.equal(await readSandboxNodeName("wl-1", "pk", (async () => new Response("", { status: 500 })) as typeof fetch), null);
});
