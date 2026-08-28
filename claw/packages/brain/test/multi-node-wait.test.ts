// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The multi-node provisioning wait.
//
// Every case here is a way a GPU cluster used to be polled forever. The
// multi-node loop had a queue ceiling and none of the backstops, and the ceiling
// only advances on a readable Pending -- so a SaFE that could not be reached,
// kept refusing, answered without a phase, or had lost the workload left the
// wait with no exit at all, holding GPUs and a run slot. The cases are driven
// through the shared loop's seams with a scripted status sequence and a clock the
// test moves itself, since every rule under test is about elapsed time.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";
import { waitForWorkloadReady, type WorkloadWaitDeps } from "../src/sandbox/workload-wait.js";
import { gpuPodsReady, discoverRolePods } from "../src/sandbox/multi-node/safe-pods.js";

// Read when the provider module loads.
process.env.SAFE_API_URL = "http://safe.test";
const { SafeMultiNodeProvider } = await import("../src/sandbox/multi-node/safe-provider.js");
const { resolveTopology } = await import("../src/sandbox/multi-node/prompt-flags.js");

type Entry =
  | { status: number; body?: Record<string, unknown> }
  | { status: number; badJson: true }
  | { throw: string };

/** Replays `entries` in order, repeating the last so one entry can express a
 *  persistent condition (a SaFE that stays down, a workload that stays gone). */
function scriptedFetch(entries: Entry[]) {
  let i = 0;
  return (async (_url: string, _opts?: unknown) => {
    const e = entries[Math.min(i, entries.length - 1)]!;
    i++;
    if ("throw" in e) throw new Error(e.throw);
    const ok = e.status < 400;
    if ("badJson" in e) {
      return { ok, status: e.status, json: async () => { throw new Error("Unexpected token < in JSON"); } };
    }
    return { ok, status: e.status, json: async () => e.body ?? {} };
  }) as unknown as typeof fetch;
}

function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => { nowMs += ms; },
    get value() { return nowMs; },
  };
}

/** A live Infera worker pod, the shape discoverRolePods reads.
 *
 *  role1 rather than role0: a colocated topology's positional roles are
 *  ["frontend", "worker"], and readiness is the worker's. */
const workerPod = { podId: "wl-1-role1-abc-0", podIP: "10.0.0.1", phase: "Running" };

interface WaitCase {
  entries: Entry[];
  /** Defaults to a RayJob's rule: the phase and nothing more. */
  isReady?: (detail: Record<string, unknown>) => boolean;
  deps?: Partial<WorkloadWaitDeps>;
}

/** Runs the wait as the multi-node provider configures it, and records the
 *  reasons a give-up reached the reap hook. */
function runWait(c: WaitCase) {
  const clock = fakeClock();
  const reaped: string[] = [];
  const progress: number[] = [];
  const p = waitForWorkloadReady({
    workloadId: "wl-1",
    apiKey: "key",
    logPrefix: "mn.safe",
    isReady: c.isReady ?? ((d) => String(d.phase ?? "").toLowerCase() === "running"),
    onGiveUp: async ({ reason }) => { reaped.push(reason); },
    onProgress: async () => { progress.push(clock.value); },
    deps: {
      fetchImpl: scriptedFetch(c.entries),
      sleepImpl: clock.sleep,
      nowImpl: clock.now,
      pollMs: 5000,
      unreadableTimeoutMs: 30_000,
      pendingTimeoutMs: 0,
      ...c.deps,
    },
  });
  return { p, clock, reaped, progress };
}

// ── the four waits that had no exit ──────────────────────────────────────────

test("a SaFE that cannot be reached ends the wait and reaps the cluster", async () => {
  // The fetch itself fails (DNS, TLS, connect). The old loop caught this into a
  // null and fell straight through to its sleep, so the cluster was polled for
  // as long as the process lived.
  const { p, clock, reaped } = runWait({ entries: [{ throw: "ECONNREFUSED" }] });

  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_status_unreadable");
    return true;
  });
  assert.ok(clock.value > 30_000, "the backstop must be what ended it, not a first failure");
  assert.deepEqual(reaped, ["sandbox_status_unreadable"], "a cluster nobody waits on must be reaped");
});

test("a SaFE that keeps refusing ends the wait", async () => {
  // 401/403/500 alike: the old loop only looked at status === 200, so anything
  // else was indistinguishable from "not ready yet" and waited forever.
  for (const status of [401, 403, 500]) {
    const { p, reaped } = runWait({ entries: [{ status }] });
    await assert.rejects(p, (err: any) => {
      assert.equal(err.reason, "sandbox_status_unreadable", `HTTP ${status} must end the wait`);
      return true;
    });
    assert.deepEqual(reaped, ["sandbox_status_unreadable"]);
  }
});

