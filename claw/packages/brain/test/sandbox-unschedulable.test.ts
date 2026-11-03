// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A sandbox that cannot start has to be told to the user early and ended early.
//
// Before this, an admitted workload whose pod no node would take read as an
// ordinary slow start: the user saw "Waiting in queue (position 0)" once and then
// nothing for the whole of the start ceiling (15 minutes), and the model, handed a
// bare "did not become ready", opened another sandbox and waited it out again.
//
// Driven through the wait loop's seams with a scripted SaFE (the workload detail
// the platform returns, one body per read) and a clock the test moves itself, so
// each rule about elapsed time is a statement about the clock, not a wait. One
// test goes through `create` in real time because it is the only way to see the
// workload being stopped.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.SAFE_API_URL = "http://safe.test";
// Read when the config module loads; the create-path test below waits it out in real time.
process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS = "1";
const { waitForWorkloadReady } = await import("../src/sandbox/workload-wait.js");
const { readWaitingState, cleanPlatformText, describeWaiting, summarizeScheduling } = await import("../src/sandbox/workload-stall.js");
const {
  SandboxProvisionTerminalError, SANDBOX_UNAVAILABLE_REASONS, sandboxUnavailableOf,
} = await import("../src/sandbox/errors.js");
const { __test__, SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");

type Body = Record<string, unknown>;

// ── the platform's account of a workload, in the states under test ───────────

/** In SaFE's own queue: not admitted, the scheduler says why. */
const queued = (position: number, message = "In queue - insufficient resources, no cpu available"): Body =>
  ({ phase: "Pending", queuePosition: position, message });
/** Admitted (position 0, message cleared) with a pod that nothing has taken, and nothing said about why. */
const untaken = (message = ""): Body =>
  ({ phase: "Pending", queuePosition: 0, message, pods: [{ podId: "sb-1-abc", phase: "Pending" }] });
/** Admitted, the pod untaken, and the platform saying a node is being added for it. */
const scalingUp = (detail = "TriggeredScaleUp: pod triggered scale-up: [{pool-a 1->2 (max: 5)}]"): Body =>
  untaken(`In queue - waiting for scale-up - ${detail}`);
/** The scheduler's account of a pod it cannot place, n nodes and none of them usable. */
const sched = (n: number) => `0/${n} nodes are available: ${n} node(s) were unschedulable.`;

// The incident of 2026-11-03: sandbox nodes cordoned, the sandbox's pod pending. This is
// the platform's message on the sandbox workload in the shape it has on the live cluster
// (the scheduler's account, then the autoscaler's event after it), with the identifiers
// replaced by placeholders of the same shape. The workload is admitted -- no queue
// position -- and has no pods listed; the platform reports the phase as NotReady (and as
// Pending on others), and writes "waiting for scale-up" on it whether or not any scale-up
// was triggered. None of this is progress: no node took the pod and none was added.
const POOL = "7f3c9a52-1d4e-4b86-9c0a-5e2d8b1f6a43";
const SCHEDULER_ACCOUNT =
  "0/7 nodes are available: 3 node(s) had untolerated taint(s), 4 node(s) were unschedulable. "
  + "no new claims to deallocate, preemption: not eligible due to preemptionPolicy=Never.";
const INCIDENT_MESSAGE = `In queue - waiting for scale-up - ${SCHEDULER_ACCOUNT} - `
  + `NotTriggerScaleUp: pod didn't trigger scale-up: pool ${POOL}: NotTriggerScaleUp: `
  + "pod claw-sandboxes/claw-1785291793209-sandbox-x7k2p does not fit a new node of this pool: "
  + "TaintToleration: node(s) had untolerated taint {sandbox-nodes/profile: user}";
/** The scheduler's account when the pod is one of a group, as it is on the live cluster for multi-node workloads: longer. */
const POD_GROUP = ", PodGroup claw-sandboxes/claw-1785291793209-sandbox gets rejected due to "
  + "Pod claw-1785291793209-sandbox-x7k2p is unschedulable even after PostFilter";
/** A pod the autoscaler does add a node for: the event after the (long) account is the one thing that differs. */
const SCALING_UP_MESSAGE = `In queue - waiting for scale-up - ${SCHEDULER_ACCOUNT}${POD_GROUP} - `
  + `TriggeredScaleUp: pod triggered scale-up: [{pool ${POOL} 1->2 (max: 5)}]`;
const NOT_SCALING_MESSAGE = `In queue - waiting for scale-up - ${SCHEDULER_ACCOUNT}${POD_GROUP} - `
  + `NotTriggerScaleUp: pod didn't trigger scale-up: pool ${POOL}: NoHeadroom: the pods need 1 new node(s)`;
const INCIDENT_SUMMARY =
  "no node can take the sandbox right now (7 nodes: 4 unschedulable, 3 restricted to other workloads), and no new node is being added";
/** Everything the platform's text carries that the user is not shown. */
const IDENTIFIERS = new RegExp([POOL, "claw-sandboxes", "claw-1785291793209", "x7k2p", "sandbox-nodes/profile"].join("|"));
const incident = (phase = "NotReady", message = INCIDENT_MESSAGE): Body =>
  ({ phase, queuePosition: null, pods: null, message });
/** The same pod once a node's kubelet has acknowledged it: pulling its image. */
const taken: Body = {
  phase: "Pending", queuePosition: 0,
  pods: [{
    podId: "sb-1-abc", phase: "Pending", adminNodeName: "node-1", hostIP: "10.0.0.5",
    startTime: "2026-11-03T04:00:00",
  }],
};
/** The same, in the phase a sandbox object reports while it is not ready. */
const takenNotReady: Body = { ...taken, phase: "NotReady" };
/**
 * What the platform writes on the workload once the scheduler has failed the pod again after
 * the autoscaler's one event: its own account, then the newest event, which is now its own.
 * The platform appends only the newest of TriggeredScaleUp / NotTriggerScaleUp / FailedScheduling.
 */
const failedScheduling = (phase = "NotReady"): Body =>
  incident(phase, `In queue - waiting for scale-up - ${SCHEDULER_ACCOUNT} - FailedScheduling: ${SCHEDULER_ACCOUNT}`);
/** What the autoscaler's one scale-up event looks like on the workload, as the incident's messages do. */
const scaleUpEvent = (phase = "NotReady"): Body => incident(phase, SCALING_UP_MESSAGE);
/** The first read after a create: a workload the platform has not synced yet. */
const unsynced: Body = { phase: "Pending", queuePosition: 0, pods: null };
const running: Body = { phase: "Running" };
const repeat = (n: number, b: Body): Body[] => Array.from({ length: n }, () => b);

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
      // A wait that ignores every rule it is tested for would spin here forever.
      if (nowMs > 100_000_000) throw new Error("wait did not end within 100000s of fake time");
      nowMs += ms;
    },
    get value() { return nowMs; },
  };
}

