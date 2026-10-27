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
import fs from "node:fs";
import { secretValuesOf } from "../src/apps/app-env.js";
import { applyPlatformKeyEnv } from "../src/sandbox/params.js";
import { ensureAppSandbox, readSandboxNodeName, type AppSandboxRun } from "../src/apps/app-sandbox.js";
import { SANDBOX_DEFAULT_TIMEOUT_SECONDS } from "../src/config.js";
import { workloadTimeoutSeconds } from "../src/sandbox/safe-workload-provider.js";
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
  const workloads: Array<{ id: string; env: Record<string, string>; phase: string; labels?: Record<string, string> }> = [];
  const created: SandboxCreateParams[] = [];
  const stopped: string[] = [];
  let listStatus = 200;
  let extraItems: Array<Record<string, unknown>> = [];
  let listCalls = 0;
  let createFailsAfterProvisioned: Error | null = null;
  const provider = {
    kind: "safe-workload",
    async create(p: SandboxCreateParams): Promise<SandboxInstance> {
      created.push(p);
      const id = `wl-${workloads.length + 1}`;
      workloads.push({ id, env: p.env, phase: "Running" });
      await p.onProvisioned?.(id);
      if (createFailsAfterProvisioned) throw createFailsAfterProvisioned;
      // Like the real provider, the handle it returns names a Hands URL.
      return { provider: "safe-workload", id, sandboxName: id, namespace: p.namespace, handsBaseUrl: `http://router/${id}:9100/mcp`, platformKey: p.platformKey };
    },
    async stop(inst: { id: string }) { stopped.push(inst.id); },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restore.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  const fetch = (async (input: unknown) => {
    const url = new URL(String(input), "http://safe.test");
    if (listStatus !== 200) return new Response("nope", { status: listStatus });
    const envValue = url.searchParams.get("envValue");
    listCalls++;
    // Newest first, like the real list. The phase filter is deliberately NOT
    // applied: a SaFE where it does not take effect returns every phase.
    const items = [...workloads].reverse()
      .filter((w) => w.env[url.searchParams.get("envKey") ?? ""] === envValue)
      .map((w) => ({ workloadId: w.id, phase: w.phase, groupVersionKind: { kind: "Sandbox" }, ...(w.labels ? { labels: w.labels } : {}) }));
    const all = [...items, ...extraItems];
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
    return new Response(JSON.stringify({ totalCount: all.length, items: all.slice(offset, offset + limit) }), { status: 200 });
  }) as typeof globalThis.fetch;
  return {
    workloads, created, stopped, fetch,
    get listCalls() { return listCalls; },
    failList() { listStatus = 503; },
    withExtraItems(x: Array<Record<string, unknown>>) { extraItems = x; },
    failCreateAfterProvisioned(e: Error) { createFailsAfterProvisioned = e; },
  };
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
  // Session teardown deletes what it finds by this env: an app sandbox must not carry it.
  assert.equal(p.env.CLAW_SESSION_ID, undefined);
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

test("a terminal workload in the list is never adopted, whatever the server filtered", async () => {
  const safe = fakeSafe();
  const deps = { fetch: safe.fetch, recordWorkloadId: async () => {} };
  const a = await ensureAppSandbox(run(), deps);
  safe.workloads[0]!.phase = "Failed"; // still carries the run's env, and still in the list
  const b = await ensureAppSandbox(run({ sandboxWorkloadId: a.workloadId }), deps);
  assert.notEqual(b.workloadId, a.workloadId, "the dead workload is not adopted");
  assert.equal(b.created, true);
  for (const phase of ["Stopped", "Succeeded", "Terminated", "Cancelled"]) {
    safe.workloads[safe.workloads.length - 1]!.phase = phase;
    const c = await ensureAppSandbox(run({ sandboxWorkloadId: b.workloadId }), deps);
    assert.equal(c.created, true, `${phase} is terminal too`);
  }
});

test("surplus live workloads are stopped; with nothing recorded the newest Running one is adopted and recorded", async () => {
  const safe = fakeSafe();
  const deps = { fetch: safe.fetch, recordWorkloadId: async () => {} };
  await ensureAppSandbox(run(), deps); // wl-1
  safe.workloads.push({ id: "wl-2", env: { ...safe.workloads[0]!.env }, phase: "Running" });
  safe.workloads.push({ id: "wl-3", env: { ...safe.workloads[0]!.env }, phase: "Running" });
  const recorded: string[] = [];
  const out = await ensureAppSandbox(run({ sandboxWorkloadId: null }), { ...deps, recordWorkloadId: async (_r, w) => { recorded.push(w); } });
  assert.equal(out.workloadId, "wl-3");
  assert.deepEqual(safe.stopped.sort(), ["wl-1", "wl-2"]);
  assert.deepEqual(recorded, ["wl-3"]);
});

test("the recorded workload is adopted over a newer one, and a Running one over a newer Pending twin", async () => {
  const safe = fakeSafe();
  const deps = { fetch: safe.fetch, recordWorkloadId: async () => {}, waitRunning: async () => {} };
  await ensureAppSandbox(run(), deps); // wl-1, Running: the application is in it
  // A takeover race created a Pending twin, which is the newest.
  safe.workloads.push({ id: "wl-2", env: { ...safe.workloads[0]!.env }, phase: "Pending" });
  const recorded: string[] = [];
  const rec = { ...deps, recordWorkloadId: async (_r: string, w: string) => { recorded.push(w); } };
  const a = await ensureAppSandbox(run({ sandboxWorkloadId: "wl-1" }), rec);
  assert.equal(a.workloadId, "wl-1", "the recorded, running workload is kept");
  assert.deepEqual(safe.stopped, ["wl-2"], "the twin is the surplus, not the running application");
  assert.deepEqual(recorded, [], "already recorded: nothing to write");
  // Nothing recorded: a Running workload still beats a newer Pending one.
  safe.stopped.length = 0;
  const b = await ensureAppSandbox(run({ sandboxWorkloadId: null }), rec);
  assert.equal(b.workloadId, "wl-1");
  assert.deepEqual(safe.stopped, ["wl-2"]);
  assert.deepEqual(recorded, ["wl-1"]);
  // The recorded one wins even over a Running newer one.
  safe.workloads[1]!.phase = "Running";
  safe.stopped.length = 0;
  const c = await ensureAppSandbox(run({ sandboxWorkloadId: "wl-1" }), rec);
  assert.equal(c.workloadId, "wl-1");
  assert.deepEqual(safe.stopped, ["wl-2"]);
});

test("surplus is given up only once the adopted workload is Running: a failed wait leaves the others", async () => {
  const safe = fakeSafe();
  await ensureAppSandbox(run(), { fetch: safe.fetch, recordWorkloadId: async () => {} }); // wl-1
  safe.workloads[0]!.phase = "Pending";
  safe.workloads.push({ id: "wl-2", env: { ...safe.workloads[0]!.env }, phase: "Pending" });
  await assert.rejects(
    ensureAppSandbox(run({ sandboxWorkloadId: null }), {
      fetch: safe.fetch, recordWorkloadId: async () => {},
      waitRunning: async () => { throw new Error("sandbox_status_unreadable"); },
    }),
    /sandbox_status_unreadable/,
  );
  assert.deepEqual(safe.stopped, ["wl-2"], "only the adopted one is stopped; wl-1 survives for the next attempt");
});

test("surplus workloads are stopped concurrently, not one after another", async () => {
  const safe = fakeSafe();
  await ensureAppSandbox(run(), { fetch: safe.fetch, recordWorkloadId: async () => {} });
  for (const id of ["wl-2", "wl-3", "wl-4"]) safe.workloads.push({ id, env: { ...safe.workloads[0]!.env }, phase: "Running" });
  let inFlight = 0, peak = 0;
  const stop = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; };
  await ensureAppSandbox(run({ sandboxWorkloadId: "wl-1" }), { fetch: safe.fetch, recordWorkloadId: async () => {}, stop });
  assert.equal(peak, 3);
});

