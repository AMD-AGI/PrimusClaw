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

function hooks(answered: Record<string, string[]> | null = { measurement: ["r1-runner"] }) {
  const calls: SandboxGrantMaterial[] = [];
  const client = {
    async issue(material: SandboxGrantMaterial) {
      calls.push(material);
      return { keys: { measurement: "e2b_a" }, expiresAt: new Date("2026-10-28T00:00:00.000Z"), templates: answered ?? undefined };
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
  assert.deepEqual(issued?.templates, { measurement: { "0": "r1-runner" } }, "the names the service returned, by role and card count");
});

test("per_gpu_count templates map each card count to the name the service returned", async () => {
  const h = hooks({ measurement: ["r1-runner-g1", "r1-runner-g8"] });
  const issued = await h.hooks.issue(run, manifest({ measurement: ["runner"] }), { ...request, templates: [{ name: "runner", per_gpu_count: [1, 8] }] });
  assert.deepEqual(issued?.templates, { measurement: { "1": "r1-runner-g1", "8": "r1-runner-g8" } });
});

test("a response whose names do not line up with the manifest fails the issue", async () => {
  for (const answered of [null, { measurement: ["r1-other"] }, { measurement: ["r1-runner", "r1-runner-g4"] }]) {
    const h = hooks(answered);
    await assert.rejects(
      () => h.hooks.issue(run, manifest({ measurement: ["runner"] }), request),
      (err: unknown) => err instanceof Error && /sandbox templates/.test(err.message),
    );
  }
});
