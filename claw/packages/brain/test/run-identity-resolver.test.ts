// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Verifies total, proxy-free identity resolution and per-run uniqueness. */
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";
import { resolveRunIdentity, untheadedRunIdentity } from "../src/tasks/run-identity.js";

const SOURCES = new Set(["task_id", "message_id", "unknown"]);

function request(over: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return { session_id: "sess-1", prompt: "hi", ...over } as ExecuteRequest;
}

function leaseUrl(taskId: string): { url: string; token: string } {
  return { url: `http://api.test/v1/internal/tasks/${taskId}/lease`, token: "tok" };
}

test("T4.1 a chat turn with only a message id is assigned an identity of its own", () => {
  const resolution = resolveRunIdentity(request({ message_id: "m-1" }), "m-1");
  assert.equal(resolution.identity.source, "message_id");
  assert.equal(resolution.identity.key, "msg.m-1");
  assert.equal(resolution.leaseShapeMiss, false);
});

test("T4.3 every combination resolves to a tracked entry and one of three sources", async () => {
  // Totality is the property that removes the third outcome: a run whose waits
  // go uncounted because the resolver had nothing to say about it.
  const { beginRun, endRun, phaseOf, whileWaiting } = await import("../src/tasks/run-phase.js");
  const taskIds = [undefined, "", "t-1"];
  const messageIds = [undefined, "", "m-1"];
  for (const task_id of taskIds) {
    for (const message_id of messageIds) {
      const req = request({ ...(task_id === undefined ? {} : { task_id }), ...(message_id === undefined ? {} : { message_id }) });
      const { identity } = resolveRunIdentity(req, message_id ?? "");
      assert.ok(identity.key.length > 0, `empty key for ${task_id}/${message_id}`);
      assert.ok(SOURCES.has(identity.source), `unknown source for ${task_id}/${message_id}`);
      const expected = task_id ? "task_id" : message_id ? "message_id" : "unknown";
      assert.equal(identity.source, expected, `${task_id}/${message_id}`);
      beginRun(identity.key);
      await whileWaiting(identity.key, "background_command", "timed", async () => {});
      assert.equal(phaseOf(identity.key).waits, 1, `uncounted wait for ${task_id}/${message_id}`);
      endRun(identity.key);
    }
  }
});

test("T4.4 two degraded runs do not land on one entry", async () => {
  const first = resolveRunIdentity(request(), "").identity;
  const second = resolveRunIdentity(request(), "").identity;
  assert.notEqual(first.key, second.key);
  assert.match(first.key, /^unknown\./);
  assert.match(second.key, /^unknown\./);

  const { beginRun, endRun, phaseOf, whileWaiting } = await import("../src/tasks/run-phase.js");
  beginRun(first.key);
  beginRun(second.key);
  await whileWaiting(first.key, "background_command", "timed", async () => {});
  assert.equal(phaseOf(first.key).waits, 1);
  assert.equal(phaseOf(second.key).waits, 0, "beginRun on one must not reset the other");
  endRun(first.key);
  assert.equal(phaseOf(second.key).waits, 0);
  assert.equal(phaseOf(second.key).phase, "executing");
  endRun(second.key);
});

test("T4.5 two fat-chat turns sharing a millisecond resolve to their own rows", () => {
  // The chat producer sets message_id to a millisecond timestamp, so two turns
  // dispatched together carry the same one. Their row ids differ, and each
  // arrives inside the lease URL the dispatcher already sends.
  const shared = "1730000000000";
  const first = resolveRunIdentity(request({ message_id: shared, run_lease: leaseUrl("ktsk_a") }), shared);
  const second = resolveRunIdentity(request({ message_id: shared, run_lease: leaseUrl("ktsk_b") }), shared);

  assert.equal(first.identity.source, "task_id");
  assert.equal(second.identity.source, "task_id");
  assert.equal(first.identity.key, "ktsk_a");
  assert.equal(second.identity.key, "ktsk_b");
  assert.notEqual(first.identity.key, second.identity.key);
  assert.notEqual(first.identity.key, shared);
  assert.notEqual(second.identity.key, shared);
});