test("a workload whose labels say it is not this run's app sandbox is not adopted or stopped, whatever its env", async () => {
  const safe = fakeSafe();
  const deps = { fetch: safe.fetch, recordWorkloadId: async () => {} };
  const mine = await ensureAppSandbox(run(), deps); // wl-1, no labels reported by the list
  // A Hands sandbox (and another run's app sandbox) whose env happens to carry the run id.
  safe.workloads.push({ id: "wl-hands", env: { ...safe.workloads[0]!.env }, phase: "Running", labels: { "primus-claw/component": "hands", "primus-claw/app-run-id": "run-1" } });
  safe.workloads.push({ id: "wl-other", env: { ...safe.workloads[0]!.env }, phase: "Running", labels: { "primus-claw/component": "app", "primus-claw/app-run-id": "run-9" } });
  const out = await ensureAppSandbox(run({ sandboxWorkloadId: mine.workloadId }), deps);
  assert.equal(out.workloadId, "wl-1");
  assert.deepEqual(safe.stopped, [], "neither foreign workload is stopped as surplus");
  // And its own labels, when reported, are accepted.
  safe.workloads.push({ id: "wl-3", env: { ...safe.workloads[0]!.env }, phase: "Running", labels: { "primus-claw/component": "app", "primus-claw/app-run-id": "run-1" } });
  const again = await ensureAppSandbox(run({ sandboxWorkloadId: "wl-3" }), deps);
  assert.equal(again.workloadId, "wl-3");
  assert.deepEqual(safe.stopped, ["wl-1"]);
});