test("a 2xx carrying no phase ends the wait", async () => {
  // Neither terminal, nor ready, nor pending: this answer matched none of the
  // old loop's three exits, so it was the quietest way to hang.
  const { p, reaped } = runWait({ entries: [{ status: 200, body: { queuePosition: 0 } }] });

  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_status_unreadable");
    return true;
  });
  assert.deepEqual(reaped, ["sandbox_status_unreadable"]);
});

test("a workload that has been deleted ends the wait as gone", async () => {
  // The old loop had no 404 rule at all, so a cluster deleted underneath it --
  // by a session teardown, an admin, or the idle sweeper -- was waited on
  // forever for a workload that no longer existed.
  const { p, clock, reaped } = runWait({
    entries: [{ status: 404 }],
    deps: { unreadableTimeoutMs: 0 }, // isolate the gone rule from the backstop
  });

  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_gone");
    return true;
  });
  assert.equal(clock.value, 12 * 5_000, "gone must wait for the 12th consecutive 404");
  assert.deepEqual(reaped, ["sandbox_gone"]);
});

// ── readiness, which is the one thing that stays per-topology ────────────────

test("a RayJob is ready on the phase alone", async () => {
  const { p, reaped } = runWait({ entries: [{ status: 200, body: { phase: "Running" } }] });
  const detail = await p;
  assert.equal(detail.phase, "Running");
  assert.deepEqual(reaped, [], "a cluster that came up must not be reaped");
});

test("an Infera cluster reporting Running is not ready until its role pods are", async () => {
  // Running with no live role pod is not usable: external mode addresses the
  // pods directly over SSH. The wait continues, and the detail it finally
  // returns is the one carrying the pods.
  const entries: Entry[] = [
    { status: 200, body: { phase: "Running", pods: [] } },
    { status: 200, body: { phase: "Running", pods: [] } },
    { status: 200, body: { phase: "Running", pods: [workerPod] } },
  ];
  const isReady = (d: Record<string, unknown>) =>
    String(d.phase ?? "").toLowerCase() === "running"
    && gpuPodsReady(discoverRolePods(d, "colocated", 30000), "colocated");

  const { p, clock } = runWait({ entries, isReady });
  const detail = await p;
  assert.ok(Array.isArray(detail.pods) && (detail.pods as unknown[]).length === 1);
  assert.equal(clock.value, 15_000, "it must have kept polling until the pods arrived");
});

test("an Infera role pod that dies while Running ends the wait", async () => {
  // The case a phase check cannot see. discoverRolePods drops a dead pod, so
  // readiness stays false while the phase says Running -- readable, dispatched,
  // never ready. The old loop cleared its pending clock on that phase and had
  // nothing else to stop on, leaving the cluster to its own 24h timeout.
  const isReady = (d: Record<string, unknown>) =>
    String(d.phase ?? "").toLowerCase() === "running"
    && gpuPodsReady(discoverRolePods(d, "colocated", 30000), "colocated");

  const { p, reaped } = runWait({
    entries: [{ status: 200, body: { phase: "Running", pods: [{ ...workerPod, phase: "Failed" }] } }],
    isReady,
    deps: { unreadableTimeoutMs: 0 },
  });

  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_exited_before_ready");
    return true;
  });
  assert.deepEqual(reaped, ["sandbox_exited_before_ready"]);
});

// ── the queue, and what it must not do ──────────────────────────────────────

test("a cluster queued past the ceiling is reaped so it stops holding GPUs", async () => {
  const { p, clock, reaped } = runWait({
    entries: [{ status: 200, body: { phase: "Pending", queuePosition: 4 } }],
    deps: { unreadableTimeoutMs: 0, pendingTimeoutMs: 30_000 },
  });

  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_pending_timeout");
    return true;
  });
  assert.ok(clock.value > 30_000);
  assert.deepEqual(reaped, ["sandbox_pending_timeout"]);
});

test("a long healthy queue wait is never cut short", async () => {
  // The property the backstops must not break: queuing is normal at capacity,
  // and every readable Pending refreshes the unreadable deadline, so a cluster
  // can queue far past it and still come up.
  const entries: Entry[] = [];
  for (let k = 0; k < 40; k++) entries.push({ status: 200, body: { phase: "Pending", queuePosition: 2 } });
  entries.push({ status: 200, body: { phase: "Running" } });

  const { p, clock, reaped } = runWait({ entries, deps: { unreadableTimeoutMs: 30_000 } });
  await p;
  assert.ok(clock.value > 30_000, "the wait must have outlasted the backstop to prove the refresh");
  assert.deepEqual(reaped, [], "a cluster that came up must never be reaped");
});

