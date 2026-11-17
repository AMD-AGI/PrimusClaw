// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A sandbox that waits for capacity which can come is waited for, not given up on.
//
// In a burst GPU pool an admitted sandbox often has no node yet, and the
// autoscaler says why: every account it buys nodes as is at the scheduler's
// per-user limit, a node is still being given back, the pool is at its limit and
// releases an idle node. Each of those ends on its own. The five-minute
// unschedulable limit is for the other kind, a pod that no node will ever take,
// and applied to the first kind it ended every GPU run that had to queue after
// five minutes. These pin which is which, that a wait for capacity runs on the
// capacity ceiling (bounded by what the request's own timeout leaves the run),
// and that the other kind still fails fast.
//
// The platform's text below is the shape it had on the live cluster on
// 2026-11-17: the autoscaler's `NotTriggerScaleUp` event, as the platform writes
// it on an admitted (NotReady) sandbox workload.

import test from "node:test";
import assert from "node:assert/strict";

process.env.SAFE_API_URL = "http://safe.test";
// Read when the config module loads; the create-path tests below run in real time.
process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS = "1";
process.env.SANDBOX_PENDING_TIMEOUT_SECONDS = "10800";
process.env.SANDBOX_MIN_RUN_SECONDS = "2";
const { waitForWorkloadReady } = await import("../src/sandbox/workload-wait.js");
const { readWaitingState, capacityCanCome, CAPACITY_WAIT_PHRASES } = await import("../src/sandbox/workload-stall.js");
const { SandboxProvisionTerminalError } = await import("../src/sandbox/errors.js");
const { SafeWorkloadProvider, capacityWaitTimeoutMs } = await import("../src/sandbox/safe-workload-provider.js");
const { SANDBOX_MIN_RUN_SECONDS } = await import("../src/config.js");

type Body = Record<string, unknown>;

// ── the platform's text ──────────────────────────────────────────────────────

/** The autoscaler's event on the 2026-11-17 sandbox, as it wrote it. */
const PER_USER_LIMIT = "NotTriggerScaleUp: pod didn't trigger scale-up: the pool's purchase of a node for the Pod's group "
  + "is held back: every account the pool submits as is at the scheduler's per-user limit; the Pod stays Pending "
  + "and is retried every cycle";
/** What the platform writes on the admitted workload: its prefix, then the newest scheduling event. */
const onWorkload = (event: string) => `In queue - waiting for scale-up - ${event}`;
const POOL = "7f3c9a52-1d4e-4b86-9c0a-5e2d8b1f6a43";
/** An admitted sandbox workload, as the platform reports it while no node has taken its pod. */
const admitted = (message: string, phase = "NotReady"): Body => ({ phase, queuePosition: 0, pods: null, message });
/** The scheduler's own account, which it repeats after the autoscaler's event. */
const FAILED_SCHEDULING = onWorkload("FailedScheduling: 0/7 nodes are available: 7 Insufficient amd.com/gpu.");
const running: Body = { phase: "Running" };
const repeat = (n: number, b: Body): Body[] => Array.from({ length: n }, () => b);

