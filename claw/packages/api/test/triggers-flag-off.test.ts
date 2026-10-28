// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// With CLAW_TRIGGERS_ENABLED unset the feature leaves no trace: no tables.
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { readFileSync } from "node:fs";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("triggers flag off", { skip }, () => {
  let h: AdmissionCluster;
  before(async () => { delete process.env.CLAW_TRIGGERS_ENABLED; h = await startAdmissionCluster({}); });
  after(async () => { await h?.stop(); });

  test("initDb creates no trigger tables", async () => {
    const r = await h.app.db.db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'claw_trigger%'");
    assert.deepEqual(r.rows, []);
  });

  test("the flag defaults to off and is the only gate on routes and loop", async () => {
    const cfg = await import("../src/config.js");
    assert.equal(cfg.CLAW_TRIGGERS_ENABLED, false);
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(index, /if \(CLAW_TRIGGERS_ENABLED\) await registerTriggerRoutes\(app\)/);
    assert.match(index, /if \(CLAW_TRIGGERS_ENABLED\) startTriggerScheduler\(\)/);
  });
});
