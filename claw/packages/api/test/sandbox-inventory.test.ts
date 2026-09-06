// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * NF1 and NF2 -- the census has to be a census.
 *
 * Every rollout gate and every rollback step iterates this answer, and both
 * failures it had read as a smaller fleet rather than as a failed read, which
 * is the direction that costs something: a step that drains everything it can
 * see then reports itself finished.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { collectSandboxInventory, type InventoryDeps } from "../src/routes/sandbox-inventory.js";
import type { HandleInfo } from "@claw/protocol";

const READY = JSON.stringify({
  status: "ready", workloadId: "wl-1", handsUrl: "http://sb-1:9100/mcp",
  sandboxName: "sandbox-1", namespace: "ns-a", provider: "agent-sandbox",
  platformKey: "pk", createdAt: "2026-01-01T00:00:00.000Z",
});

function deps(over: Partial<InventoryDeps> = {}): InventoryDeps {
  const entries: Record<string, string> = { "hands.sess-1": READY };
  return {
    handsKeys: async () => Object.keys(entries),
    handsGet: async (key) => entries[key] ?? null,
    dagHandles: async () => [],
    probeHealth: async () => true,
    sessionIdFromKey: (key) => key.slice("hands.".length),
    ...over,
  };
}

test("a session row names the resource a rollback deletes by", async () => {
  const inventory = await collectSandboxInventory(deps());
  assert.deepEqual(inventory.sessions[0].sandbox_name, "sandbox-1");
  assert.equal(inventory.sessions[0].namespace, "ns-a");
  assert.equal(inventory.sessions[0].provider, "agent-sandbox",
    "the workload id is empty on this path, so the provider is what classifies a row");
});

test("an undecodable record is counted, never dropped from a still-ok answer", async () => {
  const entries: Record<string, string> = { "hands.sess-1": READY, "hands.sess-2": "{corrupt" };
  const inventory = await collectSandboxInventory(deps({
    handsKeys: async () => Object.keys(entries),
    handsGet: async (key) => entries[key] ?? null,
  }));

  assert.equal(inventory.unreadable, 1,
    "dropped silently, this row is a live sandbox every consumer reads as absent");
  assert.equal(inventory.count, 1);
  assert.notEqual(inventory.unreadable, 0,
    "which is what a census caller refuses on: an incomplete inventory is not a small fleet");
});

test("live DAG sandboxes are the other half of the fleet", async () => {
  // Every node of a DAG shares one session id, and the session key holds
  // whichever sandbox last wrote it, so a live DAG sandbox is absent from the
  // session listing or present only as a stale sibling.
  const handle: HandleInfo = {
    workload_id: "", hands_url: "http://sb-dag:9100/mcp", provider: "agent-sandbox",
    sandbox_name: "sandbox-dag", namespace: "ns-b",
  };
  const inventory = await collectSandboxInventory(deps({
    dagHandles: async () => [["dag-root-1", { primary: handle }]],
  }));

  assert.deepEqual(inventory.dag_handles, [{
    dag_root_task_id: "dag-root-1", handle: "primary",
    sandbox_name: "sandbox-dag", namespace: "ns-b",
    hands_url: "http://sb-dag:9100/mcp", workload_id: "", provider: "agent-sandbox",
  }]);
  assert.ok(!inventory.sessions.some((r) => r.sandbox_name === "sandbox-dag"),
    "which is exactly why enumerating session keys alone is not a census");
});

test("a handle source that cannot be read fails the whole answer", async () => {
  // Never a sessions-only inventory: a build whose census cannot see a DAG
  // sandbox at all must not look like a deployment that has none.
  await assert.rejects(
    () => collectSandboxInventory(deps({
      dagHandles: async () => { throw new Error("bucket not bound"); },
    })),
    /bucket not bound/,
  );
});

test("a genuinely empty fleet is a successful read, not a failure", async () => {
  const inventory = await collectSandboxInventory(deps({
    handsKeys: async () => [], handsGet: async () => null,
  }));
  assert.equal(inventory.ok, true);
  assert.equal(inventory.count, 0);
  assert.equal(inventory.unreadable, 0);
  assert.deepEqual(inventory.dag_handles, [],
    "nothing to drain is not nothing readable, and a rollback has to run here");
});
