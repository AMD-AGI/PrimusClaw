// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_MANIFEST_SCHEMA, type AppManifestV1 } from "../src/app-manifest.js";
import {
  appGrantTemplates, DEFAULT_APP_CONTAINER_CAPS, parseAppContainerCaps, parseAppSandboxCaps, resolveAppResources, type ResolvedAppResources,
} from "../src/app-resources.js";

/** A generic app: two roles, a default image, defaults and a maximum in `limits`. */
const MANIFEST: AppManifestV1 = {
  schema: APP_MANIFEST_SCHEMA, name: "example-app", version: "1.0.0",
  container: { image: "registry.example.invalid/app:default", resources: { cpu: "8", memory: "32Gi" } },
  state_dir: "/state", command: ["run"],
  sandbox_templates: [
    { name: "runner", per_gpu_count: [1, 2], provider: "p" },
    { name: "pinned", image: "registry.example.invalid/own:1", workspace: "ws-own" },
  ],
  sandbox_roles: { measurement: ["runner"], subrun: ["pinned"] },
  limits: { max_sandboxes: 4, max_runtime_sec: 3600 },
};
const GOOD = { gpus: 8, workspace: "ws-app" };

const ok = (raw: unknown, caps = {}, m = MANIFEST, cc = DEFAULT_APP_CONTAINER_CAPS): ResolvedAppResources => {
  const r = resolveAppResources(m, raw, caps, cc);
  assert.ok("resources" in r, JSON.stringify(r));
  return r.resources;
};
const refused = (raw: unknown, field: string, reason: string, caps = {}, m = MANIFEST, cc = DEFAULT_APP_CONTAINER_CAPS): void => {
  const r = resolveAppResources(m, raw, caps, cc);
  assert.ok("issues" in r, `expected a refusal, got ${JSON.stringify(r)}`);
  const hit = r.issues.filter((i) => i.field === field);
  assert.ok(hit.some((i) => i.reason.includes(reason)), `${field}: ${JSON.stringify(r.issues)} lacks "${reason}"`);
};

test("a request gives the run its image, gpus, workspaces, cpu and memory", () => {
  const r = ok({ image: " img:2 ", gpus: 4, workspace: "w1", sandbox_workspace: "w2", cpu: 2.5, memory_gi: 16 });
  assert.deepEqual(r, { image: "img:2", gpus: 4, workspace: "w1", sandboxWorkspace: "w2", cpu: 2.5, memoryGi: 16, grant: { max_sandboxes: 4, max_runtime_sec: 3600 } });
});

test("absent items take the manifest defaults; the template workspace defaults to the app's", () => {
  const r = ok(GOOD);
  assert.equal(r.image, "registry.example.invalid/app:default");
  assert.equal(r.sandboxWorkspace, "ws-app");
  assert.equal(r.cpu, undefined, "cpu and memory stay with container.resources when not requested");
  assert.deepEqual(r.grant, { max_sandboxes: 4, max_runtime_sec: 3600 });
});

test("no image from the request or the manifest is a specific refusal, not a guess", () => {
  const m = { ...MANIFEST, container: {} };
  refused(GOOD, "resources.image", "no image", {}, m);
  refused(undefined, "resources.image", "no image", {}, m);
  assert.equal(ok({ ...GOOD, image: "img:1" }, {}, m).image, "img:1", "the request alone is enough");
});

test("gpus and workspace are required, and gpus has no manifest default", () => {
  refused({ workspace: "w" }, "resources.gpus", "required");
  refused({ gpus: 1 }, "resources.workspace", "required");
  assert.equal(ok({ workspace: "w", gpus: 0 }, {}).gpus, 0, "an explicit 0 is a request");
});

test("types are checked and nothing negative passes", () => {
  refused({ ...GOOD, gpus: -1 }, "resources.gpus", "whole number");
  refused({ ...GOOD, gpus: 1.5 }, "resources.gpus", "whole number");
  refused({ ...GOOD, gpus: "8" }, "resources.gpus", "whole number");
  refused({ ...GOOD, workspace: 7 }, "resources.workspace", "non-empty string");
  refused({ ...GOOD, image: "" }, "resources.image", "non-empty string");
  refused({ ...GOOD, cpu: 0 }, "resources.cpu", "plain decimal");
  refused({ ...GOOD, memory_gi: -4 }, "resources.memory_gi", "plain decimal");
  refused({ ...GOOD, grant: { gpu_hours: -1 } }, "resources.grant.gpu_hours", ">= 0");
  refused({ ...GOOD, grant: { max_runtime_sec: "x" } }, "resources.grant.max_runtime_sec", ">= 0");
  refused({ ...GOOD, grant: { max_sandboxes: -1 } }, "resources.grant.max_sandboxes", "whole number");
  refused({ ...GOOD, grant: { max_gpus: 0.5 } }, "resources.grant.max_gpus", "whole number");
  refused("x", "resources", "must be an object");
  refused([], "resources", "must be an object");
});

