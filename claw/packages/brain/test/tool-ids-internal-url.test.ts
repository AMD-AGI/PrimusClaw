// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `tool_ids` skills resolve through the same by-id lookup and base URL as the
 * platform defaults: the in-cluster API (`INTERNAL_BACKEND_URL`, `/v1/tools/<id>`),
 * never the gateway path `/claw-api/v1/tools/<id>` that the SaFE apiserver does
 * not route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, skillZip } from "./support/platform-defaults-world.js";

const world = await startWorld();
const { resolveToolIds } = await import("../src/tools/resolve.js");

test.after(() => world.close());
test.beforeEach(() => { world.paths.length = 0; world.downloads.length = 0; });

test("tool_ids are looked up by id and downloaded on the internal URL", async () => {
  world.setTools([{ id: 21, name: "fleet-ops", zip: skillZip("fleet-ops", "BODY", "Operate") }]);
  const r = await resolveToolIds([21], "ak-user");
  assert.match(r.skillContents["fleet-ops"] ?? "", /BODY/);
  assert.deepEqual(world.paths, ["/v1/tools/21", "/v1/tools/21/download"]);
});

test("a tool the Claw API does not know is skipped, not mistaken for an unreachable endpoint", async () => {
  world.setTools([{ id: 21, name: "fleet-ops", zip: skillZip("fleet-ops", "BODY", "Operate") }]);
  const r = await resolveToolIds([21, 999], "ak-user");
  assert.deepEqual(Object.keys(r.skillContents), ["fleet-ops"]);
  assert.deepEqual(world.paths.filter((p) => p.endsWith("/999")), ["/v1/tools/999"]);
});

test("the shared lookup classifies a gateway 404 as endpoint_unreachable and a Claw API 404 as not_found", async () => {
  const { lookupTool } = await import("../src/tools/lookup.js");
  world.setTools([]);
  assert.deepEqual(await lookupTool(5, "ak"), { ok: false, reason: "not_found" });
  const saved = process.env.INTERNAL_BACKEND_URL;
  delete process.env.INTERNAL_BACKEND_URL; // falls back to the gateway path
  try {
    assert.deepEqual(await lookupTool(5, "ak"), { ok: false, reason: "endpoint_unreachable" });
    assert.deepEqual(world.paths.slice(-1), ["/claw-api/v1/tools/5"]);
  } finally { process.env.INTERNAL_BACKEND_URL = saved; }
});
