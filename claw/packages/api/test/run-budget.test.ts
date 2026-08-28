// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// How long a run is allowed to burn compute.
//
// One constant, BRAIN_TASK_TIMEOUT_SEC, used to answer both "how long may this
// run take" and "is the worker running it still alive". Those want time scales
// three orders of magnitude apart, so six hours was simultaneously too short
// for a healthy long job and far too long to notice a dead worker. These pin
// the split: a per-run budget with per-scope defaults, and a backstop that
// waits for the run to speak first.

// The rule lives in SQL, so that the deadline is computed from the row in the
// same statement that stamps `started_at` and cannot disagree with it. That is
// why these read the statement rather than calling a function: a TypeScript
// copy of the rule would be the thing under test and not the thing that runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { envSettingProblems } from "../src/config.js";
import { startHarness } from "./scenario-harness.js";
import {
  RUN_BUDGET_DEFAULT_SEC,
  RUN_BUDGET_OFF,
  RUN_BUDGET_BACKSTOP_GRACE_SEC,
  deadlineStampSql,
  deadlineAtInsertSql,
} from "../src/tasks/run-budget.js";

test("each scope reads its own env key, so lowering one does not move the other", async () => {
  // This used to assert `dag_node > chat`, on the premise that a chat turn
  // taking hours is a symptom. It is not: the inference-optimization runs this
  // fleet exists for arrive as chat turns and are supposed to take hours, so
  // the chat default is now the larger of the two and the magnitude relation
  // says nothing.
  //
  // What is still worth pinning is the thing the name claims -- two settings,
  // not one. Asserting it needs a fresh module: the defaults are read once at
  // import, so a test that only inspects the already-imported constants cannot
  // tell a shared key from two keys that happen to carry the same number.
  const before = {
    chat: process.env.RUN_BUDGET_CHAT_SEC,
    dag: process.env.RUN_BUDGET_DAG_NODE_SEC,
  };
  process.env.RUN_BUDGET_CHAT_SEC = "600";
  delete process.env.RUN_BUDGET_DAG_NODE_SEC;
  try {
    // Specifier in a variable: the query suffix is a module-cache bust, not a
    // path, and a literal would send tsc looking for a file that is not there.
    const spec = "../src/tasks/run-budget.js?scope-keys";
    const fresh = await import(spec);
    assert.equal(fresh.RUN_BUDGET_DEFAULT_SEC.chat, 600,
      "RUN_BUDGET_CHAT_SEC must be what sets the chat budget");
    assert.equal(fresh.RUN_BUDGET_DEFAULT_SEC.dag_node, 24 * 60 * 60,
      "a chat override must not drag the DAG-node default with it");
  } finally {
    if (before.chat === undefined) delete process.env.RUN_BUDGET_CHAT_SEC;
    else process.env.RUN_BUDGET_CHAT_SEC = before.chat;
    if (before.dag !== undefined) process.env.RUN_BUDGET_DAG_NODE_SEC = before.dag;
  }
});

test("a chat turn's default budget is sized for an agent run, not a reply", () => {
  // The floor is the measurement, not a round number: over 30 days the longest
  // chat turn that ran to completion took 25.0h, and a ceiling at or under that
  // kills finished-quality work after a day of GPU time. Stated as a floor so
  // raising it further is not a test change; stated at 25h so lowering it back
  // to a day -- which was the first answer here, and is inside the observed
  // distribution -- is.
  const OBSERVED_LONGEST_COMPLETED_SEC = 25 * 60 * 60;
  assert.ok(RUN_BUDGET_DEFAULT_SEC.chat > OBSERVED_LONGEST_COMPLETED_SEC,
    "a chat turn carries the long-horizon agent runs; a cap inside the measured distribution kills them");
  assert.notEqual(RUN_BUDGET_DEFAULT_SEC.chat, RUN_BUDGET_OFF,
    "off by default would trade the two-hour kill for a silent one");
  assert.ok(RUN_BUDGET_DEFAULT_SEC.dag_node > 0);
});

