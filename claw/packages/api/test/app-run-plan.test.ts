// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * planAppRun turns resolved resources into the sandbox spec and the workspaces
 * to check. Pure function: it takes no input document, so it cannot read one.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { APP_MANIFEST_SCHEMA, resolveAppResources, type AppManifestV1 } from "@claw/protocol";
import { planAppRun } from "../src/tasks/app-run.js";

const manifest = (container: AppManifestV1["container"]): AppManifestV1 => ({
  schema: APP_MANIFEST_SCHEMA, name: "generic-app", version: "1.0.0",
  container, state_dir: "/state/${run_id}", command: ["run"],
});
const plan = (m: AppManifestV1, raw: unknown) => {
  const r = resolveAppResources(m, raw);
  assert.ok("resources" in r, JSON.stringify(r));
  return planAppRun(m, r.resources);
};

test("the requested image, gpus, cpu and memory become the sandbox spec", () => {
  const p = plan(manifest({}), { image: "registry.example.invalid/app:1", gpus: 4, workspace: "w", cpu: 2, memory_gi: 8.5 });
  assert.deepEqual(p.sandboxSpec, {
    handle: "app", image: "registry.example.invalid/app:1", namespace: "w",
    resources: { "amd.com/gpu": "4", cpu: "2", memory: "8.5Gi" },
  });
  assert.equal(p.workspaceId, "w");
  assert.deepEqual(p.workspaceIds, ["w"]);
});

test("the request's image wins over the manifest's default; the default is used when none is requested", () => {
  const m = manifest({ image: "registry.example.invalid/default:1" });
  assert.equal(plan(m, { image: "req:2", gpus: 0, workspace: "w" }).sandboxSpec.image, "req:2");
  assert.equal(plan(m, { gpus: 0, workspace: "w" }).sandboxSpec.image, "registry.example.invalid/default:1");
});

test("container.resources are defaults; the GPU key comes from the request only; a request overrides its own key only", () => {
  const m = manifest({ image: "i", resources: { cpu: "32", memory: "128Gi", "ephemeral-storage": "500Gi" } });
  assert.deepEqual(plan(m, { gpus: 0, workspace: "w", cpu: 4 }).sandboxSpec.resources, { cpu: "4", memory: "128Gi", "ephemeral-storage": "500Gi" });
  assert.deepEqual(plan(m, { gpus: 8, workspace: "w" }).sandboxSpec.resources, { cpu: "32", memory: "128Gi", "amd.com/gpu": "8", "ephemeral-storage": "500Gi" });
});

test("whatever GPU key a manifest carries is dropped: the spec has one GPU key, from the request", () => {
  for (const key of ["gpu", "amd.com/gpu", "GPU", "nvidia.com/gpu"]) {
    const m = manifest({ image: "i", resources: { cpu: "2", [key]: "8" } });
    assert.deepEqual(plan(m, { gpus: 0, workspace: "w" }).sandboxSpec.resources, { cpu: "2" }, `${key} with gpus=0`);
    assert.deepEqual(plan(m, { gpus: 2, workspace: "w" }).sandboxSpec.resources, { cpu: "2", "amd.com/gpu": "2" }, `${key} with gpus=2`);
  }
});

test("the sandbox workspace is checked as well when it differs", () => {
  const p = plan(manifest({ image: "i" }), { gpus: 0, workspace: "w", sandbox_workspace: "s" });
  assert.deepEqual(p.workspaceIds, ["w", "s"]);
});