test("a manifest cannot put the session env on an app sandbox: session teardown must never find it", async () => {
  const safe = fakeSafe();
  const r = run();
  await ensureAppSandbox({ ...r, sandboxSpec: { ...r.sandboxSpec, env: { CLAW_SESSION_ID: "sess-1", KEEP: "1" } } }, { fetch: safe.fetch, recordWorkloadId: async () => {} });
  assert.equal(safe.created[0]!.env.CLAW_SESSION_ID, undefined);
  assert.equal(safe.created[0]!.env.KEEP, "1");
});

test("a created instance and an adopted one are the same handle: no Hands URL either way", async () => {
  const safe = fakeSafe();
  const deps = { fetch: safe.fetch, recordWorkloadId: async () => {} };
  const made = await ensureAppSandbox(run(), deps);
  const found = await ensureAppSandbox(run(), deps);
  assert.equal(made.created, true);
  assert.equal(made.instance.handsBaseUrl, "");
  assert.deepEqual(made.instance, found.instance);
});

test("a stop that fails does not fail the run, and is not hidden", async () => {
  const safe = fakeSafe();
  const deps = { fetch: safe.fetch, recordWorkloadId: async () => {} };
  await ensureAppSandbox(run(), deps);
  safe.workloads.push({ id: "wl-2", env: { ...safe.workloads[0]!.env }, phase: "Running" });
  const out = await ensureAppSandbox(run(), { ...deps, stop: async () => { throw new Error("SaFE down"); } });
  assert.equal(out.workloadId, "wl-2");
});

test("adopting a Pending workload records its id before the wait, so a failed wait still leaves it", async () => {
  const safe = fakeSafe();
  await ensureAppSandbox(run(), { fetch: safe.fetch, recordWorkloadId: async () => {} });
  safe.workloads[0]!.phase = "Pending";
  const recorded: string[] = [];
  await assert.rejects(
    ensureAppSandbox(run({ sandboxWorkloadId: null }), {
      fetch: safe.fetch,
      recordWorkloadId: async (_r, w) => { recorded.push(w); },
      waitRunning: async () => { throw new Error("sandbox_pending_timeout"); },
    }),
    /sandbox_pending_timeout/,
  );
  assert.deepEqual(recorded, ["wl-1"]);
  assert.deepEqual(safe.stopped, ["wl-1"], "a workload that cannot be brought to Running is stopped, not adopted again for ever");
});