const isRunning = (d: Body) => String(d.phase ?? "").toLowerCase() === "running";

type Progress = { phase: string; queuePosition: number; waiting?: { kind: string; reason: string }; at: number };

/** Runs the shared loop to its end and reports everything it told the caller. */
async function run(bodies: Body[], o: {
  workloadId?: string;
  unschedulableTimeoutMs?: number;
  pendingTimeoutMs?: number;
  startTimeoutMs?: number;
  waitNoticeGapMs?: number;
}) {
  const clock = fakeClock();
  const progress: Progress[] = [];
  const terminal: Array<{ phase: string; status: string; reason: string; message?: string }> = [];
  const gaveUp: Array<{ reason: string; phase: string }> = [];
  let ended: string | null = null;
  try {
    await waitForWorkloadReady({
      workloadId: o.workloadId ?? "wl-1", apiKey: "key", logPrefix: "test", isReady: isRunning,
      unschedulableTimeoutMs: o.unschedulableTimeoutMs,
      onProgress: async (p) => { progress.push({ ...p, at: clock.now() } as Progress); },
      onTerminal: async (t) => { terminal.push(t); },
      onGiveUp: async (g) => { gaveUp.push(g); },
      deps: {
        fetchImpl: scriptedFetch(bodies), sleepImpl: clock.sleep, nowImpl: clock.now, pollMs: 5000,
        unreadableTimeoutMs: 0, pendingTimeoutMs: o.pendingTimeoutMs ?? 0, startTimeoutMs: o.startTimeoutMs ?? 0,
        ...(o.waitNoticeGapMs === undefined ? {} : { waitNoticeGapMs: o.waitNoticeGapMs }),
      },
    });
  } catch (e) {
    assert.ok(e instanceof SandboxProvisionTerminalError, `unexpected error: ${String(e)}`);
    ended = e.reason;
  }
  return { ended, progress, terminal, gaveUp, clock };
}

// ── reading the state ────────────────────────────────────────────────────────

test("queued: the scheduler's own reason is the reason", () => {
  assert.deepEqual(readWaitingState(queued(3)), {
    kind: "queued",
    reason: "In queue - insufficient resources, no cpu available",
    detail: "In queue - insufficient resources, no cpu available",
  });
});

test("admitted with the pod untaken and nothing said about why is unscheduled, whichever phase", () => {
  for (const phase of ["Pending", "NotReady"]) {
    const w = readWaitingState({ phase, queuePosition: 0, pods: [{ podId: "p1", phase: "Pending" }] });
    assert.equal(w?.kind, "unscheduled", phase);
    // What the user reads names no pod; the log's sentence does.
    assert.equal(w!.reason, "the sandbox's pod has not been placed on any node");
    assert.equal(w!.detail, "the pod p1 is Pending and has not been placed on any node");
  }
  // No pod yet at all reads the same, in different words.
  assert.match(readWaitingState({ phase: "Pending" })!.reason, /no node has taken its pod/);
});

test("an admitted workload with a node being added is a platform wait, not an unscheduled one", () => {
  // The autoscaler's own event reason, whole, wherever in the message it is.
  for (const message of [
    "In queue - waiting for scale-up - TriggeredScaleUp: pod triggered scale-up",
    SCALING_UP_MESSAGE,
  ]) {
    const w = readWaitingState(untaken(message));
    assert.deepEqual(w, { kind: "queued", reason: "the platform is adding a node for the sandbox", detail: message, scalingUp: true });
  }
});

test("the platform's account of why an admitted pod is stuck is not a node being added", () => {
  // The incident, in both phases the platform reports it in, with the fields as the platform sends them.
  for (const phase of ["NotReady", "Pending"]) {
    const w = readWaitingState(incident(phase));
    assert.equal(w?.kind, "unscheduled", phase);
    assert.equal(w!.reason, INCIDENT_SUMMARY);
    assert.equal(w!.detail, INCIDENT_MESSAGE, "the whole text is kept, for the log");
  }
  // The scheduler's account alone, and the scheduler's event: stuck, not scaling.
  assert.equal(readWaitingState(untaken(`In queue - waiting for scale-up - ${SCHEDULER_ACCOUNT}`))?.kind, "unscheduled");
  assert.equal(readWaitingState(untaken(`In queue - waiting for scale-up - FailedScheduling: ${sched(7)}`))?.kind, "unscheduled");
  // "waiting for scale-up" is on every message the platform writes for an unplaced pod;
  // it is not the autoscaler saying it scaled.
  assert.equal(readWaitingState(untaken("In queue - waiting for scale-up"))?.kind, "unscheduled");
  // Neither is the autoscaler saying it did not, however it is worded.
  assert.equal(readWaitingState(untaken("NotTriggeredScaleUp: pod did not trigger"))?.kind, "unscheduled");
});

test("what tells a node being added from none is read from the whole message, not its first 300 characters", () => {
  assert.ok(SCALING_UP_MESSAGE.indexOf("TriggeredScaleUp") > 300, "the event is after the scheduler's account");
  assert.equal(readWaitingState(incident("NotReady", SCALING_UP_MESSAGE))?.kind, "queued");
  assert.equal(readWaitingState(incident("NotReady", NOT_SCALING_MESSAGE))?.kind, "unscheduled");
  // And a message far past any bound still says what its tail says.
  const long = `In queue - ${"x".repeat(20_000)} - TriggeredScaleUp: pod triggered scale-up`;
  assert.equal(readWaitingState(untaken(long))?.kind, "queued");
});

test("a scale-up that was seen stays in force while the scheduler's account follows it, until it is withdrawn", () => {
  const failed = failedScheduling();
  const adding = "the platform is adding a node for the sandbox";
  // Not seen before: the scheduler's account alone is a pod that is stuck.
  assert.equal(readWaitingState(failed)?.kind, "unscheduled");
  assert.equal(readWaitingState(failed, false)?.kind, "unscheduled");
  // Seen on the read before: still a node being added, in the same words, with the text kept for the log.
  assert.deepEqual(readWaitingState(failed, true), {
    kind: "queued", reason: adding, detail: String(failed.message), scalingUp: true,
  });
  assert.equal(readWaitingState(untaken(`In queue - waiting for scale-up - ${SCHEDULER_ACCOUNT}`), true)?.reason, adding);
  // The autoscaler saying it will not add a node is the newest event, and is what withdraws it.
  assert.equal(readWaitingState(incident("NotReady", NOT_SCALING_MESSAGE), true)?.kind, "unscheduled");
  assert.equal(readWaitingState(incident("NotReady", INCIDENT_MESSAGE), true)?.kind, "unscheduled");
  // So does the platform taking its message back, and a pod that is taken or a queue is not a node being added.
  assert.equal(readWaitingState(untaken(""), true)?.kind, "unscheduled");
  assert.equal(readWaitingState(taken, true), null);
  assert.equal(readWaitingState(queued(2), true)?.scalingUp, undefined);
  assert.equal(readWaitingState({ phase: "Running" }, true), null);
});