/** Reasons the autoscaler gives that end on their own, in its own words. */
const CAPACITY_REFUSALS = [
  PER_USER_LIMIT,
  "NotTriggerScaleUp: pod didn't trigger scale-up: the pool's purchase of a node for the Pod's group is held back: "
    + "a node the pool could land on is still being given back by an earlier job; the Pod stays Pending and is retried every cycle",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the pool's purchase of a node for the Pod's group is held back: "
    + "the pool is at its limit of running or submitted nodes; the Pod stays Pending and is retried every cycle",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the pool's purchase of a node for the Pod's group is held back: "
    + "the scheduler refused the pool's last submission and the pool waits before the next; the Pod stays Pending and is retried every cycle",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the pool bought no node for the Pod's group this cycle and recorded "
    + "no reason; the Pod stays Pending and is retried every cycle",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the pool's purchase of a node for the Pod's group is held back: "
    + "node purchases are paused; the Pod stays Pending and is retried every cycle",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the pool's purchase of a node for the Pod's group is held back: "
    + "none of the nodes the pool's job could land on can take a job of this pool yet; the Pod stays Pending and is retried every cycle",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the pool's purchase of a node for the Pod's group is held back: "
    + "the nodes the pool's job could land on could not be read yet; the Pod stays Pending and is retried every cycle",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the Pod's group needs a job of 4 nodes and the pool has room for 2 more; the Pod stays Pending",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the Pod's group needs a job of 4 nodes and the pool may have 1 more submitted; the Pod stays Pending",
  `NotTriggerScaleUp: pod didn't trigger scale-up: pool ${POOL}: NoHeadroom: the pods need 1 new node(s) and the pool's budget `
    + "allows 0 (max_running); the pool is full and 2 of its idle or coming node(s) cannot take the pod; the pod waits: an idle "
    + "one is given back after the pool's idle_release_after (30m0s), and then a node is bought for the pod",
  `NotTriggerScaleUp: pod didn't trigger scale-up: pool ${POOL}: NoHeadroom: the pods need 1 new node(s) and the pool's budget `
    + "allows 0 (max_running); the pod waits for a node of the pool to be given back, then one is bought for it",
  `NotTriggerScaleUp: pod didn't trigger scale-up: pool ${POOL} would buy 1 new node(s) for it, but generation `
    + `${POOL}/3's submit is not decided yet (SubmitUnknown), and nothing more is bought in the pool until a read of the scheduler decides it`,
  "NotTriggerScaleUp: pod didn't trigger scale-up: 2 max node group size reached",
  "NotTriggerScaleUp: pod didn't trigger scale-up: 1 in backoff after failed scale-up",
];

/** Reasons no wait settles: the pod has to fail fast, as before. */
const NEVER_REFUSALS = [
  'NotTriggerScaleUp: pod didn\'t trigger scale-up: no pool serves workspace "gpu-team"',
  `NotTriggerScaleUp: pod didn't trigger scale-up: pool ${POOL}: NotTriggerScaleUp: pod ns/sb-1 does not fit a new node `
    + "of this pool: Insufficient amd.com/gpu",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the Pod asks for more of a node than a node of the pool has: amd.com/gpu",
  "NotTriggerScaleUp: pod didn't trigger scale-up: the Pod's group has more members than the largest job a pool buys (8 nodes); the Pod stays Pending",
  `NotTriggerScaleUp: pod didn't trigger scale-up: pool ${POOL}: NodeLimit: the pods need 4 node(s) at once and the pool may hold at most 2 (site QoS node limit)`,
  `NotTriggerScaleUp: pod didn't trigger scale-up: pool ${POOL}: NoHeadroom: the pods need 1 new node(s) and the pool's budget `
    + "allows 0 (max_submitted); 2 of the pool's nodes cannot take the pod and no idle node is given back for it: the pool "
    + "keeps its nodes up to target_running (2) and gives back only past it",
  // Worded like a capacity wait ("retried every cycle"), but the reason is the pool's configuration.
  "NotTriggerScaleUp: pod didn't trigger scale-up: the pool's purchase of a node for the Pod's group is held back: no scheduler "
    + "partition admits the QoS and account the pool submits under; the Pod stays Pending and is retried every cycle",
  "NotTriggerScaleUp: pod didn't trigger scale-up: 3 node(s) didn't match Pod's node affinity/selector",
];

// ── reading the state ────────────────────────────────────────────────────────