test("dispatch stops the queue clock, so a slow image pull is not reaped", async () => {
  const entries: Entry[] = [{ status: 200, body: { phase: "Pending", queuePosition: 1 } }];
  for (let k = 0; k < 12; k++) entries.push({ status: 200, body: { phase: "NotReady" } });
  entries.push({ status: 200, body: { phase: "Running" } });

  const { p, clock, reaped } = runWait({
    entries,
    deps: { unreadableTimeoutMs: 0, pendingTimeoutMs: 15_000 },
  });
  await p;
  assert.ok(clock.value > 15_000, "the NotReady stretch must exceed the ceiling for this to prove anything");
  assert.deepEqual(reaped, []);
});

test("a readable status between outages refreshes the backstop", async () => {
  // Neither burst alone reaches the deadline, and the readable poll between them
  // resets it. Without the reset the second burst would trip a wait that is
  // plainly still being answered.
  const entries: Entry[] = [
    { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
    { status: 200, body: { phase: "Pending", queuePosition: 1 } },
    { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 },
    { status: 200, body: { phase: "Running" } },
  ];
  const { p, reaped } = runWait({ entries, deps: { unreadableTimeoutMs: 27_000 } });
  await p;
  assert.deepEqual(reaped, []);
});

// ── the event stream ────────────────────────────────────────────────────────

test("progress is reported once, then throttled for the rest of the wait", async () => {
  // The old loop emitted one event per poll with no gate: at 5s a poll and a 3h
  // ceiling that is ~2160 identical events, each redacted, appended to the run's
  // in-memory transcript and published to NATS. Throttled to the single-node
  // interval, the first is immediate so a queued cluster is visible at once.
  const entries: Entry[] = [];
  for (let k = 0; k < 200; k++) entries.push({ status: 200, body: { phase: "Pending", queuePosition: 1 } });
  entries.push({ status: 200, body: { phase: "Running" } });

  const { p, progress } = runWait({
    entries,
    deps: { unreadableTimeoutMs: 0, notifyIntervalMs: 600_000 },
  });
  await p;

  assert.equal(progress[0], 5_000, "the first report must not wait out the throttle");
  // 201 polls at 5s span just over 1000s, so the 600s gate allows exactly one more.
  assert.equal(progress.length, 2, `expected one report plus one throttled, got ${progress.length}`);
});

// ── the provider's own wiring ───────────────────────────────────────────────
//
// The cases above pin the rules with the readiness function written out by hand.
// These drive the provider's real waitForRunning, which is where the rules are
// wired to this topology: a readiness check asking about the wrong pdMode, or a
// give-up that reaps nothing, would pass every test above.

/** A prompt's parsed topology, so the spec under test is the one a real prompt
 *  produces rather than one hand-assembled to suit. */
function topologyFor(prompt: string) {
  const spec = resolveTopology({ prompt } as ExecuteRequest);
  assert.ok(spec, `prompt did not parse as multi-node: ${prompt}`);
  return spec;
}

/** Records every SaFE request the provider makes, answering from a script. */
function recordSafe(t: TestContext, reply: (method: string, url: string) => Response) {
  const seen: Array<{ method: string; url: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(init?.method ?? "GET");
    const url = String(input);
    seen.push({ method, url });
    return reply(method, url);
  }) as typeof globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  return seen;
}

const fastClock = () => {
  const clock = fakeClock();
  return {
    clock,
    deps: { sleepImpl: clock.sleep, nowImpl: clock.now, pollMs: 5000 } as WorkloadWaitDeps,
  };
};

test("the provider asks about readiness with its own topology", async (t) => {
  // A colocated Infera cluster reporting Running with no live worker pod is not
  // usable. The pod is only classified as a worker against this prompt's
  // positional roles, so this fails if the readiness check is handed the wrong
  // pdMode -- which no hand-written isReady could catch.
  // The stub stops answering after ten polls and the unreadable backstop is left
  // on, so a readiness check that never accepts this pod ends the wait with a
  // reason instead of spinning: "readable but never ready" has no in-loop bound
  // of its own, by design, and a test must not depend on one.
  let polls = 0;
  recordSafe(t, () => {
    polls++;
    if (polls > 10) return new Response("stopped answering", { status: 500 });
    return new Response(JSON.stringify({
      phase: "Running",
      pods: polls < 3 ? [] : [workerPod],
    }), { status: 200 });
  });
  const { clock, deps } = fastClock();

  const detail = await new SafeMultiNodeProvider().waitForRunning(
    "sess-mn", "msg-mn", "mn-msg-mn-infera", "safe-key", "ws-mn",
    topologyFor("serve --nodes 2 --mn-backend infera --mn-model m --mn-image img:1"),
    async () => {},
    { ...deps, unreadableTimeoutMs: 60_000, pendingTimeoutMs: 0 },
  );

  assert.ok(Array.isArray(detail.pods) && (detail.pods as unknown[]).length === 1);
  assert.equal(clock.value, 15_000, "it must have waited for the worker pod, not the phase");
});

