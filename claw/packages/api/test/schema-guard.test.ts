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
  classifySchemaProblems,
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

test("names the session gate owner column before a request tries to write it", () => {
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([["claw_sessions", "agent_gate_message_id"]]),
  );
  assert.deepEqual(problems, ["claw_sessions is missing column(s): agent_gate_message_id"]);
});

test("names the session model column before a turn tries to read it", () => {
  // Every dispatch selects it and every create writes it, so a database without
  // it must stop the start-up rather than fail each turn at run time.
  const problems = missingSchemaObjects(REQUIRED_SCHEMA, without([["claw_sessions", "model"]]));
  assert.deepEqual(problems, ["claw_sessions is missing column(s): model"]);
});

for (const column of [
  "attempt_id",
  "attempt_generation",
  "settled_attempt_id",
  "delivery_seq",
  "delivery_count",
  "ledger_version",
  "queued_ms_accrued",
]) {
  test(`keeps ${column} required for run accounting`, () => {
    const problems = missingSchemaObjects(
      REQUIRED_SCHEMA,
      without([["claw_tasks", column]]),
    );
    assert.deepEqual(problems, [`claw_tasks is missing column(s): ${column}`]);
  });
}

test("names the answer-feedback table before a vote tries to write it", () => {
  // The vote routes insert and delete on it for every user, so a database that
  // lost it must stop the start-up rather than answer 500 to each vote.
  const present = fullSchema().filter((c) => c.table_name !== "claw_answer_feedback");
  assert.deepEqual(missingSchemaObjects(REQUIRED_SCHEMA, present), ["table claw_answer_feedback is missing"]);
});

for (const column of ["session_id", "message_id", "user_id", "vote", "reason", "updated_at"]) {
  test(`keeps ${column} required on the answer-feedback table`, () => {
    assert.deepEqual(
      missingSchemaObjects(REQUIRED_SCHEMA, without([["claw_answer_feedback", column]])),
      [`claw_answer_feedback is missing column(s): ${column}`],
    );
  });
}

test("keeps the run-time epoch required, since requeues overwrite queued_at", () => {
  const tasks = REQUIRED_SCHEMA.find((r) => r.table === "claw_tasks");
  assert.ok(tasks?.columns.includes("run_time_epoch_at"));
});

test("names the throwaway-workspace column, which every task insert writes", () => {
  // Not a column only the tasks that set it touch: insertTask names it in the
  // INSERT for every run, so a database missing it fails run creation outright.
  // Startup is where that has to be said, while the deployment can still be
  // rolled back, rather than on the first dispatch after it.
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([["claw_tasks", "workspace_throwaway"]]),
  );
  assert.deepEqual(problems, ["claw_tasks is missing column(s): workspace_throwaway"]);
});

test("keeps workspace_throwaway required, since insertTask names it on every row", () => {
  const tasks = REQUIRED_SCHEMA.find((r) => r.table === "claw_tasks");
  assert.ok(tasks?.columns.includes("workspace_throwaway"));
});

test("names the reconciliation marker, whose absence disarms the sweeper silently", () => {
  // Nothing fails on the request path when this column is gone. The dispatch
  // simply stops recording that its publish was ambiguous, and the rows nobody
  // reconciles pair a claimable run with a session that was rolled back.
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([["claw_tasks", "dispatch_reconcile_at"]]),
  );
  assert.deepEqual(problems, ["claw_tasks is missing column(s): dispatch_reconcile_at"]);
});

test("names the reconciliation action, without which cleanup cannot be replayed", () => {
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([["claw_tasks", "dispatch_reconcile_action"]]),
  );
  assert.deepEqual(problems, ["claw_tasks is missing column(s): dispatch_reconcile_action"]);
});

test("names the queued message's durable run id, whose absence duplicates a turn", () => {
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([["claw_pending_messages", "dispatch_task_id"]]),
  );
  assert.deepEqual(problems, ["claw_pending_messages is missing column(s): dispatch_task_id"]);
});

test("reports all three dispatch columns at once, since one migration adds them", () => {
  const problems = missingSchemaObjects(
    REQUIRED_SCHEMA,
    without([
      ["claw_tasks", "dispatch_reconcile_at"],
      ["claw_tasks", "dispatch_reconcile_action"],
      ["claw_pending_messages", "dispatch_task_id"],
    ]),
  ).sort();
  assert.deepEqual(problems, [
    "claw_pending_messages is missing column(s): dispatch_task_id",
    "claw_tasks is missing column(s): dispatch_reconcile_at, dispatch_reconcile_action",
  ]);
});

test("a missing app-run table stops start-up only when app runs are enabled", () => {
  const present = without([["claw_app_runs", "request_hash"], ["claw_app_runs", "created_by"]]);
  const on = classifySchemaProblems(REQUIRED_SCHEMA, present, true);
  assert.deepEqual(on.fatal, ["claw_app_runs is missing column(s): created_by, request_hash"]);
  assert.deepEqual(on.warnings, []);
  const off = classifySchemaProblems(REQUIRED_SCHEMA, present, false);
  assert.deepEqual(off.fatal, []);
  assert.deepEqual(off.warnings, on.fatal);
  // The whole table gone, and every other table's gap, stays as it was.
  const noTable = fullSchema().filter((c) => c.table_name !== "claw_app_runs");
  assert.deepEqual(classifySchemaProblems(REQUIRED_SCHEMA, noTable, false).fatal, []);
  assert.deepEqual(classifySchemaProblems(REQUIRED_SCHEMA, noTable, true).fatal, ["table claw_app_runs is missing"]);
  const other = without([["claw_tasks", "queued_at"]]);
  assert.deepEqual(classifySchemaProblems(REQUIRED_SCHEMA, other, false).fatal, ["claw_tasks is missing column(s): queued_at"]);
});
