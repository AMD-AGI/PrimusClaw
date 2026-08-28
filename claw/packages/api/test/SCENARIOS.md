# Row-level scenarios

`doorbell-scenario.test.ts` runs against a real Postgres — PGlite, Postgres
compiled to WASM — instead of a stubbed `db.query`. `scenario-harness.ts` boots
it, creates the tables and points `db.query` at them.

## Why they exist

The other tests in this directory assert on the SQL *text* a statement builds:
they replace `db.query` with a recorder and match the statement with a regex.
That catches a predicate that was never written. It cannot catch a predicate
that *is* written and matches the wrong rows — the statement still contains
every string the regex looks for.

Most of the run-doorbell defects were that second shape. `reapStuckSessions`
grew a `NOT EXISTS` that reads correctly and matches one row class too many;
`interruptUnstartedChatRuns` matched `preparing` with a null lease owner, which
is a live fat-path run for the first seconds of every turn; `takeClaim` had
nothing stopping two rows for one `message_id` from both executing. All of them
pass a text assertion.

So these scenarios execute the statements and assert on the rows left behind.
They are part of `npm test` for the same reason: a suite that guards six fixes
is worth nothing if it is a file nobody runs. Reverting any one of those fixes
should turn this file red — that is the check to make when adding to it.

## Adding a scenario

The harness DDL is a hand-copied subset of `src/db.ts`, and that is its
standing hazard: a column the real table has and the harness omits, or names
differently, turns a statement into a silent failure and the scenario passes
for the wrong reason. `claw_workspace_refs` did exactly that — its key column
was `kind` here and `ref_kind` in `db.ts`, so every `releaseRunUse` threw and
was swallowed. When a scenario reaches a new table, copy its columns from
`db.ts` rather than writing what the scenario happens to need.

`seedRun(..., { claimable: true })` seals a real credentials blob onto the row,
which a scenario needs whenever the code under test goes through a claim —
without it `hydrateExecuteRequest` throws and the claim comes back
`unclaimable`, which is easy to mistake for the outcome being tested.

## What they do not cover

There is no NATS here, no Brain, and no concurrency. A scenario proves that a
given row state leads to a given row state. Delivery, redelivery, timing
between replicas, and what a worker does with a claim it has taken are
properties of the live environment and are tested there.
