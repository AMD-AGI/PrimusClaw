// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A manifest that declares no sandbox role is admitted without a grant.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { APP_MANIFEST_SCHEMA, type AppManifestV1, type SandboxGrantMaterial } from "@claw/protocol";
import { apiGrantHooks } from "../src/grants/app-grant.js";
import type { AppGrantRequest, AppGrantRun } from "../src/tasks/app-run.js";

const run: AppGrantRun = {
  grantId: "gr-01arz3ndektsv4rrffq69g5fav",
  taskId: "task-1",
  sessionId: "sess-1",
  userId: "user-1",
  pluginId: 1,
};

const request: AppGrantRequest = {
  resources: {
    image: "img:1",
    gpus: 1,
    workspace: "ws-1",
    sandboxWorkspace: "ws-1",
    grant: { max_sandboxes: 1, max_gpus: 1, gpu_hours: 1, max_runtime_sec: 3600 },
  },
  templates: [{ name: "runner" }],
  platformKey: "pk",
  userName: "user",
};

function manifest(roles: AppManifestV1["sandbox_roles"]): AppManifestV1 {
  const out: AppManifestV1 = {
    schema: APP_MANIFEST_SCHEMA, name: "generic-app", version: "1.0.0",
    container: {}, state_dir: "/state", command: ["run"],
  };
  if (roles) out.sandbox_roles = roles;
  return out;
}

function hooks() {
  const calls: SandboxGrantMaterial[] = [];
  const client = {
    async issue(material: SandboxGrantMaterial) {
      calls.push(material);
      return { keys: { measurement: "e2b_a" }, expiresAt: new Date("2026-10-28T00:00:00.000Z") };
    },
    async revoke() { return undefined; },
  };
  return { calls, hooks: apiGrantHooks(client as never) };
}

test("a manifest with no sandbox role skips issue", async () => {
  for (const roles of [undefined, {}, { measurement: [] }] as const) {
    const h = hooks();
    const issued = await h.hooks.issue(run, manifest(roles), request);
    assert.equal(issued, undefined);
    assert.deepEqual(h.calls, []);
  }
});

test("a declared sandbox role is issued", async () => {
  const h = hooks();
  const issued = await h.hooks.issue(run, manifest({ measurement: ["runner"] }), request);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]!.roles, { measurement: ["runner"] });
  assert.equal(issued?.keys?.measurement, "e2b_a");
  assert.deepEqual(issued?.limits, request.resources.grant);
});
