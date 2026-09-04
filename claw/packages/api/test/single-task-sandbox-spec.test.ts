// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// single-task-sandbox-spec.test.ts
//
// A prompt-only task was stamped sandbox_spec: "none", which resolveSandboxAction
// maps to {kind:"none"} and ensureHands throws on -- while the agent was still
// handed the full tool schema. Every sandbox tool was advertised and the first
// call died, the run ended in two turns having called nothing, and
// sandbox_workload_id stayed NULL, which left the platform-facts backfill
// filtering out every row it was given.
//
// Nothing pinned the value, on either path. This is the producer.

import test from "node:test";
import assert from "node:assert/strict";

const calls: string[] = [];
let defaultRow: Record<string, unknown> | null = null;

const { singleTaskSandboxSpec } = await (async () => {
  const mod = await import("../src/infra/db.js");
  (mod.MarketplaceDb as any).resourceFirstByType = async (t: string) => {
    calls.push(t);
    return defaultRow;
  };
  return await import("../src/routes/tasks.js") as any;
})();

test("a plugin's own image wins, and the marketplace is not consulted", async () => {
  calls.length = 0;
  const spec = await singleTaskSandboxSpec({ image: "plugin:1", resource: { cpu: "2" } });
  assert.deepEqual(spec, { handle: "main", image: "plugin:1", resources: { cpu: "2" } });
  assert.deepEqual(calls, [], "no lookup when the plugin already names an image");
});

test("a prompt-only task gets the marketplace default, not \"none\"", async () => {
  // The whole defect in one assertion: this returned the string "none", and
  // "none" is the one value that makes every sandbox tool unusable.
  calls.length = 0;
  defaultRow = { image: "default:latest", resource: { cpu: "1" } };
  const spec = await singleTaskSandboxSpec(null);
  assert.deepEqual(spec, { handle: "main", image: "default:latest", resources: { cpu: "1" } });
  assert.deepEqual(calls, ["default"]);
});

test("\"none\" survives only when there is genuinely no image to use", async () => {
  defaultRow = null;
  assert.equal(await singleTaskSandboxSpec(null), "none");
  defaultRow = { image: "   " };
  assert.equal(await singleTaskSandboxSpec(null), "none", "a blank image is not an image");
});

test("a marketplace lookup that throws degrades to \"none\" rather than failing the request", async () => {
  const mod = await import("../src/infra/db.js");
  const prev = (mod.MarketplaceDb as any).resourceFirstByType;
  (mod.MarketplaceDb as any).resourceFirstByType = async () => { throw new Error("db down"); };
  assert.equal(await singleTaskSandboxSpec(null), "none");
  (mod.MarketplaceDb as any).resourceFirstByType = prev;
});
