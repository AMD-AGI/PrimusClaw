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

test("an undecodable record fails the whole read, rather than shrinking it", async () => {
  const entries: Record<string, string> = { "hands.sess-1": READY, "hands.sess-2": "{corrupt" };
  const inventory = await collectSandboxInventory(deps({
    handsKeys: async () => Object.keys(entries),
    handsGet: async (key) => entries[key] ?? null,
  }));

  assert.equal(inventory.ok, false,
    "an incomplete inventory is not a small fleet, and a step that drains what "
      + "it can see then reports itself finished is what a still-ok answer buys");
  assert.equal(inventory.unreadable, 1, "and says how much is missing, so it can be repaired");
  assert.match(inventory.error!, /could not be read/);
});

test("a row that parses but names nothing to reach or delete fails it too", async () => {
  // The same hole wearing valid JSON: no endpoint to ping, and no name or
  // workload id to delete by, so it can be neither drained nor proved drained.
  for (const broken of [
    { status: "ready", sandboxName: "s", namespace: "n" },
    { status: "ready", handsUrl: "http://sb/mcp", sandboxName: "", workloadId: "" },
    { status: "ready", handsUrl: "   ", sandboxName: "s" },
  ]) {
    const entries = { "hands.sess-1": READY, "hands.sess-2": JSON.stringify(broken) };
    const inventory = await collectSandboxInventory(deps({
      handsKeys: async () => Object.keys(entries),
      handsGet: async (key) => entries[key as keyof typeof entries] ?? null,
    }));
    assert.equal(inventory.ok, false, JSON.stringify(broken));
    assert.equal(inventory.unreadable, 1, JSON.stringify(broken));
  }
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
  assert.equal(inventory.count, 2,
    "the count is the whole returned set, or a consumer sizing the fleet by it "
      + "misses every DAG sandbox");
  assert.ok(!inventory.sessions.some((r) => r.sandbox_name === "sandbox-dag"),
    "which is exactly why enumerating session keys alone is not a census");
});

test("a DAG row that names nothing to reach or delete fails the read too", async () => {
  // The session half fails closed on a corrupt or empty record; a DAG row is
  // the same sandbox reached a different way, and a row with no endpoint is one
  // this census can neither drain nor prove drained.
  for (const broken of [
    {} as HandleInfo,
    { workload_id: "", hands_url: "http://sb/mcp" } as HandleInfo,
    { workload_id: "", sandbox_name: "sb", namespace: "n" } as HandleInfo,
  ]) {
    const inventory = await collectSandboxInventory(deps({
      dagHandles: async () => [["dag-1", { primary: broken }]],
    }));
    assert.equal(inventory.ok, false, JSON.stringify(broken));
    assert.equal(inventory.unreadable, 1, JSON.stringify(broken));
    assert.deepEqual(inventory.dag_handles, [], JSON.stringify(broken));
  }
});

test("a DAG value that is not a handle map at all counts as unreadable", async () => {
  // Turned into an empty map, a whole DAG's worth of sandboxes disappears from
  // the census and it still reports clean.
  for (const corrupt of [null, "a string", 42, ["not", "a", "map"]]) {
    const inventory = await collectSandboxInventory(deps({
      dagHandles: async () => [["dag-1", corrupt as never]],
    }));
    assert.equal(inventory.ok, false, JSON.stringify(corrupt));
    assert.equal(inventory.unreadable, 1, JSON.stringify(corrupt));
  }
});

test("a row that names only half of what a rollback deletes by fails the read", async () => {
  // A kubernetes Sandbox is addressed by name and namespace together; a row
  // carrying one without the other names nothing kubectl can reach, so it is a
  // sandbox this census can neither drain nor prove drained.
  const halves = [
    { status: "ready", provider: "agent-sandbox", handsUrl: "http://sb/mcp", sandboxName: "sb-1" },
    { status: "ready", provider: "agent-sandbox", handsUrl: "http://sb/mcp", namespace: "ns-a" },
  ];
  for (const broken of halves) {
    const entries = { "hands.sess-1": READY, "hands.sess-2": JSON.stringify(broken) };
    const inventory = await collectSandboxInventory(deps({
      handsKeys: async () => Object.keys(entries),
      handsGet: async (key) => entries[key as keyof typeof entries] ?? null,
    }));
    assert.equal(inventory.ok, false, JSON.stringify(broken));
    assert.equal(inventory.unreadable, 1, JSON.stringify(broken));
  }

  // The DAG half is held to the same rule.
  const inventory = await collectSandboxInventory(deps({
    dagHandles: async () => [["dag-1", {
      primary: { workload_id: "", hands_url: "http://sb/mcp", provider: "agent-sandbox", sandbox_name: "sb-dag" },
    }]],
  }));
  assert.equal(inventory.ok, false, "no namespace, so nothing to delete it by");
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