test("a create that fails after the workload exists stops it", async () => {
  for (const [name, mk] of [
    ["the wait gives up", (safe: ReturnType<typeof fakeSafe>) => safe.failCreateAfterProvisioned(new Error("sandbox_pending_timeout"))],
  ] as const) {
    const safe = fakeSafe();
    mk(safe);
    await assert.rejects(ensureAppSandbox(run(), { fetch: safe.fetch, recordWorkloadId: async () => {} }), /sandbox_pending_timeout/, name);
    assert.deepEqual(safe.stopped, ["wl-1"], name);
  }
  // The record itself fails: the id was known, so it is still stopped.
  const safe = fakeSafe();
  await assert.rejects(
    ensureAppSandbox(run(), { fetch: safe.fetch, recordWorkloadId: async () => { throw new Error("db down"); } }),
    /db down/,
  );
  assert.deepEqual(safe.stopped, ["wl-1"]);
  // A create that fails before any workload exists has nothing to stop.
  const none = fakeSafe();
  await assert.rejects(ensureAppSandbox(run(), { fetch: none.fetch, recordWorkloadId: async () => {}, create: async () => { throw new Error("400"); } }), /400/);
  assert.deepEqual(none.stopped, []);
});

test("no resources is an error in Brain, not an empty POST", async () => {
  for (const resources of [undefined, {}]) {
    const safe = fakeSafe();
    const r = run();
    await assert.rejects(
      ensureAppSandbox({ ...r, sandboxSpec: { ...r.sandboxSpec, resources } as never }, { fetch: safe.fetch, recordWorkloadId: async () => {} }),
      /no resources/,
    );
    assert.equal(safe.created.length, 0);
  }
});

test("a spec with no timeout gets the platform default, not the provider's maximum", async () => {
  const safe = fakeSafe();
  const r = run();
  const { timeout: _t, ...spec } = r.sandboxSpec as Record<string, unknown>;
  await ensureAppSandbox({ ...r, sandboxSpec: spec as never }, { fetch: safe.fetch, recordWorkloadId: async () => {} });
  // What SaFE is sent is what the provider makes of the argument (it adds its shutdown buffer).
  assert.equal(workloadTimeoutSeconds(safe.created[0]!.timeoutSec, null), SANDBOX_DEFAULT_TIMEOUT_SECONDS);
  assert.ok(Number(safe.created[0]!.timeoutSec) > 0);
});

test("the pagination stop compares items seen with the total: other kinds and id-less rows do not cause extra pages or a false overflow", async () => {
  const safe = fakeSafe();
  await ensureAppSandbox(run(), { fetch: safe.fetch, recordWorkloadId: async () => {} });
  // 200 rows the lookup must ignore (wrong kind), more than LIST_MAX_PAGES * page size would allow if it counted kept rows.
  safe.withExtraItems(Array.from({ length: 150 }, (_, i) => ({ workloadId: `job-${i}`, phase: "Running", groupVersionKind: { kind: "PyTorchJob" } })));
  const before = safe.listCalls;
  const out = await ensureAppSandbox(run({ sandboxWorkloadId: "wl-1" }), { fetch: safe.fetch, recordWorkloadId: async () => {} });
  assert.equal(out.workloadId, "wl-1");
  assert.equal(out.created, false);
  assert.equal(safe.listCalls - before, 4, "151 rows at 50 a page: the pages that exist, no more");
});

