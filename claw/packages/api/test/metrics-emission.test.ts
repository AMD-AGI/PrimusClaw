// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// metrics-emission.test.ts
//
// Deltas over the rendered exposition, for the emissions whose whole decision
// lives in infra/metrics.ts: which exits read the queue-sojourn marker, what a
// row-count increment does, and that two calls move a series by exactly two.
//
// The suite's other half -- proving each counter moves from its real call site
// over the existing port seams -- arrives with the emission sites themselves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { metrics, registry } from "../src/infra/metrics.js";

/** The value of one sample, matched by family name and the labels that identify it. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(`${name}{`)) continue;
    const head = line.slice(0, line.lastIndexOf(" "));
    if (!head.startsWith(`${name}{`)) continue;
    if (!wanted.every((pair) => head.includes(pair))) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return 0;
}

/** What one action moved, as a reader of `/metrics` would see it. */
/**
 * How far below a nominal lower bound a measured sum may legitimately land.
 *
 * `delta` reads an accumulating histogram sum before and after, so what it
 * returns is a difference of two floats, not the observations themselves. Three
 * observations of exactly 10, 20 and 30 seconds subtract to 59.99999999999999
 * whenever the accumulator's earlier value has the wrong fractional part -- a
 * property of what ran before, and so of wall-clock timing, which is why it
 * shows up on a loaded machine and not on an idle one. The bound is about
 * telling one sojourn from three, and a hundredth of a second does not blur it.
 */
const SUM_EPSILON = 0.01;

async function delta(
  act: () => void,
  probes: ReadonlyArray<{ name: string; labels?: Record<string, string> }>,
): Promise<number[]> {
  const before = await registry.metrics();
  act();
  const after = await registry.metrics();
  return probes.map((p) =>
    sample(after, p.name, p.labels) - sample(before, p.name, p.labels));
}

const WAIT = "claw_api_run_queue_wait_seconds";
const EXITED = "claw_api_run_queue_exited_total";

test("a claimed exit with a marker books the exit and one observed wait", async () => {
  const marker = new Date(Date.now() - 45_000).toISOString();
  const [exits, count, sum] = await delta(
    () => metrics.observeQueueExit("chat", marker, "claimed"),
    [
      { name: EXITED, labels: { outcome: "claimed" } },
      { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "claimed" } },
      { name: `${WAIT}_sum`, labels: { origin: "chat", outcome: "claimed" } },
    ],
  );
  assert.equal(exits, 1);
  assert.equal(count, 1);
  assert.ok(
    sum >= 45 - SUM_EPSILON && sum < 50,
    `expected roughly 45s of wait, got ${sum}`,
  );
});

test("a claimed exit without a marker still books the exit and observes nothing", async () => {
  const [exits, count] = await delta(
    () => metrics.observeQueueExit("chat", null, "claimed"),
    [
      { name: EXITED, labels: { outcome: "claimed" } },
      { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "claimed" } },
    ],
  );
  assert.equal(exits, 1);
  assert.equal(count, 0);
});

test("an unparseable marker is not a zero-length wait", async () => {
  const [exits, count] = await delta(
    () => metrics.observeQueueExit("chat", "not-a-timestamp", "timed_out"),
    [
      { name: EXITED, labels: { outcome: "timed_out" } },
      { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "timed_out" } },
    ],
  );
  assert.equal(exits, 1);
  assert.equal(count, 0);
});

test("the five exits that cannot measure a wait count only", async () => {
  const marker = new Date(Date.now() - 60_000).toISOString();
  for (const outcome of [
    "budget_exhausted", "duplicate_closed", "dispatch_failed", "chat_closed", "cancelled",
  ] as const) {
    const [exits, count] = await delta(
      () => metrics.observeQueueExit("chat", marker, outcome),
      [
        { name: EXITED, labels: { outcome } },
        { name: `${WAIT}_count`, labels: { origin: "chat", outcome } },
      ],
    );
    assert.equal(exits, 1, `${outcome} should book one exit`);
    assert.equal(count, 0, `${outcome} cannot read the marker and must observe nothing`);
  }
});

test("a marker re-stamped between sojourns is measured per sojourn, not cumulatively", async () => {
  const [count, sum] = await delta(
    () => {
      for (const seconds of [10, 20, 30]) {
        metrics.observeQueueExit(
          "chat", new Date(Date.now() - seconds * 1000).toISOString(), "claimed",
        );
      }
    },
    [
      { name: `${WAIT}_count`, labels: { origin: "chat", outcome: "claimed" } },
      { name: `${WAIT}_sum`, labels: { origin: "chat", outcome: "claimed" } },
    ],
  );
  assert.equal(count, 3);
  // A cumulative marker would put 10 + 30 + 60 here; three sojourns put 60.
  assert.ok(
    sum >= 60 - SUM_EPSILON && sum < 65,
    `expected the three waits to sum to about 60s, got ${sum}`,
  );
});

test("a marker ahead of this pod's clock reads as no wait rather than a negative one", async () => {
  const [count, sum] = await delta(
    () => metrics.observeQueueExit(
      "task", new Date(Date.now() + 30_000).toISOString(), "claimed",
    ),
    [
      { name: `${WAIT}_count`, labels: { origin: "task", outcome: "claimed" } },
      { name: `${WAIT}_sum`, labels: { origin: "task", outcome: "claimed" } },
    ],
  );
  assert.equal(count, 1);
  assert.equal(sum, 0);
});

test("row-count increments move by the row count, not by one", async () => {
  const [requeued, entered] = await delta(
    () => {
      metrics.onDoorbellLeaseRequeued(7);
      metrics.onQueueEntered("requeue", 7);
    },
    [
      { name: "claw_api_doorbell_lease_requeued_total" },
      { name: "claw_api_run_queue_entered_total", labels: { cause: "requeue" } },
    ],
  );
  assert.equal(requeued, 7);
  assert.equal(entered, 7);
});

test("a zero-row sweep increments nothing", async () => {
  const [requeued, entered, exits] = await delta(
    () => {
      metrics.onDoorbellLeaseRequeued(0);
      metrics.onQueueEntered("requeue", 0);
      metrics.onQueueExited("duplicate_closed", 0);
    },
    [
      { name: "claw_api_doorbell_lease_requeued_total" },
      { name: "claw_api_run_queue_entered_total", labels: { cause: "requeue" } },
      { name: EXITED, labels: { outcome: "duplicate_closed" } },
    ],
  );
  assert.deepEqual([requeued, entered, exits], [0, 0, 0]);
});

test("calling a helper twice moves its series by exactly two", async () => {
  const [decisions, timeouts] = await delta(
    () => {
      metrics.onAdmissionDecision("chat", "admit");
      metrics.onAdmissionDecision("chat", "admit");
      metrics.onQueueTimeout("false");
      metrics.onQueueTimeout("false");
    },
    [
      { name: "claw_api_admission_decision_total", labels: { origin: "chat", decision: "admit" } },
      { name: "claw_api_run_queue_timeout_total", labels: { ever_held: "false" } },
    ],
  );
  assert.equal(decisions, 2);
  assert.equal(timeouts, 2);
});

test("the two ever_held values are separate series", async () => {
  const [held, notHeld] = await delta(
    () => metrics.onQueueTimeout("true"),
    [
      { name: "claw_api_run_queue_timeout_total", labels: { ever_held: "true" } },
      { name: "claw_api_run_queue_timeout_total", labels: { ever_held: "false" } },
    ],
  );
  assert.equal(held, 1);
  assert.equal(notHeld, 0);
});
