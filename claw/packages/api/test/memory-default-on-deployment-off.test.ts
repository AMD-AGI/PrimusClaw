// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `CLAW_MEMORY_DEFAULT_ON=true` on a deployment without memory (`CLAW_MEMORY_ENABLED` off): the default turns nothing
 * on. A user who never chose reads as off, so the REST writes, which ask only the preference, refuse them as before.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.CLAW_MEMORY_ENABLED = "false";
process.env.CLAW_MEMORY_DEFAULT_ON = "true";

test("the default does not turn memory on where the deployment has none", async () => {
  const config = await import("../src/config.js");
  assert.equal(config.CLAW_MEMORY_DEFAULT_ON, true);
  assert.equal(config.CLAW_MEMORY_ENABLED, false);
  const svc = await import("../src/memory/service.js");
  const { db } = await import("../src/infra/db.js");
  const real = db.query;
  let rows: Array<{ enabled: boolean }> = [];
  db.query = (async () => ({ rows })) as unknown as typeof db.query;
  try {
    assert.equal(await svc.getMemoryPreference("never-chose"), false, "no row: off, the default notwithstanding");
    rows = [{ enabled: false }];
    assert.equal(await svc.getMemoryPreference("chose-off"), false);
  } finally {
    db.query = real;
  }
});