test("an adopted instance names no Hands URL: there is no Hands in an app sandbox", async () => {
  const safe = fakeSafe();
  const deps = { fetch: safe.fetch, recordWorkloadId: async () => {} };
  await ensureAppSandbox(run(), deps);
  const out = await ensureAppSandbox(run(), deps);
  assert.equal(out.created, false);
  assert.equal(out.instance.handsBaseUrl, "");
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

// ── model credentials: the keys a Hands sandbox gets ─────────────

test("an app sandbox is created with the two model keys Hands gets, and nothing more of the platform's", async () => {
  const safe = fakeSafe();
  await ensureAppSandbox(run({ platformKey: "ak-owner" }), { fetch: safe.fetch, recordWorkloadId: async () => {} });
  const env = safe.created[0]!.env;
  assert.equal(env.ANTHROPIC_API_KEY, "ak-owner");
  assert.equal(env.OPENAI_API_KEY, "ak-owner");
  // Hands' builder gives the same two for the same owner (plus SAFE_API_KEY, which an app must not hold).
  const hands: Record<string, string> = {};
  applyPlatformKeyEnv(hands, "ak-owner", false);
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) assert.equal(env[k], hands[k], k);
  assert.ok(!("SAFE_API_KEY" in env), "the owner's SaFE platform key does not reach app code");
  assert.equal(env.FROM_SPEC, "1");
  assert.equal(env.CLAW_APP_RUN_ID, "run-1");
});

test("a spec can neither replace the model keys nor plant SAFE_API_KEY", async () => {
  const safe = fakeSafe();
  const r = run({ platformKey: "ak-owner" });
  r.sandboxSpec = { ...r.sandboxSpec, env: { ANTHROPIC_API_KEY: "spec-key", SAFE_API_KEY: "planted" } };
  await ensureAppSandbox(r, { fetch: safe.fetch, recordWorkloadId: async () => {} });
  assert.equal(safe.created[0]!.env.ANTHROPIC_API_KEY, "ak-owner");
  assert.ok(!("SAFE_API_KEY" in safe.created[0]!.env));
});

test("the gateway URLs are the image's or the manifest's: Brain injects none, and a spec's pass through", async () => {
  const safe = fakeSafe();
  await ensureAppSandbox(run({ platformKey: "ak-owner" }), { fetch: safe.fetch, recordWorkloadId: async () => {} });
  const env = safe.created[0]!.env;
  assert.ok(!("ANTHROPIC_BASE_URL" in env) && !("OPENAI_BASE_URL" in env));
  const r = run({ platformKey: "ak-owner" });
  r.sandboxSpec = { ...r.sandboxSpec, env: { OPENAI_BASE_URL: "https://own.example/v1" } };
  const safe2 = fakeSafe();
  await ensureAppSandbox(r, { fetch: safe2.fetch, recordWorkloadId: async () => {} });
  assert.equal(safe2.created[0]!.env.OPENAI_BASE_URL, "https://own.example/v1");
});

test("the model key is in the run's scrub set", () => {
  const secrets = secretValuesOf({ mcpToken: "m", grantKeys: { a: "g" } as never, platformKey: "ak-owner" });
  assert.ok(secrets.includes("ak-owner"));
  assert.deepEqual(secretValuesOf({ mcpToken: "m", grantKeys: {} }), ["m"]);
});

test("creating an app sandbox never writes the model key to a log", async () => {
  const written: string[] = [];
  const realWrite = fs.writeSync;
  (fs as { writeSync: unknown }).writeSync = (fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1 || fd === 2) written.push(String(data));
    return (realWrite as (...a: unknown[]) => number)(fd, data, ...rest);
  };
  const realAsync = fs.write;
  (fs as { write: unknown }).write = (fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1 || fd === 2) written.push(String(data));
    return (realAsync as (...a: unknown[]) => unknown)(fd, data, ...rest);
  };
  const realOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { written.push(String(chunk)); return (realOut as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
  restore.push(() => { (fs as { writeSync: unknown }).writeSync = realWrite; (fs as { write: unknown }).write = realAsync; process.stdout.write = realOut; });
  const safe = fakeSafe();
  await ensureAppSandbox(run({ platformKey: "ak-LEAKCANARY" }), {
    fetch: safe.fetch, recordWorkloadId: async () => {},
  });
  await new Promise((r) => setTimeout(r, 100));
  const out = written.join("");
  assert.match(out, /app_sandbox\.created/, "the capture sees the log line");
  assert.ok(!out.includes("ak-LEAKCANARY"));
});
