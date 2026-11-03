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

test("only the working-style sections give way to the user and supplied rules; Safety always applies", async () => {
  const { AGENT_GUIDELINE } = await import("../src/sessions/agent-guideline.js");
  const sections = AGENT_GUIDELINE.split(/^## /m);
  const opening = sections[0]!;
  assert.match(
    opening,
    /The sections on doing the task, checking your work and talking to the user are defaults that the user's instructions, and any rules or skills supplied with the request, may override\. The Safety section always applies\./,
  );
  // A plugin rule or skill claiming precedence must not reach "never print secrets" or a denied approval.
  assert.doesNotMatch(opening, /take precedence/);
  assert.deepEqual(
    sections.slice(1).map((s) => s.split("\n", 1)[0]),
    ["Doing the task", "Checking your work", "Talking to the user", "Safety"],
  );
});