test("a rayjob is ready on the phase, without asking about pods", async (t) => {
  recordSafe(t, () => new Response(JSON.stringify({ phase: "Running", pods: [] }), { status: 200 }));
  const { deps } = fastClock();

  const detail = await new SafeMultiNodeProvider().waitForRunning(
    "sess-mn", "msg-mn", "mn-msg-mn-rayjob", "safe-key", "ws-mn",
    topologyFor("train --nodes 2 --mn-backend rayjob --mn-image img:1"),
    async () => {},
    { ...deps, unreadableTimeoutMs: 0, pendingTimeoutMs: 0 },
  );

  assert.equal(detail.phase, "Running", "a rayjob must not be held back by an empty pod list");
});

test("giving up reaps this workload, by id", async (t) => {
  // The reason the wait ended is only half of it: a cluster left behind holds
  // GPUs for the workload's whole timeout, and this DELETE is what stops that.
  // Asserted on the request the provider actually made, so a reap aimed at the
  // wrong id -- or dropped entirely -- is caught.
  const seen = recordSafe(t, (method) =>
    method === "DELETE" ? new Response("", { status: 204 }) : new Response("nope", { status: 500 }));
  const { deps } = fastClock();

  await assert.rejects(
    () => new SafeMultiNodeProvider().waitForRunning(
      "sess-mn", "msg-mn", "mn-msg-mn-rayjob", "safe-key", "ws-mn",
      topologyFor("train --nodes 2 --mn-backend rayjob --mn-image img:1"),
      async () => {},
      { ...deps, unreadableTimeoutMs: 30_000, pendingTimeoutMs: 0 },
    ),
    (err: any) => {
      assert.equal(err.reason, "sandbox_status_unreadable");
      return true;
    },
  );

  const deletes = seen.filter((r) => r.method === "DELETE");
  assert.equal(deletes.length, 1, "giving up must reap exactly once");
  assert.ok(
    deletes[0]!.url.endsWith("/api/v1/workloads/msg-mn"),
    `the reap must address this workload, got ${deletes[0]!.url}`,
  );
});

test("a cluster that comes up is never reaped", async (t) => {
  // The other half of the reap: it must be reachable only from a give-up. A
  // DELETE on a healthy bring-up would destroy the cluster the run needs.
  const seen = recordSafe(t, () => new Response(JSON.stringify({ phase: "Running" }), { status: 200 }));
  const { deps } = fastClock();

  await new SafeMultiNodeProvider().waitForRunning(
    "sess-mn", "msg-mn", "mn-msg-mn-rayjob", "safe-key", "ws-mn",
    topologyFor("train --nodes 2 --mn-backend rayjob --mn-image img:1"),
    async () => {},
    { ...deps, unreadableTimeoutMs: 0, pendingTimeoutMs: 0 },
  );

  assert.deepEqual(seen.filter((r) => r.method === "DELETE"), []);
});

test("a give-up hook that fails does not mask why the wait ended", async () => {
  // The reap is a DELETE against the same SaFE that just stopped answering, so
  // it is the likely case, not the unlikely one. The reason the caller acts on
  // must survive it.
  const clock = fakeClock();
  const p = waitForWorkloadReady({
    workloadId: "wl-1",
    apiKey: "key",
    logPrefix: "mn.safe",
    isReady: (d) => String(d.phase ?? "").toLowerCase() === "running",
    onGiveUp: async () => { throw new Error("DELETE failed: HTTP 503"); },
    deps: {
      fetchImpl: scriptedFetch([{ throw: "ECONNREFUSED" }]),
      sleepImpl: clock.sleep,
      nowImpl: clock.now,
      pollMs: 5000,
      unreadableTimeoutMs: 30_000,
      pendingTimeoutMs: 0,
    },
  });

  await assert.rejects(p, (err: any) => {
    assert.equal(err.reason, "sandbox_status_unreadable", "the hook's failure must not become the reason");
    return true;
  });
});
