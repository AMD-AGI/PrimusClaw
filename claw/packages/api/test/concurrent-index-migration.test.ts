// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// concurrent-index-migration.test.ts
//
// ensureConcurrentIndex was the only DDL in initDb that threw. Every other
// index is created with `.catch(() => {})`, because an index is a performance
// property and a migration that stops halfway is a correctness one -- and the
// two call sites sit ~230 lines of DDL above assertSchema, the check that
// exists to catch exactly the incomplete state a throw there produces.
//
// The failure was also self-perpetuating. The migration session sets one
// statement_timeout for everything; a CREATE INDEX CONCURRENTLY that exceeds it
// leaves an INVALID index, and the next boot drops it and rebuilds from zero.
// A table too large to finish in one window never finishes in any of them.
//
// Nothing covered this file. These drive the source, because the function is
// module-private and its contract here is about which statements it issues.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/infra/db.ts", import.meta.url), "utf8");
const FN = SRC.slice(
  SRC.indexOf("async function ensureConcurrentIndex"),
  SRC.indexOf("/** Run schema migrations on startup. */"),
);

test("an index that will not come back valid is reported, not thrown", () => {
  // The whole point: a missing index makes one sweep slower, a half-run
  // migration makes the deployment wrong. Throwing chose the second.
  assert.ok(
    !/throw new Error\(`index \$\{name\} was not created as a valid index`\)/.test(FN),
    "the validity check must not abort the migration",
  );
  assert.match(FN, /db\.concurrent_index_not_valid/, "it must say so instead");
});