test("a wait the platform said nothing about is marked, and one it gave a reason for is not", () => {
  const bound = { phase: "Pending", queuePosition: 0, pods: [{ podId: "p", phase: "Pending", adminNodeName: "n1" }] };
  for (const d of [unsynced, { ...unsynced, pods: [] }, { phase: "Pending" }, untaken(), bound]) {
    assert.equal(readWaitingState(d)?.kind, "unscheduled", JSON.stringify(d));
    assert.equal(readWaitingState(d)?.silent, true, JSON.stringify(d));
  }
  for (const d of [untaken(sched(7)), incident(), failedScheduling(), queued(2), scalingUp()]) {
    assert.equal(readWaitingState(d)?.silent, undefined, JSON.stringify(d));
  }
});

test("the user is told in our words what the platform's text says, without its identifiers", () => {
  assert.equal(summarizeScheduling(INCIDENT_MESSAGE), INCIDENT_SUMMARY);
  assert.equal(summarizeScheduling(SCALING_UP_MESSAGE), "the platform is adding a node for the sandbox");
  assert.equal(
    summarizeScheduling("0/8 nodes are available: 1 Insufficient ephemeral-storage, 3 node(s) had untolerated taint(s), 4 node(s) were unschedulable. no new claims to deallocate"),
    "no node can take the sandbox right now (8 nodes: 4 unschedulable, 3 restricted to other workloads, 1 short of ephemeral-storage)",
  );
  assert.equal(
    summarizeScheduling("0/3 nodes are available: 3 Insufficient amd.com/gpu."),
    "no node can take the sandbox right now (3 nodes: 3 short of amd.com/gpu)",
  );
  assert.equal(
    summarizeScheduling("NotTriggerScaleUp: pod didn't trigger scale-up: pool abc: NoHeadroom: the pods need 1 new node(s)"),
    "no node can take the sandbox right now, and no new node is being added",
  );
  assert.equal(summarizeScheduling("something the platform wrote that we do not know"), null);
  // Whatever a message carries, none of it is repeated to the user.
  const messages = [
    INCIDENT_MESSAGE, SCALING_UP_MESSAGE, NOT_SCALING_MESSAGE,
    `0/7 nodes are available: 7 node(s) had untolerated taint {sandbox-nodes/profile: ${POOL}}.`,
  ];
  for (const message of messages) {
    for (const phase of ["NotReady", "Pending"]) {
      const w = readWaitingState(incident(phase, message))!;
      assert.doesNotMatch(w.reason, IDENTIFIERS, message);
      assert.ok(!w.reason.includes("\n") && w.reason.length < 200, w.reason);
    }
  }
  // Text it cannot summarise on an admitted workload is not passed through either.
  const unknown = readWaitingState(untaken(`something new about ${POOL}`))!;
  assert.equal(unknown.kind, "unscheduled");
  assert.equal(unknown.reason, "the platform has not been able to place the sandbox on a node yet");
  assert.ok(unknown.detail.includes(POOL));
});

test("a pod that has only been bound to a node is still untaken, and the log says which node", () => {
  // The pod that will not start: the scheduler named a node and the node never answered.
  const w = readWaitingState({ phase: "Pending", pods: [{ podId: "p", phase: "Pending", adminNodeName: "node-9" }] });
  assert.equal(w?.kind, "unscheduled");
  assert.equal(w!.reason, "the sandbox's pod was assigned to a node that has not started it");
  assert.equal(w!.detail, "the pod p was assigned to node node-9, which has not started it");
});

test("any sign a node took the pod means it is starting, not waiting", () => {
  const signs: Array<Record<string, unknown>> = [
    { hostIP: "10.0.0.5" }, { podIP: "10.1.1.1" }, { startTime: "2026-11-03T04:00:00" },
    { containers: [{ name: "main" }] }, { phase: "Running" },
  ];
  for (const sign of signs) {
    const w = readWaitingState({ phase: "Pending", pods: [{ podId: "p", phase: "Pending", ...sign }] });
    assert.equal(w, null, JSON.stringify(sign));
    // A message on the workload does not make a taken pod a stuck one.
    assert.equal(readWaitingState({ phase: "NotReady", message: INCIDENT_MESSAGE, pods: [{ podId: "p", phase: "Pending", ...sign }] }), null);
  }
  assert.equal(readWaitingState(taken), null);
});

test("phases it does not know to be waiting are not read as waiting", () => {
  for (const phase of ["Running", "Failed", "Stopped", "Updating", ""]) {
    assert.equal(readWaitingState({ phase, queuePosition: 0 }), null, phase);
    assert.equal(readWaitingState({ phase, queuePosition: 0, message: INCIDENT_MESSAGE }), null, phase);
  }
});

test("platform text reaches the user as one bounded line", () => {
  assert.equal(cleanPlatformText("a\n\tb\u0000c   d"), "a b c d");
  const long = cleanPlatformText("x".repeat(1000));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith("…"));
  // And the pod and node names in the log's sentence get the same treatment.
  const named = readWaitingState({ phase: "Pending", pods: [{ podId: `p\n${"z".repeat(500)}`, phase: "Pending" }] });
  assert.ok(!named!.detail.includes("\n") && named!.detail.length < 200, named!.detail);
  assert.doesNotMatch(named!.reason, /z/);
});

test("the queue's own phrases are repeated as written, and anything else it says is not", () => {
  for (const message of [
    "In queue - insufficient resources, no cpu available",
    "In queue - waiting for earlier or higher priority workloads",
    "In queue - waiting for scheduled start time",
  ]) {
    assert.deepEqual(readWaitingState(queued(2, message)), { kind: "queued", reason: message, detail: message });
  }
  const generic = "the platform has not admitted the sandbox yet";
  for (const message of [
    "",
    `In queue - capacity reservation ${POOL} was rejected`,
    "In queue - waiting for capacity service: claw-sandboxes/claw-1785291793209-sandbox-x7k2p not found",
    `In queue - ${"y".repeat(500)}`,
    "In queue - waiting\nfor {sandbox-nodes/profile}",
    "queued behind everything else",
  ]) {
    const w = readWaitingState(queued(2, message))!;
    assert.equal(w.kind, "queued", message);
    assert.equal(w.reason, generic, message);
    assert.equal(w.detail, cleanPlatformText(message, Infinity), "the log keeps what the platform said");
  }
});