test("the 2026-11-17 sandbox: an account at its per-user limit is a wait for capacity, not an unschedulable pod", () => {
  for (const phase of ["NotReady", "Pending"]) {
    const w = readWaitingState(admitted(onWorkload(PER_USER_LIMIT), phase));
    assert.equal(w?.kind, "queued", phase);
    assert.equal(w?.capacityWait, true, phase);
    assert.equal(w?.scalingUp, undefined, "not a node being added: none is, yet");
    // The user reads the autoscaler's reason, whole enough to say what holds it back.
    assert.match(w!.reason, /^no node is free for the sandbox yet, and the platform will provide one when capacity frees up/);
    assert.match(w!.reason, /every account the pool submits as is at the scheduler's per-user limit/);
    assert.equal(w!.detail, onWorkload(PER_USER_LIMIT));
  }
});

test("every reason that ends on its own is a wait for capacity", () => {
  for (const refusal of CAPACITY_REFUSALS) {
    assert.equal(capacityCanCome(refusal), true, refusal);
    const w = readWaitingState(admitted(onWorkload(refusal)));
    assert.equal(w?.kind, "queued", refusal);
    assert.equal(w?.capacityWait, true, refusal);
    assert.doesNotMatch(w!.reason, new RegExp(POOL), "no identifiers reach the user");
  }
  // Each phrase on the list is one some reason above is matched by, so none is dead.
  for (const re of CAPACITY_WAIT_PHRASES) {
    assert.ok(CAPACITY_REFUSALS.some((r) => re.test(r)), `no fixture exercises ${re}`);
  }
  // A pod held at a scheduling gate waits for the node its gate is lifted for.
  assert.equal(readWaitingState(admitted("SchedulingGated: pod waits for its group's node"))?.capacityWait, true);
});

test("a reason no wait settles is still an unschedulable pod", () => {
  for (const refusal of NEVER_REFUSALS) {
    assert.equal(capacityCanCome(refusal), false, refusal);
    const w = readWaitingState(admitted(onWorkload(refusal)));
    assert.equal(w?.kind, "unscheduled", refusal);
    assert.equal(w?.capacityWait, undefined, refusal);
  }
  // A capacity phrase only counts as the autoscaler's: the scheduler or anyone else saying it is not.
  assert.equal(capacityCanCome("0/7 nodes are available: 7 Insufficient amd.com/gpu; at the scheduler's per-user limit"), false);
});

test("a wait for capacity stays in force through the scheduler's account after it, until it is taken back", () => {
  const first = readWaitingState(admitted(onWorkload(PER_USER_LIMIT)))!;
  // The scheduler's own account, newest now: still the same wait, in the same words.
  const carried = readWaitingState(admitted(FAILED_SCHEDULING), false, first.reason);
  assert.deepEqual(carried, { kind: "queued", reason: first.reason, detail: FAILED_SCHEDULING, capacityWait: true });
  // Not seen before, the same account is a pod that is stuck.
  assert.equal(readWaitingState(admitted(FAILED_SCHEDULING))?.kind, "unscheduled");
  // A refusal no wait settles takes it back; so does the platform withdrawing its message, and a pod that is taken is not waiting.
  assert.equal(readWaitingState(admitted(onWorkload(NEVER_REFUSALS[1]!)), false, first.reason)?.kind, "unscheduled");
  assert.equal(readWaitingState(admitted(""), false, first.reason)?.kind, "unscheduled");
  assert.equal(readWaitingState({ phase: "NotReady", pods: [{ phase: "Running" }] }, false, first.reason), null);
});

// ── the wait ─────────────────────────────────────────────────────────────────

function scriptedFetch(bodies: Body[]) {
  let i = 0;
  return (async () => {
    const body = bodies[Math.min(i, bodies.length - 1)]!;
    i++;
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
}

function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      if (nowMs > 100_000_000) throw new Error("wait did not end within 100000s of fake time");
      nowMs += ms;
    },
  };
}

const HOUR = 3_600_000;

/** The wait as the sandbox a run opens configures it: the 5-minute limit, and a capacity ceiling. */
async function wait(bodies: Body[], capacityMs: number) {
  const clock = fakeClock();
  const progress: Array<{ kind?: string; reason?: string; at: number }> = [];
  try {
    await waitForWorkloadReady({
      workloadId: "wl-1", apiKey: "key", logPrefix: "test",
      isReady: (d) => String(d.phase ?? "").toLowerCase() === "running",
      unschedulableTimeoutMs: 300_000,
      scaleUpTimeoutMs: capacityMs,
      pendingTimeoutMs: capacityMs,
      onProgress: async (p) => { progress.push({ kind: p.waiting?.kind, reason: p.waiting?.reason, at: clock.now() }); },
      deps: {
        fetchImpl: scriptedFetch(bodies), sleepImpl: clock.sleep, nowImpl: clock.now, pollMs: 5000,
        unreadableTimeoutMs: 0, startTimeoutMs: 900_000, waitNoticeGapMs: 0,
      },
    });
    return { ended: null as string | null, message: "", at: clock.now(), progress };
  } catch (e) {
    assert.ok(e instanceof SandboxProvisionTerminalError, String(e));
    return { ended: e.reason, message: e.message, at: clock.now(), progress };
  }
}