test("an unknown field is refused, so a misspelt resource is not silently ignored", () => {
  refused({ ...GOOD, gpu: 8 }, "resources.gpu", "unknown field");
  refused({ ...GOOD, grant: { gpu_hour: 1 } }, "resources.grant.gpu_hour", "unknown field");
  refused({ ...GOOD, grant: { max_gpu: 1 } }, "resources.grant.max_gpu", "unknown field");
});

test("grant.roles is not a field: a request still carrying it is refused, whatever the role", () => {
  refused({ ...GOOD, grant: { roles: { measurement: { max_sandboxes: 1 } } } }, "resources.grant.roles", "unknown field");
  refused({ ...GOOD, grant: { roles: {}, gpu_hours: 1 } }, "resources.grant.roles", "unknown field");
  assert.throws(() => parseAppSandboxCaps('{"roles":{"measurement":{"max_gpus":2}}}'), /roles/);
});

test("each grant item is the smaller of the request and the cap", () => {
  const caps = { max_sandboxes: 6, max_gpus: 8, gpu_hours: 100, max_runtime_sec: 7200 };
  const r = ok({ ...GOOD, grant: { max_sandboxes: 50, max_gpus: 4, gpu_hours: 1e6, max_runtime_sec: 99999 } }, caps);
  assert.deepEqual(r.grant, { max_sandboxes: 4, max_gpus: 4, gpu_hours: 100, max_runtime_sec: 3600 }, "above the cap -> the cap; below it -> the request; max_sandboxes: the manifest limit 4 is below the cap 6");
  const small = ok({ ...GOOD, grant: { max_sandboxes: 2, max_gpus: 9, gpu_hours: 3 } }, caps);
  assert.deepEqual(small.grant, { max_sandboxes: 2, max_gpus: 8, gpu_hours: 3, max_runtime_sec: 3600 });
});

test("with no cap configured the request goes through as it is", () => {
  const m = { ...MANIFEST, limits: { max_runtime_sec: 3600 } };
  const r = ok({ ...GOOD, grant: { max_sandboxes: 999, max_gpus: 64, gpu_hours: 12345 } }, {}, m);
  assert.deepEqual(r.grant, { max_sandboxes: 999, max_gpus: 64, gpu_hours: 12345, max_runtime_sec: 3600 });
  // A cap on one item does not touch the others.
  const some = ok({ ...GOOD, grant: { max_sandboxes: 999, max_gpus: 64 } }, { max_gpus: 8 }, m);
  assert.deepEqual(some.grant, { max_sandboxes: 999, max_gpus: 8, max_runtime_sec: 3600 });
});

test("an item the request omits but a cap names is the cap, never unlimited", () => {
  const r = ok(GOOD, { gpu_hours: 40, max_gpus: 2, max_sandboxes: 9 });
  assert.deepEqual(r.grant, { max_sandboxes: 4, max_gpus: 2, gpu_hours: 40, max_runtime_sec: 3600 }, "max_sandboxes: manifest default 4 is below the cap 9");
  const m = { ...MANIFEST, limits: { max_runtime_sec: 3600 } };
  assert.equal(ok(GOOD, { max_sandboxes: 9 }, m).grant.max_sandboxes, 9, "no request, no manifest default -> the cap");
  assert.equal(ok(GOOD, {}, m).grant.max_sandboxes, undefined, "nothing anywhere -> absent");
});

test("max_runtime_sec is the smallest of the request, the manifest limit and the cap", () => {
  assert.equal(ok({ ...GOOD, grant: { max_runtime_sec: 600 } }).grant.max_runtime_sec, 600);
  assert.equal(ok({ ...GOOD, grant: { max_runtime_sec: 99999 } }).grant.max_runtime_sec, 3600, "the manifest maximum");
  assert.equal(ok({ ...GOOD, grant: { max_runtime_sec: 99999 } }, { max_runtime_sec: 1800 }).grant.max_runtime_sec, 1800);
  assert.equal(ok(GOOD).grant.max_runtime_sec, 3600, "absent -> the manifest limit");
});