test("the progress sentence names the reason for each kind", () => {
  assert.equal(
    describeWaiting({ kind: "queued", reason: "In queue - insufficient resources" }, 4),
    "Waiting in queue (position 4): In queue - insufficient resources",
  );
  // Admitted, so no position to give: said as what it is.
  assert.equal(
    describeWaiting({ kind: "queued", reason: "the platform is adding a node for the sandbox" }, 0),
    "Sandbox is waiting on the platform: the platform is adding a node for the sandbox",
  );
  assert.equal(
    describeWaiting({ kind: "unscheduled", reason: INCIDENT_SUMMARY }, 0),
    `Sandbox is waiting for the platform to schedule it: ${INCIDENT_SUMMARY}`,
  );
});

// ── the wait loop ────────────────────────────────────────────────────────────

test("an admitted workload no node takes ends as sandbox_unschedulable at the limit", { timeout: 5000 }, async () => {
  const r = await run([untaken()], { unschedulableTimeoutMs: 180_000 });
  assert.equal(r.ended, "sandbox_unschedulable");
  // The first read (5s) starts the clock; the first read more than 180s later ends it.
  assert.equal(r.clock.value, 190_000);
  assert.deepEqual(r.gaveUp, [{ reason: "sandbox_unschedulable", phase: "pending" }]);
  assert.equal(r.terminal.length, 1);
  assert.equal(r.terminal[0]!.reason, "sandbox_unschedulable");
  assert.equal(r.terminal[0]!.status, "failed");
  assert.match(r.terminal[0]!.message!, /could not be scheduled: the sandbox's pod has not been placed on any node/);
});

test("the error says what was observed, and for how long", { timeout: 5000 }, async () => {
  const r = await run([untaken()], { unschedulableTimeoutMs: 60_000 });
  assert.equal(r.ended, "sandbox_unschedulable");
  const message = r.terminal[0]!.message!;
  assert.match(message, /could not be scheduled: the sandbox's pod has not been placed on any node/);
  assert.doesNotMatch(message, /sb-1-abc/);
  assert.match(message, /admitted by the platform, but no node took its pod for 6\ds; phase=pending/);
});

test("the user is told when the wait begins, once, and with the reason, when the platform gives one", { timeout: 5000 }, async () => {
  const r = await run([untaken(sched(7))], { unschedulableTimeoutMs: 180_000 });
  // Dozens of reads happen before it gives up; the same reason is not repeated.
  assert.equal(r.progress.length, 1);
  assert.equal(r.progress[0]!.at, 5_000);
  assert.deepEqual(r.progress[0]!.waiting, {
    kind: "unscheduled", reason: "no node can take the sandbox right now (7 nodes: 7 unschedulable)",
  });
});

test("a wait the platform said nothing about is announced once it has lasted, and is ended on the same clock", { timeout: 5000 }, async () => {
  // A pod listed and untaken, no message; no pods at all; and the workload not synced yet: all read the same.
  for (const body of [untaken(), unsynced, { ...unsynced, pods: [] }]) {
    const r = await run([body], { unschedulableTimeoutMs: 180_000 });
    assert.equal(r.ended, "sandbox_unschedulable", JSON.stringify(body));
    // Held back for the notice gap (30s from the first read), then said once, with the reason.
    assert.deepEqual(r.progress.map((p) => [p.at, p.waiting?.kind]), [[5_000, undefined], [35_000, "unscheduled"]]);
    // The hold is only for what the user is told: the limit is counted from the first read, as before.
    assert.equal(r.clock.value, 190_000);
  }
  // The gap is the notice gap, and 0 means no hold.
  const none = await run([unsynced], { unschedulableTimeoutMs: 180_000, waitNoticeGapMs: 0 });
  assert.deepEqual(none.progress.map((p) => [p.at, p.waiting?.kind]), [[5_000, "unscheduled"]]);
  const longer = await run([unsynced], { unschedulableTimeoutMs: 180_000, waitNoticeGapMs: 60_000 });
  assert.deepEqual(longer.progress.map((p) => [p.at, p.waiting?.kind]), [[5_000, undefined], [65_000, "unscheduled"]]);
});

test("a sandbox the platform has not synced yet, then starts, is never announced as waiting", { timeout: 5000 }, async () => {
  // The first read after a create: Pending, no queue position, no pods, no message. A few seconds later a node has the pod.
  for (const first of [unsynced, { ...unsynced, pods: [] }]) {
    const r = await run([first, first, taken, taken, running], { unschedulableTimeoutMs: 180_000 });
    assert.equal(r.ended, null);
    assert.ok(r.progress.length >= 1);
    assert.ok(r.progress.every((p) => !p.waiting), JSON.stringify(r.progress));
  }
  // Slower: the platform is still catching up 25s in, still under the gap.
  const slow = await run([...repeat(5, unsynced), ...repeat(2, taken), running], { unschedulableTimeoutMs: 180_000 });
  assert.equal(slow.ended, null);
  assert.ok(slow.progress.every((p) => !p.waiting), JSON.stringify(slow.progress));
});

test("only an unbroken silence is held: the gap starts over after anything else is seen", { timeout: 5000 }, async () => {
  // 20s unsynced, a pod taken, 20s unsynced again: 40s in all and never 30s in a row.
  const r = await run([...repeat(4, unsynced), taken, ...repeat(4, unsynced), running], { unschedulableTimeoutMs: 180_000 });
  assert.equal(r.ended, null);
  assert.ok(r.progress.every((p) => !p.waiting), JSON.stringify(r.progress));
});

test("a node scale-up the platform reports is never cut short, however long it takes", { timeout: 5000 }, async () => {
  // Admitted, the pod unschedulable until a node arrives, the platform saying so
  // the whole time: two hours here, against a limit of three minutes.
  const r = await run([...repeat(1440, scalingUp()), running], { unschedulableTimeoutMs: 180_000 });
  assert.equal(r.ended, null);
  assert.ok(r.clock.value > 7_000_000);
  assert.deepEqual(r.progress[0]!.waiting, {
    kind: "queued", reason: "the platform is adding a node for the sandbox",
  });
});

test("a scale-up that is triggered after the scheduler's long account is not cut short either", { timeout: 5000 }, async () => {
  // The event is past the 300th character of what the platform sent.
  for (const phase of ["NotReady", "Pending"]) {
    const r = await run([...repeat(1440, incident(phase, SCALING_UP_MESSAGE)), running], { unschedulableTimeoutMs: 300_000 });
    assert.equal(r.ended, null, phase);
    assert.ok(r.clock.value > 7_000_000);
  }
});

test("the incident: admitted, no pods, the platform saying why and that it will not scale -- ends at the short limit", { timeout: 5000 }, async () => {
  // The real ceilings, so that what ends it is the short limit and not one of them:
  // NotReady would otherwise wait 15 minutes, Pending 3 hours.
  for (const phase of ["NotReady", "Pending"]) {
    const r = await run([incident(phase)], {
      unschedulableTimeoutMs: 300_000, startTimeoutMs: 900_000, pendingTimeoutMs: 10_800_000,
    });
    assert.equal(r.ended, "sandbox_unschedulable", phase);
    // The first read (5s) starts the clock; the first read more than 300s later ends it.
    assert.equal(r.clock.value, 310_000, phase);
    assert.deepEqual(r.gaveUp, [{ reason: "sandbox_unschedulable", phase: phase.toLowerCase() }]);
    const message = r.terminal[0]!.message!;
    assert.ok(message.includes(`could not be scheduled: ${INCIDENT_SUMMARY}`), message);
    assert.doesNotMatch(message, IDENTIFIERS);
    // The user was told at the start, once, in our words.
    assert.equal(r.progress.length, 1);
    assert.equal(r.progress[0]!.waiting?.kind, "unscheduled");
    assert.equal(r.progress[0]!.waiting?.reason, INCIDENT_SUMMARY);
  }
});

test("without the short limit the incident waits out the ceiling of its phase, which is what the limit is for", { timeout: 5000 }, async () => {
  const notReady = await run([incident("NotReady")], { startTimeoutMs: 900_000, pendingTimeoutMs: 10_800_000 });
  assert.equal(notReady.ended, "sandbox_start_timeout");
  assert.equal(notReady.clock.value, 905_000 + 5_000);
  const pending = await run([incident("Pending")], { startTimeoutMs: 900_000, pendingTimeoutMs: 10_800_000 });
  assert.equal(pending.ended, "sandbox_pending_timeout");
  assert.equal(pending.clock.value, 10_800_000 + 10_000);
});

test("a message the stall has not had before is the platform doing something: the clock starts over", { timeout: 5000 }, async () => {
  // 200s on each of three accounts: 600s in all, and never 300s on one.
  const moving = [...repeat(40, untaken(sched(7))), ...repeat(40, untaken(sched(8))), ...repeat(40, untaken(sched(9))), running];
  assert.equal((await run(moving, { unschedulableTimeoutMs: 300_000 })).ended, null);
  // The same 600s on one account is a stall, so the change is what saved it.
  const still = await run([...repeat(120, untaken(sched(7))), running], { unschedulableTimeoutMs: 300_000 });
  assert.equal(still.ended, "sandbox_unschedulable");
  assert.equal(still.clock.value, 310_000);
});

test("a message that goes back and forth between the same two does not keep a stall alive", { timeout: 5000 }, async () => {
  const flapping: Body[] = [];
  for (let k = 0; k < 2000; k++) flapping.push(untaken(sched(k % 2 ? 7 : 8)));
  const r = await run(flapping, { unschedulableTimeoutMs: 300_000 });
  // Both accounts are new by the second read (10s); nothing after that restarts the clock.
  assert.equal(r.ended, "sandbox_unschedulable");
  assert.equal(r.clock.value, 315_000);
});

test("a message that is new on every read does not keep a stall alive for ever either", { timeout: 5000 }, async () => {
  const counting: Body[] = [];
  for (let k = 1; k <= 2000; k++) counting.push(untaken(sched(k)));
  const r = await run(counting, { unschedulableTimeoutMs: 300_000 });
  assert.equal(r.ended, "sandbox_unschedulable");
  assert.ok(r.clock.value <= 400_000, String(r.clock.value));
});

test("when the platform stops saying a node is being added, the stall is counted from then", { timeout: 5000 }, async () => {
  // 600s of a node being added, then the autoscaler gives up: the clock starts at the first read of that.
  const r = await run([...repeat(120, incident("NotReady", SCALING_UP_MESSAGE)), incident("NotReady")], {
    unschedulableTimeoutMs: 300_000, startTimeoutMs: 3_600_000,
  });
  assert.equal(r.ended, "sandbox_unschedulable");
  assert.equal(r.clock.value, 605_000 + 305_000);
});

test("once the platform withdraws its reason, the wait is unscheduled and the clock starts then", { timeout: 5000 }, async () => {
  // 300s of scale-up, then nothing said and the pod still untaken: the limit
  // counts from the first read with no reason (305s), not from admission.
  const r = await run([...repeat(60, scalingUp()), untaken()], { unschedulableTimeoutMs: 180_000 });
  assert.equal(r.ended, "sandbox_unschedulable");
  assert.equal(r.clock.value, 490_000);
});

test("a scale-up followed by the scheduler's account is still a node being added, however long the node takes", { timeout: 5000 }, async () => {
  // The autoscaler says TriggeredScaleUp once; the scheduler then keeps saying FailedScheduling
  // while the node is provisioned for 40 minutes. Neither phase's ceiling nor the short limit is
  // what ends it: the node arrives and the sandbox runs.
  for (const phase of ["NotReady", "Pending"]) {
    const r = await run([...repeat(2, scaleUpEvent(phase)), ...repeat(480, failedScheduling(phase)), takenNotReady, running], {
      unschedulableTimeoutMs: 300_000, startTimeoutMs: 3_600_000, pendingTimeoutMs: 10_800_000,
    });
    assert.equal(r.ended, null, phase);
    assert.ok(r.clock.value > 2_400_000, phase);
    // Only ever told that a node is being added (the first notice, then the ten-minute tick): the
    // scheduler's account does not turn it into a stuck pod.
    assert.ok(r.progress.length >= 2, phase);
    for (const p of r.progress) {
      assert.deepEqual(p.waiting, { kind: "queued", reason: "the platform is adding a node for the sandbox" }, phase);
    }
  }
});

test("a scale-up that was seen is out of the short limit's clock, and the ceilings of the phase still apply", { timeout: 5000 }, async () => {
  const notReady = await run([scaleUpEvent(), failedScheduling()], {
    unschedulableTimeoutMs: 300_000, startTimeoutMs: 900_000, pendingTimeoutMs: 10_800_000,
  });
  assert.equal(notReady.ended, "sandbox_start_timeout");
  assert.equal(notReady.clock.value, 905_000 + 5_000);
  const pending = await run([scaleUpEvent("Pending"), failedScheduling("Pending")], {
    unschedulableTimeoutMs: 300_000, startTimeoutMs: 900_000, pendingTimeoutMs: 10_800_000,
  });
  assert.equal(pending.ended, "sandbox_pending_timeout");
  assert.equal(pending.clock.value, 10_800_000 + 10_000);
});

test("the same scheduler's account with no scale-up ever seen is the incident, and ends at the short limit", { timeout: 5000 }, async () => {
  for (const phase of ["NotReady", "Pending"]) {
    const r = await run([failedScheduling(phase)], {
      unschedulableTimeoutMs: 300_000, startTimeoutMs: 900_000, pendingTimeoutMs: 10_800_000,
    });
    assert.equal(r.ended, "sandbox_unschedulable", phase);
    assert.equal(r.clock.value, 310_000, phase);
  }
});

test("a scale-up the autoscaler then says it will not do is counted from that read", { timeout: 5000 }, async () => {
  // 2 reads of TriggeredScaleUp, 100 of the scheduler's account, then NotTriggerScaleUp is the newest event
  // (the 103rd read, at 515s): the short limit counts from there, not from the first read and not from the scale-up.
  const r = await run([
    ...repeat(2, scaleUpEvent()), ...repeat(100, failedScheduling()), incident("NotReady", NOT_SCALING_MESSAGE),
  ], { unschedulableTimeoutMs: 300_000, startTimeoutMs: 3_600_000 });
  assert.equal(r.ended, "sandbox_unschedulable");
  assert.equal(r.clock.value, 515_000 + 305_000);
  assert.equal(r.progress.at(-1)!.waiting?.kind, "unscheduled");
  assert.equal(r.progress.at(-1)!.waiting?.reason, "no node can take the sandbox right now (7 nodes: 4 unschedulable, 3 restricted to other workloads), and no new node is being added");
});

test("a scale-up that was seen does not outlive the pod being taken", { timeout: 5000 }, async () => {
  // Scale-up, the scheduler's account, then a node takes the pod; later the pod is unplaced again and
  // no scale-up is on the message: that is a new stall, counted from its first read (read 14, at 70s).
  const r = await run([
    scaleUpEvent(), ...repeat(10, failedScheduling()), ...repeat(2, takenNotReady), failedScheduling(),
  ], { unschedulableTimeoutMs: 300_000, startTimeoutMs: 3_600_000 });
  assert.equal(r.ended, "sandbox_unschedulable");
  assert.equal(r.clock.value, 70_000 + 305_000);
});

test("a queued workload is told its reason at once, and a move up the queue is announced", { timeout: 5000 }, async () => {
  const bodies = [...repeat(60, queued(3)), ...repeat(60, queued(2)), ...repeat(60, queued(1)), running];
  const r = await run(bodies, { unschedulableTimeoutMs: 180_000 });
  assert.equal(r.ended, null);
  assert.deepEqual(
    r.progress.map((p) => [p.queuePosition, p.waiting?.kind, p.waiting?.reason]),
    [3, 2, 1].map((n) => [n, "queued", "In queue - insufficient resources, no cpu available"]),
  );
});

test("a reason that changes is announced again, paced rather than on every read", { timeout: 5000 }, async () => {
  const bodies = [...repeat(3, untaken(sched(7))), ...repeat(20, untaken(sched(8))), running];
  const r = await run(bodies, {});
  assert.deepEqual(r.progress.map((p) => p.waiting?.reason), [
    "no node can take the sandbox right now (7 nodes: 7 unschedulable)",
    "no node can take the sandbox right now (8 nodes: 8 unschedulable)",
  ]);
  // B first appears at 20s but A was announced at 5s: B waits out the 30s pace.
  assert.deepEqual(r.progress.map((p) => p.at), [5_000, 35_000]);
});

test("a reason that flaps cannot flood the stream", { timeout: 5000 }, async () => {
  // 500s of the platform alternating between two messages every read.
  const flapping: Body[] = [];
  for (let k = 0; k < 100; k++) flapping.push(untaken(k % 2 ? sched(7) : sched(8)));
  flapping.push(running);
  const r = await run(flapping, {});
  assert.ok(r.progress.length >= 10, `announced ${r.progress.length} times`);
  assert.ok(r.progress.length <= 17, `announced ${r.progress.length} times in 500s, against a 30s pace`);
});

test("a queue is never given the short limit, however long it takes", { timeout: 5000 }, async () => {
  // Two hours in the platform's queue behind others, then it runs.
  const r = await run([...repeat(1440, queued(1)), running], { unschedulableTimeoutMs: 180_000 });
  assert.equal(r.ended, null);
  assert.ok(r.clock.value > 7_000_000);
});

test("the clock starts at admission, not in the queue", { timeout: 5000 }, async () => {
  // 200s queued, then 150s admitted and untaken: neither alone, nor together, is a stall.
  const ok = await run([...repeat(40, queued(1)), ...repeat(30, untaken()), running], { unschedulableTimeoutMs: 180_000 });
  assert.equal(ok.ended, null);
  // Left untaken, it ends 180s after admission (first untaken read at 205s), not after 180s of waiting.
  const stalled = await run([...repeat(40, queued(1)), untaken()], { unschedulableTimeoutMs: 180_000 });
  assert.equal(stalled.ended, "sandbox_unschedulable");
  assert.equal(stalled.clock.value, 390_000);
});

test("only an unbroken absence of progress counts: a pod being taken clears the clock", { timeout: 5000 }, async () => {
  // 150s untaken, 100s taken, 150s untaken: 400s in all and never 180s in a row.
  const broken = [...repeat(30, untaken()), ...repeat(20, taken), ...repeat(30, untaken()), running];
  assert.equal((await run(broken, { unschedulableTimeoutMs: 180_000 })).ended, null);
  // The same without the break is a stall, so the break is what saved it.
  const unbroken = [...repeat(30, untaken()), ...repeat(30, untaken()), running];
  assert.equal((await run(unbroken, { unschedulableTimeoutMs: 180_000 })).ended, "sandbox_unschedulable");
});

test("a sandbox that is starting keeps the long limit, not the short one", { timeout: 5000 }, async () => {
  // A pod a node took and is still pulling for ten minutes: far past the short limit.
  for (const pulling of [taken, takenNotReady]) {
    const slow = await run([...repeat(120, pulling), running], { unschedulableTimeoutMs: 60_000, startTimeoutMs: 900_000 });
    assert.equal(slow.ended, null, String(pulling.phase));
    assert.ok(slow.clock.value >= 600_000);
  }
  // And one that never comes up still ends on its own ceiling, under its own name.
  const never = await run([takenNotReady], { unschedulableTimeoutMs: 60_000, startTimeoutMs: 600_000 });
  assert.equal(never.ended, "sandbox_start_timeout");
  assert.ok(!never.progress.some((p) => p.waiting), "a starting sandbox is not announced as waiting");
});

test("absent or zero, the short limit is off and an admitted workload waits as it always did", { timeout: 5000 }, async () => {
  for (const limit of [undefined, 0]) {
    const r = await run([...repeat(2000, untaken()), running], { unschedulableTimeoutMs: limit });
    assert.equal(r.ended, null, String(limit));
  }
});

test("the long ceilings still apply to what the short limit does not cover", { timeout: 5000 }, async () => {
  // Queued past the Pending ceiling still ends as sandbox_pending_timeout.
  const r = await run([queued(2)], { unschedulableTimeoutMs: 60_000, pendingTimeoutMs: 600_000 });
  assert.equal(r.ended, "sandbox_pending_timeout");
});

// ── what the log keeps ──────────────────────────────────────────────────────

/**
 * Every line the process logs while `fn` runs, and until `settled` says the ones
 * wanted have arrived: pino writes to fd 1 with fs.write / fs.writeSync, and
 * asynchronously, so a test that follows a noisy one waits behind its backlog.
 */
async function captureLogs<T>(fn: () => Promise<T>, settled: (logs: string) => boolean): Promise<{ out: T; logs: string }> {
  const logs: string[] = [];
  const realWriteSync = fs.writeSync;
  const realWrite = fs.write;
  fs.writeSync = ((fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1 || fd === 2) logs.push(String(data));
    return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
  }) as typeof fs.writeSync;
  fs.write = ((fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1 || fd === 2) logs.push(String(data));
    return (realWrite as (...a: unknown[]) => void)(fd, data, ...rest);
  }) as typeof fs.write;
  try {
    const out = await fn();
    for (let waited = 0; waited < 20_000 && !settled(logs.join("")); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { out, logs: logs.join("") };
  } finally {
    fs.writeSync = realWriteSync;
    fs.write = realWrite;
  }
}

test("the platform's own text, identifiers and all, is in the log and in nothing the user is sent", { timeout: 5000 }, async () => {
  const { out, logs } = await captureLogs(
    () => run([incident()], { workloadId: "wl-incident", unschedulableTimeoutMs: 300_000 }),
    (all) => all.includes("test.unschedulable") && all.includes('"wl-incident"'),
  );
  assert.equal(out.ended, "sandbox_unschedulable");
  // Lines of earlier tests can still be flushing; this one's are the ones for its own workload.
  const lines = logs.split("\n").filter((l) => l.includes("workload-wait") && l.includes('"wl-incident"'));
  assert.ok(lines.length >= 2, logs.slice(-2000));
  const waiting = lines.find((l) => l.includes("test.waiting"));
  assert.ok(waiting, `the wait is logged when it starts:\n${logs.slice(-2000)}`);
  const gaveUp = lines.find((l) => l.includes("test.unschedulable"));
  assert.ok(gaveUp, `the give-up is logged:\n${logs.slice(-2000)}`);
  for (const line of [waiting, gaveUp]) {
    assert.ok(line.includes(POOL) && line.includes("claw-1785291793209-sandbox-x7k2p"), `the platform's text, whole, is logged: ${line}`);
    assert.ok(line.includes(INCIDENT_SUMMARY), line);
  }
  assert.doesNotMatch(JSON.stringify([out.progress, out.terminal, out.gaveUp]), IDENTIFIERS);
});

// ── what the sandbox's consumers are sent ────────────────────────────────────

async function poll(bodies: Body[], unschedulableTimeoutMs?: number) {
  const events: Array<Record<string, unknown>> = [];
  const clock = fakeClock();
  let ended: string | null = null;
  try {
    await __test__.pollWorkloadUntilRunning("wl-1", "key", async (e) => { events.push(e); }, {
      fetchImpl: scriptedFetch(bodies), sleepImpl: clock.sleep, nowImpl: clock.now, pollMs: 5000,
      unreadableTimeoutMs: 0, pendingTimeoutMs: 0, startTimeoutMs: 0,
    }, "hands", { unschedulableTimeoutMs });
  } catch (e) {
    ended = (e as InstanceType<typeof SandboxProvisionTerminalError>).reason;
  }
  return { events, ended };
}

test("a queued sandbox's progress event says the position and the platform's reason", { timeout: 5000 }, async () => {
  const { events } = await poll([queued(3), running]);
  const progress = events.find((e) => e.status === "pending");
  assert.ok(progress, JSON.stringify(events));
  assert.equal(progress.type, "sandboxStatus");
  assert.equal(progress.event, "phase");
  assert.equal(progress.queuePosition, 3);
  assert.equal(progress.log, "Waiting in queue (position 3): In queue - insufficient resources, no cpu available");
  assert.equal(progress.waiting, "queued");
  assert.equal(progress.waitReason, "In queue - insufficient resources, no cpu available");
});

test("a queued sandbox's event carries none of the platform's identifiers either", { timeout: 5000 }, async () => {
  const { events } = await poll([queued(2, `In queue - capacity reservation ${POOL} rejected by claw-sandboxes/x7k2p`), running]);
  const progress = events.find((e) => e.status === "pending");
  assert.ok(progress, JSON.stringify(events));
  assert.equal(progress.log, "Waiting in queue (position 2): the platform has not admitted the sandbox yet");
  assert.equal(progress.waitReason, "the platform has not admitted the sandbox yet");
  assert.doesNotMatch(JSON.stringify(events), IDENTIFIERS);
});

test("an unschedulable sandbox says so when it starts waiting, then ends with the reason as an event", { timeout: 5000 }, async () => {
  const why = "the sandbox's pod has not been placed on any node";
  const { events, ended } = await poll([untaken()], 60_000);
  assert.equal(ended, "sandbox_unschedulable");
  // The platform said nothing, so the first event is the ordinary one and the reason follows once it has lasted.
  assert.equal(events.find((e) => e.status === "pending")?.log, "Waiting in queue (position 0)");
  const progress = events.find((e) => e.waiting);
  assert.equal(progress?.log, `Sandbox is waiting for the platform to schedule it: ${why}`);
  assert.equal(progress?.waiting, "unscheduled");
  assert.equal(progress?.waitReason, why);
  const failed = events.find((e) => e.status === "failed");
  assert.equal(failed?.reason, "sandbox_unschedulable");
  assert.ok(String(failed?.message).includes(why), JSON.stringify(failed));
  assert.doesNotMatch(JSON.stringify(events), /sb-1-abc/, "the pod's name is for the log");
});

test("the incident's events say it in one line and carry none of the platform's identifiers", { timeout: 5000 }, async () => {
  for (const phase of ["NotReady", "Pending"]) {
    const { events, ended } = await poll([incident(phase)], 300_000);
    assert.equal(ended, "sandbox_unschedulable", phase);
    const progress = events.find((e) => e.status === "pending");
    assert.equal(progress?.log, `Sandbox is waiting for the platform to schedule it: ${INCIDENT_SUMMARY}`);
    assert.equal(progress?.waiting, "unscheduled");
    assert.equal(progress?.waitReason, INCIDENT_SUMMARY);
    const failed = events.find((e) => e.status === "failed");
    assert.equal(failed?.reason, "sandbox_unschedulable");
    assert.ok(String(failed?.message).includes(INCIDENT_SUMMARY), JSON.stringify(failed));
    assert.doesNotMatch(JSON.stringify(events), IDENTIFIERS);
  }
});

test("a scale-up the platform reports is announced with its own reason", { timeout: 5000 }, async () => {
  const { events, ended } = await poll([scalingUp("TriggeredScaleUp: pod triggered scale-up"), running], 60_000);
  assert.equal(ended, null);
  const progress = events.find((e) => e.status === "pending");
  assert.equal(progress?.log, "Sandbox is waiting on the platform: the platform is adding a node for the sandbox");
  assert.equal(progress?.waiting, "queued");
  assert.equal(progress?.queuePosition, 0);
});

test("a sandbox that is simply starting is announced exactly as before", { timeout: 5000 }, async () => {
  // From a pod a node has taken, and from the first read after a create, before the platform has synced it.
  for (const first of [taken, unsynced]) {
    const { events } = await poll([first, first, taken, running]);
    const progress = events.find((e) => e.status === "pending");
    assert.equal(progress?.log, "Waiting in queue (position 0)");
    assert.ok(!("waiting" in progress!) && !("waitReason" in progress!));
    assert.ok(events.every((e) => !e.waiting), JSON.stringify(events));
  }
});

test("a node being added is announced once, and the scheduler's account after it does not change the line", { timeout: 5000 }, async () => {
  const { events, ended } = await poll([scaleUpEvent(), ...repeat(20, failedScheduling()), running], 60_000);
  assert.equal(ended, null);
  const lines = events.filter((e) => e.waiting).map((e) => e.log);
  assert.deepEqual(lines, ["Sandbox is waiting on the platform: the platform is adding a node for the sandbox"]);
});

// ── what the failure does to the workload, through create ────────────────────

test("create ends an unschedulable sandbox with the reason and stops the workload it made", { timeout: 40_000 }, async (t) => {
  const calls: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (String(url).endsWith("/api/v1/workloads")) {
      return { ok: true, status: 200, json: async () => ({ workloadId: "wl-created" }) };
    }
    return { ok: true, status: 200, json: async () => incident(), text: async () => "" };
  }) as unknown as typeof fetch;

  // SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS=1 (above) and the real 5s poll: the
  // first read starts the clock, the second trips it.
  const err = await new SafeWorkloadProvider().create({
    sessionId: "s1", namespace: "ns", image: "img:tag", resources: { cpu: "1" }, env: {}, platformKey: "key",
    onEvent: async (e) => { events.push(e); },
    // A backstop only: if the limit never fires this ends the wait (as a cancel)
    // so the test fails on the reason below rather than hanging the process.
    signal: AbortSignal.timeout(25_000),
  }).then(() => null, (e: unknown) => e);

  assert.ok(err instanceof SandboxProvisionTerminalError, String(err));
  assert.equal(err.reason, "sandbox_unschedulable");
  assert.ok(err.message.includes(INCIDENT_SUMMARY), err.message);
  assert.doesNotMatch(err.message, IDENTIFIERS);
  assert.doesNotMatch(JSON.stringify(events), IDENTIFIERS);
  assert.ok(calls.includes("POST /api/v1/workloads/wl-created/stop"), `the workload is stopped: ${calls.join(", ")}`);
  assert.ok(events.some((e) => e.waiting === "unscheduled"), "the user was told it was waiting");
  assert.ok(events.some((e) => e.status === "failed" && e.reason === "sandbox_unschedulable"));
});

