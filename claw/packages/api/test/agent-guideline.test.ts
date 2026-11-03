// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The working guideline with the assistant off: a turn's request is finished with the guideline as its system text,
 * ahead of any it already carries, without a single database statement. With the guideline off the request is left
 * as it was (`assistant-flag-off.test.ts`, O1); the assistant's roles with it on are in `assistant-role-profile.test.ts`.
 */
process.env.CLAW_ASSISTANT_ENABLED = "false";
process.env.CLAW_AGENT_GUIDELINE_ENABLED = "true";

import assert from "node:assert/strict";
import test from "node:test";

test("a turn gets the working guideline ahead of the system text it carries, and the database is not asked", async () => {
  const { db } = await import("../src/infra/db.js");
  const { applySessionRoleToTask } = await import("../src/assistant/role-profile.js");
  const { AGENT_GUIDELINE } = await import("../src/sessions/agent-guideline.js");
  const real = db.query;
  (db as any).query = async (text: string) => { throw new Error(`the database was asked: ${text.slice(0, 60)}`); };
  try {
    const bare: Record<string, unknown> = { task_id: "ktsk_1", message_id: "m" };
    await applySessionRoleToTask(bare, "any-session");
    assert.deepEqual(bare, { task_id: "ktsk_1", message_id: "m", system_append: AGENT_GUIDELINE });

    const carrying: Record<string, unknown> = { task_id: "ktsk_2", message_id: "m", system_append: "Plugin text." };
    await applySessionRoleToTask(carrying, "any-session");
    assert.equal(carrying.system_append, `${AGENT_GUIDELINE}\n\nPlugin text.`);
  } finally {
    (db as any).query = real;
  }
});