test("zero is accepted as a budget rather than refused and quietly replaced", async () => {
  // The whole point of the sentinel. `envSec`'s `min: 1` rejected a zero and
  // returned the fallback, so an operator who set the budget to 0 kept the
  // ceiling they meant to remove and learned about it only from a log line.
  //
  // Asserted through both: the default is no longer 0, so the returned value
  // does distinguish "0 took" from "0 was refused" -- and the problem log is
  // checked as well, because a refusal is the shape the old bug had.
  const before = process.env.RUN_BUDGET_CHAT_SEC;
  process.env.RUN_BUDGET_CHAT_SEC = "0";
  try {
    const spec = "../src/tasks/run-budget.js?zero-accepted";
    const fresh = await import(spec);
    assert.equal(fresh.RUN_BUDGET_DEFAULT_SEC.chat, 0);
    assert.ok(
      !envSettingProblems().some((p) => p.startsWith("RUN_BUDGET_CHAT_SEC=")),
      "a refused zero is a silent fallback to the ceiling the operator removed",
    );
  } finally {
    if (before === undefined) delete process.env.RUN_BUDGET_CHAT_SEC;
    else process.env.RUN_BUDGET_CHAT_SEC = before;
  }
});

test("a zero budget stamps no deadline, and a real one still does", async () => {
  // Against a real Postgres rather than the SQL text: `NULLIF` in the right
  // place is the whole mechanism, and a string assertion cannot tell a NULLIF
  // that wraps the budget from one that wraps something else.
  const h = await startHarness();
  try {
    const stamp = deadlineStampSql(1, 2);
    const mk = async (chatBudget: number) => {
      await h.sql(`INSERT INTO claw_tasks (task_id, session_id, name, status, origin, metadata)
                   VALUES ('t','s','n','preparing','chat','{}'::jsonb)`);
      await h.sql(`UPDATE claw_tasks SET ${stamp} WHERE task_id = 't'`, [chatBudget, 3600]);
      const [row] = await h.sql(`SELECT deadline_at FROM claw_tasks WHERE task_id = 't'`);
      await h.sql(`DELETE FROM claw_tasks WHERE task_id = 't'`);
      return row.deadline_at;
    };

    assert.equal(await mk(0), null,
      "a zero chat budget must leave the column unset, not stamp NOW()");
    assert.notEqual(await mk(3600), null,
      "a configured budget must still produce a deadline");
  } finally {
    await h.close();
  }
});

test("a declared budget means the same thing zero means anywhere else", async () => {
  // The inner `NULLIF(budget_sec, 0)` this replaced read a declared zero as
  // "unset" and fell through to the scope default -- two meanings for one
  // number, and the fall-through is the dangerous direction: a caller that
  // declared "no budget" silently inherited whatever ceiling the deployment
  // happened to carry.
  //
  // Nothing writes `derived.budget_sec` today; `dag-expander` writes its
  // siblings under `derived` and not this one. So the change is latent, which
  // is the reason to pin it now rather than leave it for the first writer to
  // find out about.
  const h = await startHarness();
  try {
    const stamp = deadlineStampSql(1, 2);
    const stampWith = async (meta: string, chatBudget: number) => {
      await h.sql(
        `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, metadata)
         VALUES ('t','s','n','preparing','chat',$1::jsonb)`, [meta]);
      await h.sql(`UPDATE claw_tasks SET ${stamp} WHERE task_id = 't'`, [chatBudget, 3600]);
      const [row] = await h.sql(`SELECT deadline_at FROM claw_tasks WHERE task_id = 't'`);
      await h.sql(`DELETE FROM claw_tasks WHERE task_id = 't'`);
      return row.deadline_at;
    };

    assert.equal(await stampWith('{"derived":{"budget_sec":0}}', 3600), null,
      "a declared zero must turn the deadline off, not fall through to the scope default");
    assert.notEqual(await stampWith('{"derived":{"budget_sec":900}}', 0), null,
      "a declared budget must still outrank a scope default that is off");
  } finally {
    await h.close();
  }
});