test("a sandbox held back at the per-user limit waits past 5 minutes and past the start ceiling, until capacity comes", async () => {
  // Two hours of the autoscaler's refusal, then a node.
  const r = await wait([...repeat(1440, admitted(onWorkload(PER_USER_LIMIT))), running], 3 * HOUR);
  assert.equal(r.ended, null, r.message);
  assert.ok(r.at >= 2 * HOUR, "it waited the whole two hours");
  assert.ok(r.progress.some((p) => p.kind === "queued" && /per-user limit/.test(p.reason ?? "")), "and the user was told why");
});

test("the scheduler's account after the refusal does not turn the wait into an unschedulable one", async () => {
  const r = await wait([admitted(onWorkload(PER_USER_LIMIT)), ...repeat(720, admitted(FAILED_SCHEDULING)), running], 3 * HOUR);
  assert.equal(r.ended, null, r.message);
});

test("a wait for capacity ends at its ceiling, says so, and says why", async () => {
  const r = await wait(repeat(10_000, admitted(onWorkload(PER_USER_LIMIT))), 3 * HOUR);
  assert.equal(r.ended, "sandbox_pending_timeout");
  assert.ok(r.at > 3 * HOUR && r.at <= 3 * HOUR + 10_000, `ended at ${r.at}`);
  assert.match(r.message, /still waiting for capacity after/);
  assert.match(r.message, /per-user limit/);
  // The same in the Pending phase, on the ceiling the caller passed rather than the setting.
  const pending = await wait(repeat(10_000, admitted(onWorkload(PER_USER_LIMIT), "Pending")), HOUR);
  assert.equal(pending.ended, "sandbox_pending_timeout");
  assert.ok(pending.at > HOUR && pending.at <= HOUR + 10_000, `ended at ${pending.at}`);
  assert.match(pending.message, /per-user limit/);
});

test("a refusal no wait settles still ends at the 5-minute limit", async () => {
  for (const refusal of NEVER_REFUSALS) {
    const r = await wait(repeat(10_000, admitted(onWorkload(refusal))), 3 * HOUR);
    assert.equal(r.ended, "sandbox_unschedulable", refusal);
    assert.ok(r.at > 300_000 && r.at <= 310_000, `${refusal}: ended at ${r.at}`);
  }
});

test("a wait for capacity the autoscaler later says no wait settles is counted from that read", async () => {
  const r = await wait([...repeat(360, admitted(onWorkload(PER_USER_LIMIT))), ...repeat(10_000, admitted(onWorkload(NEVER_REFUSALS[0]!)))], 3 * HOUR);
  assert.equal(r.ended, "sandbox_unschedulable");
  assert.ok(r.at > 30 * 60_000 + 300_000 && r.at <= 30 * 60_000 + 315_000, `ended at ${r.at}`);
});

// ── the ceiling ──────────────────────────────────────────────────────────────

test("the capacity ceiling is the deployment's, bounded by what the request's timeout leaves the run", () => {
  const h = 3600;
  // The 2026-11-17 request: 25200s, on the defaults (3h ceiling, 1h kept for the run).
  assert.equal(capacityWaitTimeoutMs(25_200, 3 * HOUR, h), 3 * HOUR);
  // A deployment that waits forever is still bounded by the request.
  assert.equal(capacityWaitTimeoutMs(25_200, 0, h), (25_200 - h) * 1000);
  // A shorter request waits less; one shorter than twice the reserve keeps half for the run.
  assert.equal(capacityWaitTimeoutMs(10_800, 3 * HOUR, h), 2 * HOUR);
  assert.equal(capacityWaitTimeoutMs(1800, 3 * HOUR, h), 900_000);
  // No timeout, or a nonsense one, is the deployment's ceiling as before.
  assert.equal(capacityWaitTimeoutMs(undefined, 3 * HOUR, h), 3 * HOUR);
  assert.equal(capacityWaitTimeoutMs(0, 3 * HOUR, h), 3 * HOUR);
  assert.equal(capacityWaitTimeoutMs(Number.NaN, 0, h), 0);
  // Never the 5-minute unschedulable limit, and never nothing: a request of 1s waits 1s.
  assert.equal(capacityWaitTimeoutMs(1, 3 * HOUR, h), 1000);
  assert.equal(capacityWaitTimeoutMs(25_200, 3 * HOUR, 0), 3 * HOUR);
});

