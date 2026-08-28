// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The check that decides whether the process is allowed to serve.
 *
 * Schema setup discards the error from most of its statements, which is right
 * for a race between replicas re-running idempotent DDL and wrong for anything
 * else -- and the statement itself cannot tell the two apart. So the result is
 * checked instead of the statements, and these tests pin what "checked" means:
 * every problem reported at once rather than one per boot, and nothing said
 * about parts of the schema this list does not claim to know about.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_SCHEMA,
  missingSchemaObjects,
  type PresentColumn,
} from "../src/infra/schema-guard.js";

/** Everything REQUIRED_SCHEMA asks for, as information_schema would report it. */
function fullSchema(): PresentColumn[] {
  return REQUIRED_SCHEMA.flatMap((req) =>
    req.columns.map((column_name) => ({ table_name: req.table, column_name })),
  );
}

function without(pairs: Array<[string, string]>): PresentColumn[] {
  return fullSchema().filter(
    (c) => !pairs.some(([t, col]) => c.table_name === t && c.column_name === col),
  );
}

test("says nothing when every required column is present", () => {
  assert.deepEqual(missingSchemaObjects(REQUIRED_SCHEMA, fullSchema()), []);
});

test("ignores tables and columns the requirement list does not claim", () => {
  const present = [
    ...fullSchema(),
    { table_name: "claw_tasks", column_name: "some_column_nobody_declared" },
    { table_name: "a_table_we_do_not_check", column_name: "whatever" },
  ];
  assert.deepEqual(missingSchemaObjects(REQUIRED_SCHEMA, present), []);
});

test("names the column a half-applied migration failed to add", () => {
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([["claw_tasks", "queued_at"]]),
  );
  assert.deepEqual(problems, ["claw_tasks is missing column(s): queued_at"]);
});

test("names the sealed-credentials column the doorbell drain needs", () => {
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([["claw_pending_messages", "credentials_blob"]]),
  );
  assert.deepEqual(problems, ["claw_pending_messages is missing column(s): credentials_blob"]);
});

test("reports every missing column of a table in one message", () => {
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([["claw_tasks", "queued_at"], ["claw_tasks", "completed_at"]]),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0], "claw_tasks is missing column(s): queued_at, completed_at");
});

test("reports problems across tables together, so one boot finds them all", () => {
  // An upgrade that lost one column has usually lost several, and finding them
  // one restart at a time is the slow way to learn that.
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([["claw_tasks", "queued_at"], ["claw_sessions", "agent_status"]]),
  ).sort();
  assert.deepEqual(problems, [
    "claw_sessions is missing column(s): agent_status",
    "claw_tasks is missing column(s): queued_at",
  ]);
});

test("collapses an absent table into one message instead of one per column", () => {
  const present = fullSchema().filter((c) => c.table_name !== "claw_tasks");
  assert.deepEqual(missingSchemaObjects(REQUIRED_SCHEMA, present), [
    "table claw_tasks is missing",
  ]);
});

test("reports an empty database as one missing table per requirement", () => {
  const problems = missingSchemaObjects(REQUIRED_SCHEMA, []);
  assert.equal(problems.length, REQUIRED_SCHEMA.length);
  assert.ok(problems.every((p) => p.endsWith("is missing")));
});

test("keeps deadline_at required, since the sweeper reads it every tick", () => {
  const tasks = REQUIRED_SCHEMA.find((r) => r.table === "claw_tasks");
  assert.ok(tasks?.columns.includes("deadline_at"));
});

test("keeps claim_count required, since takeClaim increments it on every claim", () => {
  const tasks = REQUIRED_SCHEMA.find((r) => r.table === "claw_tasks");
  assert.ok(tasks?.columns.includes("claim_count"));
});