test("the stamp reads a recorded origin before guessing from the row's shape", () => {
  const sql = deadlineStampSql(3, 4);
  const recorded = sql.indexOf("origin = 'chat'");
  const guessed = sql.indexOf("dag_root_task_id IS NULL");

  assert.ok(recorded >= 0, "the row says what kind of run it is; that answer comes first");
  assert.ok(guessed > recorded,
    "a standalone task has no DAG root, so reaching the guess first reads it as a "
    + "conversation and hands it the chat scope's budget rather than its own");
});

test("a declared budget outranks the scope default", () => {
  const sql = deadlineStampSql(3, 4);
  const declared = sql.indexOf("budget_sec");
  const fallback = sql.indexOf("CASE");

  assert.ok(declared >= 0 && fallback > declared,
    "the defaults are a fallback inside COALESCE; ordering them the other way "
    + "would make a node that declares 15 minutes inherit the scope default instead");
});

test("the stamp does not hand a restarted run a second budget", () => {
  const sql = deadlineStampSql(3, 4);

  assert.match(sql, /deadline_at = COALESCE\(\s*deadline_at,/,
    "preparing → running fires this twice; only the first may set a deadline");
});

test("the stamp reads the scope from the row, so it cannot disagree with it", () => {
  const sql = deadlineStampSql(3, 4);

  assert.match(sql, /dag_root_task_id IS NULL/,
    "computing this in SQL is what keeps it consistent with the started_at written beside it");
  assert.match(sql, /metadata->'derived'->>'budget_sec'/);
});

test("the stamp binds the parameters it was given", () => {
  const sql = deadlineStampSql(7, 8);

  assert.ok(sql.includes("$7") && sql.includes("$8"));
  assert.ok(!sql.includes("$CHAT$") && !sql.includes("$DAG$"),
    "an unreplaced placeholder would reach the database as literal text");
});

test("the budget CASE is integer, so COALESCE can match the declared-budget arm", () => {
  // node-postgres sends untyped parameters. Postgres then infers a CASE whose
  // branches are all unknown as text, and COALESCE(integer, text) is 42804 --
  // which is how chat rows failed to insert, leaving sessions running with
  // nothing on claw_tasks for a sweeper to see.
  const insert = deadlineAtInsertSql({
    metadataParam: 27, originParam: 28, dagRootParam: 7, chatParam: 30, dagParam: 31,
  });
  const update = deadlineStampSql(7, 8);

  assert.match(insert, /THEN \$30::int/);
  assert.match(insert, /THEN \$31::int/);
  assert.match(insert, /ELSE \$31::int/);
  assert.match(update, /THEN \$7::int/);
  assert.match(update, /THEN \$8::int/);
  assert.match(update, /ELSE \$8::int/);
});

test("the insert stamp is the same rule, named against VALUES parameters", () => {
  // Chat rows never pass through transitionStatus, so the UPDATE stamp never
  // runs for them. This is how they still get a deadline.
  const sql = deadlineAtInsertSql({
    metadataParam: 27, originParam: 28, dagRootParam: 7, chatParam: 30, dagParam: 31,
  });

  assert.match(sql, /\$27::jsonb->'derived'->>'budget_sec'/);
  assert.match(sql, /\$28::text = 'chat'/);
  assert.match(sql, /\$7::text IS NULL/);
  assert.ok(sql.includes("$30") && sql.includes("$31"));
  assert.ok(!sql.includes("$CHAT$") && !sql.includes("@META@"));
});

test("the backstop leaves the run time to report its own ending first", () => {
  assert.ok(RUN_BUDGET_BACKSTOP_GRACE_SEC > 0,
    "with no gap the sweeper races the run and wins, and it cannot say what the run had done");
});
