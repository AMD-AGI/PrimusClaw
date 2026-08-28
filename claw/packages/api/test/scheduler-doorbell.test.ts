// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Chat doorbell rows wait on the table for claim-next. The scheduler is the
 * DAG publisher; picking those rows republishes them as fat execute requests
 * and steals them from the claim path.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import { schedulerTick } from "../src/tasks/scheduler.js";

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

test("the scheduler does not pick a queued chat run", async () => {
  const seen: string[] = [];
  db.query = (async (text: string) => {
    seen.push(text.replace(/\s+/g, " ").trim());
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  await schedulerTick();

  const pick = seen.find((sql) =>
    /FROM claw_tasks/.test(sql)
    && /status = 'queued'/.test(sql)
    && /executor = 'brain'/.test(sql)
  );
  assert.ok(pick, "the tick still looks for DAG work to publish");
  assert.match(pick, /origin IS DISTINCT FROM 'chat'/);
});
