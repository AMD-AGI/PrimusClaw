// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain rebuilds a grant from the same image and workspaces admission stored.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { APP_MANIFEST_SCHEMA, type AppManifestV1, type SandboxGrantMaterial } from "@claw/protocol";
import { brainGrantHooks } from "../src/apps/app-grant.js";
import type { AppGrantRun } from "../src/apps/app-runner.js";

const manifest: AppManifestV1 = {
  schema: APP_MANIFEST_SCHEMA, name: "generic-app", version: "1.0.0",
  container: {},
  state_dir: "/state", command: ["run"],
  sandbox_templates: [{ name: "runner", per_gpu_count: [1] }],
  sandbox_roles: { measurement: ["runner"] },
};

const run: AppGrantRun = {
  runId: "run-1", sessionId: "sess-1", grantId: "gr-01arz3ndektsv4rrffq69g5fav", manifest,
  userId: "user-1", platformKey: "pk", workspaceId: "ws-app",
  limits: { max_sandboxes: 2, max_gpus: 4, gpu_hours: 1, max_runtime_sec: 3600 },
  expiresAt: "2026-10-28T00:00:00.000Z",
  sandboxSpec: { handle: "app", image: "from-request:1", sandbox_workspace: "ws-sbx" } as AppGrantRun["sandboxSpec"],
};

test("reissue and extend use the resolved image and both workspaces", async () => {
  const seen: SandboxGrantMaterial[] = [];
  const modes: string[] = [];
  const client = {
    async issue(material: SandboxGrantMaterial, _signal: AbortSignal, mode: string) {
      seen.push(material);
      modes.push(mode);
      return { keys: { measurement: "e2b_a" }, expiresAt: new Date("2026-10-28T00:00:00.000Z") };
    },
    async extend(material: SandboxGrantMaterial) {
      seen.push(material);
      return { expiresAt: "2026-10-29T00:00:00.000Z" };
    },
    async revoke() { return undefined; },
    async inspect() { return "missing" as const; },
  };
  const hooks = brainGrantHooks(client as never);
  await hooks.reissue!(run);
  await hooks.extend(run, "2026-10-29T00:00:00.000Z");
  assert.deepEqual(modes, ["reissue"]);
  for (const material of seen) {
    assert.equal(material.templates[0]!.image, "from-request:1");
    assert.equal(material.templates[0]!.workspace, "ws-sbx");
    assert.deepEqual(material.workspaces, ["ws-app", "ws-sbx"]);
  }
});