test("T4.5 the two same-millisecond turns are independent at the ledger", async () => {
  const shared = "1730000000001";
  const first = resolveRunIdentity(request({ message_id: shared, run_lease: leaseUrl("ktsk_x") }), shared).identity;
  const second = resolveRunIdentity(request({ message_id: shared, run_lease: leaseUrl("ktsk_y") }), shared).identity;
  const { beginRun, endRun, phaseOf, whileWaiting } = await import("../src/tasks/run-phase.js");

  beginRun(first.key);
  await whileWaiting(first.key, "background_command", "timed", async () => {});
  beginRun(second.key);
  assert.equal(phaseOf(first.key).waits, 1, "the second run must not re-zero the first");

  let release = () => {};
  const inFlight = whileWaiting(second.key, "background_command", "timed", () =>
    new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((r) => setTimeout(r, 5));
  endRun(first.key);
  assert.equal(phaseOf(second.key).phase, "waiting",
    "ending one run must leave the other's wait in flight");
  release();
  await inFlight;
  assert.equal(phaseOf(second.key).waits, 1);
  endRun(second.key);
});

test("T4.6 the message tier is stable across a redelivery, and distinct per message", () => {
  const req = request({ message_id: "m-7" });
  assert.equal(resolveRunIdentity(req, "m-7").identity.key, resolveRunIdentity(req, "m-7").identity.key);
  assert.notEqual(
    resolveRunIdentity(request({ message_id: "m-8" }), "m-8").identity.key,
    resolveRunIdentity(req, "m-7").identity.key,
  );
});

test("T4.6 an unrecognised lease URL is reported, not guessed at", () => {
  const req = request({
    message_id: "m-9",
    run_lease: { url: "http://api.test/v2/leases/renew?run=ktsk_c", token: "tok" },
  });
  const resolution = resolveRunIdentity(req, "m-9");

  assert.equal(resolution.leaseShapeMiss, true, "an upstream shape change must be loud");
  assert.equal(resolution.identity.source, "message_id", "the tier below takes it");
  assert.equal(resolution.identity.key, "msg.m-9");
  assert.ok(!resolution.identity.key.includes("ktsk_c"), "no key is derived from a URL that did not match");

  const ordinary = resolveRunIdentity(request({ message_id: "m-9" }), "m-9");
  assert.equal(ordinary.leaseShapeMiss, false,
    "an ordinary resolution must not look like an upstream regression");
});

test("T5.5 the task id wins, and no proxy leaks into the key", () => {
  const req = request({
    task_id: "fixture-task",
    message_id: "fixture-message",
    session_id: "fixture-session",
    dag_root_task_id: "fixture-dag-root",
    files_workspace_id: "fixture-workspace",
  });
  const { identity } = resolveRunIdentity(req, "fixture-message");

  assert.equal(identity.source, "task_id");
  assert.equal(identity.key, "fixture-task");
  assert.notEqual(identity.key, "fixture-message");
  assert.notEqual(identity.key, "fixture-session");
  assert.notEqual(identity.key, "fixture-dag-root");
  assert.notEqual(identity.key, "ws.fixture-workspace");
});

test("T5.6 with nothing to identify a run, a proxy is still not the answer", () => {
  for (const message_id of [undefined, ""]) {
    const req = request({
      ...(message_id === undefined ? {} : { message_id }),
      session_id: "fixture-session",
      dag_root_task_id: "fixture-dag-root",
      files_workspace_id: "fixture-workspace",
    });
    const { identity } = resolveRunIdentity(req, message_id ?? "");
    assert.equal(identity.source, "unknown");
    for (const proxy of ["fixture-session", "fixture-dag-root", "ws.fixture-workspace"]) {
      assert.notEqual(identity.key, proxy);
      assert.ok(!identity.key.includes(proxy), `${identity.key} contains the proxy ${proxy}`);
    }
  }
});

test("the sentinel for an unthreaded run is unknown, prefixed, and never aliases", () => {
  const first = untheadedRunIdentity();
  const second = untheadedRunIdentity();
  assert.equal(first.source, "unknown");
  assert.match(first.key, /^unknown\.unthreaded\./);
  assert.notEqual(first.key, second.key);
});
