// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * planAppRun resolves the container image from either form the manifest allows:
 * a fixed `container.image`, or `container.image_from_input` read from the run
 * input. Pure function, no database.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { APP_MANIFEST_SCHEMA, type AppManifestV1 } from "@claw/protocol";
import { planAppRun } from "../src/tasks/app-run.js";

const manifest = (container: AppManifestV1["container"]): AppManifestV1 => ({
  schema: APP_MANIFEST_SCHEMA, name: "generic-app", version: "1.0.0",
  container, state_dir: "/state", command: ["run"],
});

test("a fixed container.image becomes the sandbox image; the input is not consulted", () => {
  const plan = planAppRun(manifest({ image: "registry.example.invalid/app:1" }), {});
  assert.ok(!("problems" in plan), JSON.stringify(plan));
  assert.equal((plan as any).sandboxSpec.image, "registry.example.invalid/app:1");
});

test("container.image_from_input reads the image from the input", () => {
  const m = manifest({ image_from_input: "/fw/image" });
  const plan = planAppRun(m, { fw: { image: " registry.example.invalid/fw:2 " } });
  assert.ok(!("problems" in plan), JSON.stringify(plan));
  assert.equal((plan as any).sandboxSpec.image, "registry.example.invalid/fw:2");
  const missing = planAppRun(m, {});
  assert.deepEqual((missing as any).problems.map((p: any) => p.pointer), ["/fw/image"]);
});

test("a fixed image wins over whatever the input holds at an unrelated path", () => {
  const plan = planAppRun(manifest({ image: "registry.example.invalid/app:1" }), { fw: { image: "other" } });
  assert.equal((plan as any).sandboxSpec.image, "registry.example.invalid/app:1");
});

test("an empty fixed image is a problem, not a silent no-op", () => {
  const plan = planAppRun(manifest({ image: "  " }), {});
  assert.equal((plan as any).problems[0].pointer, "container.image");
});

test("a template's workspace_from_input that is not a pointer is refused, not skipped", () => {
  const m = { ...manifest({ image: "registry.example.invalid/app:1" }), sandbox_templates: [{ name: "t", workspace_from_input: 7 }] };
  const plan = planAppRun(m as AppManifestV1, {});
  assert.equal((plan as any).problems[0].pointer, "sandbox_templates[0].workspace_from_input");
  const ok = { ...m, sandbox_templates: [{ name: "t", workspace_from_input: "/w", other: { x: 1 } }] };
  const good = planAppRun(ok as AppManifestV1, { w: "ws-1" });
  assert.deepEqual((good as any).workspaceIds, ["ws-1"]);
});