test("the setting reads in seconds, defaults to five minutes, and 0 turns it off", async () => {
  const load = async (value: string | undefined) => {
    const prior = process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS;
    if (value === undefined) delete process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS;
    else process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS = value;
    try {
      const m = await import(`../src/config.js?unschedulable=${value ?? "unset"}`);
      return m.SANDBOX_UNSCHEDULABLE_TIMEOUT_MS as number;
    } finally {
      if (prior === undefined) delete process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS;
      else process.env.SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS = prior;
    }
  };
  assert.equal(await load(undefined), 300_000);
  assert.equal(await load("90"), 90_000);
  assert.equal(await load("0"), 0);
});

// ── what ends a run's attempts to open a sandbox ─────────────────────────────

test("the endings that mean the platform has no sandbox are a closed, named set", () => {
  assert.deepEqual(
    [...SANDBOX_UNAVAILABLE_REASONS].sort(),
    ["sandbox_pending_timeout", "sandbox_start_timeout", "sandbox_unschedulable"],
  );
  for (const reason of SANDBOX_UNAVAILABLE_REASONS) {
    assert.equal(sandboxUnavailableOf(new SandboxProvisionTerminalError(reason, "m"))?.reason, reason);
  }
  // Provisioning endings that do not say waiting is what failed are not in it.
  for (const reason of ["sandbox_gone", "sandbox_exited_before_ready", "sandbox_status_unreadable", "sandbox_wait_interrupted"]) {
    assert.equal(sandboxUnavailableOf(new SandboxProvisionTerminalError(reason, "m")), null, reason);
  }
  assert.equal(sandboxUnavailableOf(new Error("sandbox_unschedulable")), null);
  assert.equal(sandboxUnavailableOf(null), null);
});

test("an open wrapped for the agent loop is still recognised", async () => {
  const { SandboxAttachError } = await import("../src/agent/attach-error.js");
  const cause = new SandboxProvisionTerminalError("sandbox_unschedulable", "m");
  assert.equal(sandboxUnavailableOf(new SandboxAttachError(cause)), cause);
});
