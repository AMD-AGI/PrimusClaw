// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `env_map.sandbox_templates` carries the template names the grant made available,
 * `{ role: { cards: name } }`, stored on the run row; not the manifest's own array.
 * A Brain taking the run over starts the application with the stored names, and a
 * run with no grant gets no such variable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AppManifestV1 } from "@claw/protocol";
import { AppRunner } from "../src/apps/app-runner.js";
import { buildAppEnv } from "../src/apps/app-env.js";
import { World, MANIFEST, RUN_ID } from "./support/app-runner-world.js";

const NAMES = { measurement: { "1": "w227t3-runner-g1", "8": "w227t3-runner-g8" } };
const withVar: AppManifestV1 = { ...MANIFEST, env_map: { ...MANIFEST.env_map, sandbox_templates: "APP_TEMPLATES" } };

async function startedEnv(world: World): Promise<Record<string, string>> {
  const runner = new AppRunner(RUN_ID, "pk", { store: world.store, sandbox: world.sandbox, now: world.now, sleep: world.sleep, tickMs: 5000 });
  for (let i = 0; i < 12 && world.rec.state !== "running"; i++) await runner.reconcile();
  assert.equal(world.starts.length, 1);
  return world.starts[0]!.env;
}

test("the application starts with the stored grant names, in the role -> cards -> name form", async () => {
  const world = new World(withVar, { grant_templates: NAMES } as never);
  const env = await startedEnv(world);
  assert.deepEqual(JSON.parse(env.APP_TEMPLATES!), NAMES);
  assert.notEqual(env.APP_TEMPLATES, JSON.stringify(withVar.sandbox_templates));
});

test("a Brain that takes the run over injects the same names (they come from the row)", async () => {
  const first = new World(withVar, { grant_templates: NAMES } as never);
  const a = await startedEnv(first);
  const second = new World(withVar, { grant_templates: structuredClone(first.rec.grant_templates) } as never);
  const b = await startedEnv(second);
  assert.equal(b.APP_TEMPLATES, a.APP_TEMPLATES);
});

test("no grant (no names stored): the variable is not injected", async () => {
  const world = new World(withVar, { grant_templates: null } as never);
  assert.equal((await startedEnv(world)).APP_TEMPLATES, undefined);
});

test("buildAppEnv: empty or absent names inject nothing", () => {
  const base = { runId: "r", sessionId: "s", createdAt: "t", stateDir: "/d", mcpToken: "t", grantKeys: {}, grantLimits: null, nodeName: null, manifest: withVar };
  assert.equal(buildAppEnv({ ...base }).APP_TEMPLATES, undefined);
  assert.equal(buildAppEnv({ ...base, sandboxTemplates: {} }).APP_TEMPLATES, undefined);
  assert.equal(buildAppEnv({ ...base, sandboxTemplates: NAMES }).APP_TEMPLATES, JSON.stringify(NAMES));
});