test("templates inherit the run's image and workspace unless they set their own; the rest passes through", () => {
  const r = ok({ ...GOOD, image: "img:9", sandbox_workspace: "ws-sbx" });
  const t = appGrantTemplates(MANIFEST, r);
  assert.deepEqual(t[0], { name: "runner", per_gpu_count: [1, 2], provider: "p", image: "img:9", workspace: "ws-sbx" });
  assert.deepEqual(t[1], { name: "pinned", image: "registry.example.invalid/own:1", workspace: "ws-own" });
  assert.deepEqual(MANIFEST.sandbox_templates?.[0], { name: "runner", per_gpu_count: [1, 2], provider: "p" }, "the manifest is not mutated");
});

test("APP_SANDBOX_CAPS parses the grant shape, and a bad value fails loudly", () => {
  assert.deepEqual(parseAppSandboxCaps(undefined), {});
  assert.deepEqual(parseAppSandboxCaps(" "), {});
  assert.deepEqual(parseAppSandboxCaps('{"max_sandboxes":8,"max_gpus":2,"gpu_hours":10}'), { max_sandboxes: 8, max_gpus: 2, gpu_hours: 10 });
  assert.throws(() => parseAppSandboxCaps("{"), /not valid JSON/);
  assert.throws(() => parseAppSandboxCaps('{"gpu_hours":-1}'), /gpu_hours/);
  assert.throws(() => parseAppSandboxCaps('{"typo":1}'), /typo/);
});

test("max_sandboxes is a default and an upper bound: min(request, manifest, cap)", () => {
  // MANIFEST.limits.max_sandboxes = 4
  assert.equal(ok({ ...GOOD, grant: { max_sandboxes: 99 } }).grant.max_sandboxes, 4, "request above the manifest limit");
  assert.equal(ok({ ...GOOD, grant: { max_sandboxes: 2 } }).grant.max_sandboxes, 2, "request below it");
  assert.equal(ok(GOOD).grant.max_sandboxes, 4, "no request -> the manifest value");
  assert.equal(ok(GOOD, { max_sandboxes: 3 }).grant.max_sandboxes, 3, "no request -> the smaller of manifest and cap");
  assert.equal(ok({ ...GOOD, grant: { max_sandboxes: 99 } }, { max_sandboxes: 3 }).grant.max_sandboxes, 3);
  assert.equal(ok({ ...GOOD, grant: { max_sandboxes: 99 } }, { max_sandboxes: 9 }).grant.max_sandboxes, 4);
});

test("cpu and memory above what the manifest declares are refused, naming the field", () => {
  const m = { ...MANIFEST, container: { image: "i", resources: { cpu: "8", memory: "32Gi" } } };
  refused({ ...GOOD, cpu: 8.5 }, "resources.cpu", "exceeds the manifest maximum 8", {}, m);
  refused({ ...GOOD, memory_gi: 33 }, "resources.memory_gi", "exceeds the manifest maximum 32Gi", {}, m);
  // At the maximum, below it, and in other units of the same quantity: allowed.
  ok({ ...GOOD, cpu: 8, memory_gi: 32 }, {}, m);
  ok({ ...GOOD, cpu: 1, memory_gi: 1 }, {}, m);
  const small = { ...m, container: { image: "i", resources: { cpu: "500m", memory: "512Mi" } } };
  refused({ ...GOOD, cpu: 1 }, "resources.cpu", "exceeds", {}, small);
  refused({ ...GOOD, memory_gi: 1 }, "resources.memory_gi", "exceeds", {}, small);
  ok({ ...GOOD, cpu: 0.5, memory_gi: 0.5 }, {}, small);
  // Other spellings of a quantity are read, not skipped.
  const exp = { ...m, container: { image: "i", resources: { cpu: "1e1", memory: "1e12" } } };
  refused({ ...GOOD, cpu: 11 }, "resources.cpu", "exceeds", {}, exp);
  refused({ ...GOOD, memory_gi: 1000 }, "resources.memory_gi", "exceeds", {}, exp);
  ok({ ...GOOD, cpu: 10, memory_gi: 900 }, {}, exp);
  refused({ ...GOOD, memory_gi: 2000 }, "resources.memory_gi", "exceeds", {}, { ...exp, container: { image: "i", resources: { memory: "1T" } } });
  // A declared maximum that cannot be read refuses a request for it rather than lifting the limit.
  const junk = { ...m, container: { image: "i", resources: { cpu: "lots", memory: "32Gi" } } };
  refused({ ...GOOD, cpu: 1 }, "resources.cpu", "not a readable quantity", {}, junk);
  refused({ ...GOOD, memory_gi: 1 }, "resources.cpu", "manifest default", {}, junk); // the unreadable cpu default is what the pod would get
  // A resource the manifest does not declare has no manifest maximum.
  const none = { ...m, container: { image: "i" } };
  ok({ ...GOOD, cpu: 200, memory_gi: 2000 }, {}, none);
  const onlyMem = { ...m, container: { image: "i", resources: { memory: "32Gi" } } };
  ok({ ...GOOD, cpu: 200 }, {}, onlyMem);
});

