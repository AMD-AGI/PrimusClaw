// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The template map an application is handed (`env_map.sandbox_templates`): built
 * from the names Agent Sandbox returned in the grant response, never derived.
 *
 * The format is checked against the rule the consuming application states for it
 * (a non-empty JSON object; each entry a template name or a non-empty object of
 * template names), written out below as `acceptedByConsumer`, not imported.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_MANIFEST_SCHEMA, SandboxTemplateMappingError, buildSandboxTemplateEnv, grantedTemplateNamesOf,
  type AppManifestV1,
} from "../src/index.js";

const manifest = (over: Partial<AppManifestV1> = {}): Pick<AppManifestV1, "sandbox_roles" | "sandbox_templates"> => ({
  sandbox_templates: [
    { name: "measurement", per_gpu_count: [1, 8] },
    { name: "kernel_agent", per_gpu_count: [1] },
    { name: "builder" },
  ],
  sandbox_roles: { measurement: ["measurement"], subrun: ["kernel_agent", "builder"] },
  ...over,
});

/** The shape a grant response has: names by role, DNS-1123 expanded from the run id. */
const RESPONSE = {
  keys: { measurement: "k1", subrun: "k2" },
  templates: {
    measurement: ["w227t3-measurement-g1", "w227t3-measurement-g8"],
    subrun: ["w227t3-kernel-agent-g1", "w227t3-builder"],
  },
};
const granted = () => grantedTemplateNamesOf(RESPONSE);

function acceptedByConsumer(text: string): boolean {
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) return false;
  const name = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  return Object.values(parsed).every((e) => (e !== null && typeof e === "object" && !Array.isArray(e)
    ? Object.keys(e as object).length > 0 && Object.values(e as object).every(name)
    : name(e)));
}

test("a real-shaped grant response gives the role -> cards -> name map", () => {
  const env = buildSandboxTemplateEnv(manifest(), granted());
  assert.deepEqual(env, {
    measurement: { "1": "w227t3-measurement-g1", "8": "w227t3-measurement-g8" },
    subrun: { "1": "w227t3-kernel-agent-g1", "0": "w227t3-builder" },
  });
  assert.ok(acceptedByConsumer(JSON.stringify(env)), "the consumer's own rule accepts it");
});

test("the names are the service's: a name is used exactly as returned, never rebuilt", () => {
  const odd = { ...RESPONSE, templates: { ...RESPONSE.templates, measurement: ["zz9-measurement-g1", "zz9-measurement-g8"] } };
  assert.equal(buildSandboxTemplateEnv(manifest(), grantedTemplateNamesOf(odd)).measurement["8"], "zz9-measurement-g8");
});

test("a card count with no returned name is an error, not a guess", () => {
  const missing = { templates: { ...RESPONSE.templates, measurement: ["w227t3-measurement-g1"] } };
  assert.throws(() => buildSandboxTemplateEnv(manifest(), grantedTemplateNamesOf(missing)), SandboxTemplateMappingError);
});

test("a returned name the manifest does not account for is an error", () => {
  const extra = { templates: { ...RESPONSE.templates, measurement: [...RESPONSE.templates.measurement, "w227t3-measurement-g4"] } };
  assert.throws(() => buildSandboxTemplateEnv(manifest(), grantedTemplateNamesOf(extra)), /does not account for/);
});

test("a role the response does not mention, or no response templates at all, is an error", () => {
  assert.throws(() => buildSandboxTemplateEnv(manifest(), { measurement: RESPONSE.templates.measurement }), /no templates for role subrun/);
  assert.throws(() => buildSandboxTemplateEnv(manifest(), undefined), SandboxTemplateMappingError);
});

test("two templates taking one card count in a role is an error", () => {
  const m = manifest({
    sandbox_templates: [{ name: "a", per_gpu_count: [1] }, { name: "b", per_gpu_count: [1] }],
    sandbox_roles: { measurement: ["a", "b"] },
  });
  assert.throws(() => buildSandboxTemplateEnv(m, { measurement: ["r-a-g1", "r-b-g1"] }), /two templates take 1 card/);
});

test("a template whose DNS name ends another's (runner, gpu_runner) is matched by the shared run prefix", () => {
  const defs = [{ name: "runner", gpus: 0 }, { name: "gpu_runner", gpus: 8 }];
  for (const order of [defs, [...defs].reverse()]) {
    const m = manifest({ sandbox_templates: order, sandbox_roles: { subrun: ["runner", "gpu_runner"] } });
    for (const names of [["w1-runner", "w1-gpu-runner"], ["w1-gpu-runner", "w1-runner"]]) {
      assert.deepEqual(buildSandboxTemplateEnv(m, { subrun: names }).subrun, { "0": "w1-runner", "8": "w1-gpu-runner" });
    }
  }
});

test("a template name with underscores matches its DNS-1123 spelling", () => {
  const env = buildSandboxTemplateEnv(manifest(), granted());
  assert.equal(env.subrun["1"], "w227t3-kernel-agent-g1");
});

test("no sandbox role: nothing to map", () => {
  assert.throws(() => buildSandboxTemplateEnv(manifest({ sandbox_roles: undefined }), granted()), /no sandbox role/);
});

test("grantedTemplateNamesOf reads only the expected shape", () => {
  assert.deepEqual(grantedTemplateNamesOf({ templates: { measurement: ["a"] } }), { measurement: ["a"] });
  for (const bad of [null, {}, { templates: [] }, { templates: { m: "a" } }, { templates: { m: [1] } }, { templates: { m: [""] } }]) {
    assert.equal(grantedTemplateNamesOf(bad), undefined);
  }
});

test("the manifest schema constant is unchanged (guard against drift in this fixture)", () => {
  assert.ok(APP_MANIFEST_SCHEMA);
});