test("the name guard still throws, because that one is not a data condition", () => {
  // An unsafe identifier is interpolated straight into DDL. That is a caller
  // bug and has to stop the process; loosening it along with the rest would
  // turn this hardening into an injection point.
  assert.match(FN, /throw new Error\(`unsafe index name/, "the name guard stays fatal");
});

test("a concurrent build gets its own ceiling, and gives it back", () => {
  // The migration timeout is sized for ordinary DDL. A CIC scans the table
  // twice and waits out older transactions, so its runtime is a property of the
  // data -- and exceeding the migration timeout is what produced the INVALID
  // index in the first place.
  assert.match(FN, /SET statement_timeout = \$\{CONCURRENT_INDEX_TIMEOUT_MS\}/,
    "raised for the build");
  assert.match(FN, /finally\s*\{[\s\S]*SET statement_timeout = \$\{MIGRATION_STATEMENT_TIMEOUT_MS\}/,
    "and restored in a finally, so a failed build does not leave the session wide open");
  assert.match(SRC, /CONCURRENT_INDEX_TIMEOUT_MS\s*=\s*\n?\s*Number\(process\.env\.PG_CONCURRENT_INDEX_TIMEOUT_MS\)/,
    "and it is configurable, because the right value is a property of the table");
});

test("the ceiling is larger than the migration timeout it replaces", () => {
  // A ceiling at or below the migration timeout would change nothing: the build
  // would still be cut off at the same point, and still leave an INVALID index.
  const conc = /PG_CONCURRENT_INDEX_TIMEOUT_MS\) \|\| ([\d *_]+);/.exec(SRC);
  const mig = /envInt\("PG_MIGRATION_STATEMENT_TIMEOUT_MS", ([\d_]+)\)/.exec(SRC);
  assert.ok(conc, "the concurrent ceiling must have a default");
  assert.ok(mig, "the migration timeout must have a default");
  const val = (m: string) =>
    m.replace(/_/g, "").split("*").map(Number).reduce((a, b) => a * b, 1);
  assert.ok(val(conc[1]) > val(mig[1]),
    `concurrent ceiling ${val(conc[1])}ms must exceed migration timeout ${val(mig[1])}ms`);
});

const CHAT_TURN_FN = SRC.slice(
  SRC.indexOf("async function ensureChatTurnClaimIndex"),
  SRC.indexOf("/** Run schema migrations on startup. */"),
);
const RECONCILE_FN = SRC.slice(
  SRC.indexOf("async function reconcileDuplicateChatTurns"),
  SRC.indexOf("async function ensureChatTurnClaimIndex"),
);

test("the chat-turn index is built through the helper, not hand-rolled", () => {
  // `CREATE ... IF NOT EXISTS` matches an INVALID object for ever, so a
  // hand-rolled statement would make one interrupted boot permanent -- and this
  // is the index a claim's correctness depends on.
  assert.match(CHAT_TURN_FN, /await ensureConcurrentIndex\(/);
  assert.match(CHAT_TURN_FN, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/);
});

test("the chat-turn index is restricted to the rows the sibling guard reads", () => {
  // Without `origin = 'chat'` the index would also constrain DAG and a2a rows,
  // which takeClaim's sibling clause never looks at.
  assert.match(SRC, /const ACTIVE_CHAT_TURN_SQL = `origin = 'chat'/);
  assert.match(SRC, /metadata->>'message_id' IS NOT NULL/);
  assert.match(SRC, /status IN \('preparing','running','cancelling'\)/);
});

test("an invalid chat-turn index refuses startup rather than warning", () => {
  // ensureConcurrentIndex ends in a warn, which is right for a performance
  // index and wrong for the one carrying a correctness invariant.
  assert.match(SRC, /export async function assertChatTurnClaimIndex/);
  assert.match(SRC, /refusing to serve: \$\{CHAT_TURN_CLAIM_INDEX\}/);
  const assertFn = SRC.slice(
    SRC.indexOf("async function assertSchema"),
    SRC.indexOf("* Refuse to serve unless the chat-turn"),
  );
  assert.match(assertFn, /throw new Error\(`database schema is incomplete/,
    "a missing column still refuses startup");
  assert.match(assertFn, /await assertChatTurnClaimIndex\(client\)/,
    "and so does an index that cannot enforce the invariant");
});

test("reconciliation keeps the holder and refuses two of them", () => {
  // Picking by recency alone keeps a retried dispatch's unclaimed spare and
  // closes the row that is executing.
  assert.match(RECONCILE_FN, /ORDER BY \$\{TURN_HOLDER_SQL\} DESC, created_at DESC/);
  assert.match(RECONCILE_FN, /HAVING COUNT\(\*\) FILTER \(WHERE \$\{TURN_HOLDER_SQL\}\) > 1/);
  assert.match(RECONCILE_FN, /throw new Error\(\s*"refusing to serve: more than one active row/);
  assert.ok(
    RECONCILE_FN.indexOf("throw new Error") < RECONCILE_FN.indexOf("UPDATE claw_tasks"),
    "the refusal must come before anything is closed",
  );
});

test("the reconcile and the build share one exclusive hold of the claim fence", () => {
  // Two separate holds would leave a window in which a serving replica claims a
  // turn between them, and the build then arrives INVALID.
  assert.match(CHAT_TURN_FN, /pg_advisory_lock\(\$1\)", \[RUN_CLAIM_FENCE_LOCK_ID\]/);
  assert.match(CHAT_TURN_FN, /pg_advisory_unlock\(\$1\)", \[RUN_CLAIM_FENCE_LOCK_ID\]/);
  const lockAt = CHAT_TURN_FN.indexOf("pg_advisory_lock");
  const unlockAt = CHAT_TURN_FN.indexOf("pg_advisory_unlock");
  const reconcileAt = CHAT_TURN_FN.indexOf("reconcileDuplicateChatTurns");
  const buildAt = CHAT_TURN_FN.indexOf("ensureConcurrentIndex");
  assert.ok(lockAt < reconcileAt && reconcileAt < buildAt && buildAt < unlockAt,
    "reconcile and build both happen inside the one hold");
  assert.match(CHAT_TURN_FN, /finally \{/, "and the fence is released whatever happens");
});

test("the claim path's fence is shared and statement-scoped", () => {
  // takeClaim opens no transaction of its own, so a lock taken by a preceding
  // statement would already be released by the time its UPDATE runs.
  assert.match(SRC, /export const RUN_CLAIM_FENCE_SQL =\s*\n?\s*`pg_advisory_xact_lock_shared/);
  assert.notEqual(
    /RUN_CLAIM_FENCE_LOCK_ID = ([\d_]+)/.exec(SRC)?.[1],
    /SCHEMA_MIGRATION_LOCK_ID = ([\d_]+)/.exec(SRC)?.[1],
    "the fence must not reuse the migration lock, which claims never take",
  );
});

test("a rebuild from an INVALID index says so", () => {
  // Postgres cannot resume an interrupted concurrent build, so this path throws
  // away whatever the last attempt achieved. That is not visible from the
  // outside unless it is logged, and a boot that quietly restarts a half-hour
  // index build is the kind of thing an operator finds out about from latency.
  assert.match(FN, /db\.concurrent_index_rebuilding_from_invalid/);
});