test("gpus, cpu and memory are bounded by the platform's container caps whatever the manifest says", () => {
  const none = { ...MANIFEST, container: { image: "i" } };
  refused({ ...GOOD, gpus: 100000 }, "resources.gpus", "exceeds the platform maximum 8", {}, none);
  refused({ ...GOOD, cpu: 257 }, "resources.cpu", "exceeds the platform maximum 256", {}, none);
  refused({ ...GOOD, memory_gi: 4097 }, "resources.memory_gi", "exceeds the platform maximum 4096", {}, none);
  ok({ ...GOOD, gpus: 8, cpu: 256, memory_gi: 4096 }, {}, none);
  // Configured caps replace the defaults, per item.
  const big = { gpus: 16, cpu: 512, memory_gi: 8192 };
  ok({ ...GOOD, gpus: 16, cpu: 512, memory_gi: 8192 }, {}, none, big);
  refused({ ...GOOD, gpus: 17 }, "resources.gpus", "exceeds the platform maximum 16", {}, none, big);
});

test("cpu and memory_gi must be plain decimals: no exponent form, nothing that rounds to zero", () => {
  for (const [f, v] of [["cpu", 1e21], ["cpu", 1e-7], ["cpu", 0.0001], ["memory_gi", 1e-7], ["memory_gi", 0.0000005], ["memory_gi", 1.1234567], ["cpu", 0], ["memory_gi", -1], ["cpu", NaN], ["cpu", Infinity]] as const) {
    refused({ ...GOOD, [f]: v }, `resources.${f}`, "plain decimal");
  }
  ok({ ...GOOD, cpu: 0.001, memory_gi: 0.5 });
  ok({ ...GOOD, cpu: 2.5, memory_gi: 8.123456 });
});

test("APP_CONTAINER_CAPS: unset is one node, items default individually, bad values stop start-up", () => {
  assert.deepEqual(parseAppContainerCaps(undefined), DEFAULT_APP_CONTAINER_CAPS);
  assert.deepEqual(parseAppContainerCaps(" "), DEFAULT_APP_CONTAINER_CAPS);
  assert.deepEqual(parseAppContainerCaps('{"gpus":16}'), { ...DEFAULT_APP_CONTAINER_CAPS, gpus: 16 });
  for (const bad of ["nope", "[]", '{"gpus":0}', '{"gpus":1.5}', '{"cpu":-1}', '{"memory_gi":1e30}', '{"disk":1}', '{"gpus":"8"}']) {
    assert.throws(() => parseAppContainerCaps(bad), /APP_CONTAINER_CAPS/, bad);
  }
});

test("a manifest default above the platform caps is refused when the request does not override it", () => {
  const huge = { ...MANIFEST, container: { image: "i", resources: { cpu: "1000", memory: "8192Gi" } } };
  refused(GOOD, "resources.cpu", "manifest default 1000 exceeds the platform maximum 256", {}, huge);
  refused(GOOD, "resources.memory_gi", "manifest default 8192Gi exceeds the platform maximum 4096", {}, huge);
  // Overriding with a value inside both the manifest maximum and the caps is fine.
  refused({ ...GOOD, cpu: 8, memory_gi: 8 }, "resources.cpu", "exceeds", {}, huge, { gpus: 8, cpu: 4, memory_gi: 4096 });
  ok({ ...GOOD, cpu: 8, memory_gi: 8 }, {}, huge);
  // Defaults inside the caps, and an unreadable default, behave sensibly.
  ok(GOOD, {}, { ...MANIFEST, container: { image: "i", resources: { cpu: "32", memory: "128Gi" } } });
  refused(GOOD, "resources.cpu", "not a readable quantity", {}, { ...MANIFEST, container: { image: "i", resources: { cpu: "lots" } } });
});