test("the run's reserve reads in seconds and defaults to an hour", async () => {
  const prior = process.env.SANDBOX_MIN_RUN_SECONDS;
  try {
    delete process.env.SANDBOX_MIN_RUN_SECONDS;
    const m = await import("../src/config.js?min-run=unset");
    assert.equal(m.SANDBOX_MIN_RUN_SECONDS, 3600);
  } finally {
    process.env.SANDBOX_MIN_RUN_SECONDS = prior;
  }
  assert.equal(SANDBOX_MIN_RUN_SECONDS, 2, "this file's own value, read at load");
});

// ── through create, in real time ─────────────────────────────────────────────

function safeServing(workload: (reads: number) => Body) {
  const calls: string[] = [];
  const created: Body[] = [];
  let reads = 0;
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/v1/workloads") {
      created.push(JSON.parse(String(init?.body ?? "{}")));
      return { ok: true, status: 200, json: async () => ({ workloadId: "wl-capacity" }) };
    }
    if (path.endsWith("/stop")) return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    reads++;
    return { ok: true, status: 200, json: async () => workload(reads), text: async () => "" };
  }) as unknown as typeof fetch;
  return { calls, created, fetchImpl, reads: () => reads };
}

test("create: a sandbox at the per-user limit outlasts the unschedulable limit and starts when capacity comes", { timeout: 30_000 }, async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  // Refused for about 2.5s of reads (the unschedulable limit is 1s here), then a node.
  const safe = safeServing((n) => (n <= 3 ? admitted(onWorkload(PER_USER_LIMIT)) : running));
  globalThis.fetch = safe.fetchImpl;
  const events: Array<Record<string, unknown>> = [];
  const started = Date.now();
  const inst = await new SafeWorkloadProvider().create({
    sessionId: "s1", namespace: "ns", image: "img:tag", resources: { cpu: "1" }, env: {}, platformKey: "key",
    timeoutSec: 25_200, onEvent: async (e) => { events.push(e); }, signal: AbortSignal.timeout(20_000),
  });
  assert.equal(inst.id, "wl-capacity");
  assert.ok(Date.now() - started >= 2000, "it waited past the 1s limit");
  assert.ok(!safe.calls.some((c) => c.endsWith("/stop")), `nothing was stopped: ${safe.calls.join(", ")}`);
  assert.ok(events.some((e) => e.waiting === "queued" && /per-user limit/.test(String(e.waitReason))), JSON.stringify(events));
  assert.equal(safe.created[0]!.timeout, 25_200 + 3600, "the workload's own timeout is unchanged");
});

test("create: the wait for capacity ends at what the request's timeout leaves the run", { timeout: 30_000 }, async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const safe = safeServing(() => admitted(onWorkload(PER_USER_LIMIT)));
  globalThis.fetch = safe.fetchImpl;
  const started = Date.now();
  // timeout 5s, 2s kept for the run: a 3s ceiling, against the 3h of the setting.
  const err = await new SafeWorkloadProvider().create({
    sessionId: "s1", namespace: "ns", image: "img:tag", resources: { cpu: "1" }, env: {}, platformKey: "key",
    timeoutSec: 5, signal: AbortSignal.timeout(20_000),
  }).then(() => null, (e: unknown) => e);
  const took = Date.now() - started;
  assert.ok(err instanceof SandboxProvisionTerminalError, String(err));
  assert.equal(err.reason, "sandbox_pending_timeout", err.message);
  assert.match(err.message, /still waiting for capacity after/);
  assert.ok(took >= 3000 && took < 10_000, `ended after ${took}ms`);
});
