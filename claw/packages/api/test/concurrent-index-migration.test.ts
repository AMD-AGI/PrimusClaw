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

import {
  RUN_CLAIM_FENCE_LOCK_ID,
  RUN_CLAIM_FENCE_SQL,
  ensureChatTurnClaimIndex,
  ensureConcurrentIndexOrWarn,
} from "../src/infra/db.js";

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
  assert.match(SRC, /refusing to serve: \$\{name\} is/);
  assert.match(SRC, /assertUniqueIndexValid\(\s*q,\s*CHAT_TURN_CLAIM_INDEX/);
  // The A2A execution index carries the same class of invariant -- one counted
  // row per execution -- so it is asserted rather than warned about too.
  assert.match(SRC, /assertUniqueIndexValid\(\s*client,\s*A2A_EXECUTION_INDEX/);
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

test("the fence covers the reconcile, and is released before the build", () => {
  // Holding it across the build is not a stronger guarantee, it is a lock
  // cycle. CREATE INDEX CONCURRENTLY waits out every transaction holding a
  // write lock on claw_tasks, and a claim blocked on the fence is one of them:
  // its UPDATE takes the table's RowExclusiveLock during parse analysis, before
  // the fence conjunct in its WHERE is evaluated. So the build would wait on
  // the claim and the claim on the build's own fence, and Postgres would break
  // the tie by killing one -- a migration crashloop, or fleet-wide claim
  // failures for the length of the build.
  assert.match(CHAT_TURN_FN, /pg_advisory_lock\(\$1\)", \[RUN_CLAIM_FENCE_LOCK_ID\]/);
  assert.match(CHAT_TURN_FN, /pg_advisory_unlock\(\$1\)", \[RUN_CLAIM_FENCE_LOCK_ID\]/);
  const lockAt = CHAT_TURN_FN.indexOf("pg_advisory_lock");
  const unlockAt = CHAT_TURN_FN.indexOf("pg_advisory_unlock");
  const reconcileAt = CHAT_TURN_FN.indexOf("reconcileDuplicateChatTurns");
  const buildAt = CHAT_TURN_FN.indexOf("ensureConcurrentIndex");
  assert.ok(lockAt < reconcileAt && reconcileAt < unlockAt && unlockAt < buildAt,
    "the reconcile happens inside the hold and the build strictly after it");
  assert.match(CHAT_TURN_FN, /finally \{/, "and the fence is released whatever happens");
});

test("the reconcile's own wait is bounded, because it holds the fence", () => {
  // Moving the build out leaves a narrower version of the same cycle: a claim
  // blocked on the fence on the admission-lock path is holding a `FOR UPDATE`
  // tuple lock, and the reconcile's UPDATE may want that very row. An unbounded
  // wait there relocates the deadlock rather than removing it.
  assert.match(CHAT_TURN_FN, /SET lock_timeout = \$\{RECONCILE_LOCK_TIMEOUT_MS\}/,
    "the reconcile waits on a budget");
  assert.match(CHAT_TURN_FN, /finally\s*\{[\s\S]*RESET lock_timeout/,
    "and gives the session's default back in a finally");
  const lockTimeoutAt = CHAT_TURN_FN.indexOf("SET lock_timeout");
  const buildAt = CHAT_TURN_FN.indexOf("ensureConcurrentIndex");
  assert.ok(lockTimeoutAt < buildAt,
    "and the budget is scoped to the reconcile, not imposed on a half-hour build");
});

test("a build lost to a racing claim is retried, and only a lock wait retries the reconcile", () => {
  // CREATE UNIQUE INDEX CONCURRENTLY that meets a duplicate does not return an
  // invalid index, it raises 23505 and leaves one behind -- so a loop that only
  // re-read validity would never run a second attempt. The build call has to be
  // inside a catch for the retry to exist at all.
  assert.match(CHAT_TURN_FN, /for \(let attempt = 1; attempt <= CHAT_TURN_INDEX_ATTEMPTS; attempt\+\+\)/);
  assert.match(CHAT_TURN_FN, /db\.chat_turn_index_build_retry/, "the build is caught and retried");
  // And the reconcile is not: it refuses a turn two live executions hold, and
  // that refusal is the one error an operator has to read.
  assert.match(CHAT_TURN_FN, /CLAIM_FENCE_RETRY_CODES\.has\(/);
  assert.match(SRC, /const CLAIM_FENCE_RETRY_CODES = new Set\(\["55P03", "40P01"\]\)/,
    "lock_not_available and deadlock_detected, and nothing else");
  assert.ok(
    CHAT_TURN_FN.indexOf("throw err") < CHAT_TURN_FN.indexOf("db.chat_turn_reconcile_retry"),
    "anything that is not a lock wait leaves the function",
  );
});

test("exhausting the attempts reports rather than aborting the migration", () => {
  // Same reasoning as ensureConcurrentIndex's warn-not-throw ending: a throw
  // here would skip the ~200 lines of DDL below and assertSchema with them, and
  // assertSchema is the check that catches exactly this state.
  assert.match(CHAT_TURN_FN, /db\.chat_turn_index_attempts_exhausted/);
  assert.ok(
    !/throw new Error/.test(CHAT_TURN_FN),
    "the boot is refused by assertChatTurnClaimIndex, not by the builder",
  );
});

test("but an already-valid index is recognised before the fence is taken", () => {
  // The hold above is exclusive and every claim takes the fence shared, so a
  // boot that takes it stalls the fleet's claims until it lets go. This
  // function runs on every boot -- restart, scale-up, rolling deploy -- and on
  // all but the migration boot it has nothing to build. Probing first keeps
  // the stall on the boots that are actually building something.
  //
  // A source assertion, as the rest of this file is: the function is internal
  // to db.ts and its cost is an ordering, not a return value.
  const probeAt = CHAT_TURN_FN.indexOf("readIndexValidity");
  const lockAt = CHAT_TURN_FN.indexOf("pg_advisory_lock");
  assert.ok(probeAt >= 0, "the validity of the index is read");
  assert.ok(probeAt < lockAt, "and read before the fence, or the probe saves nothing");
  assert.match(
    CHAT_TURN_FN.slice(probeAt, lockAt),
    /indisvalid\) return;/,
    "a valid index ends the call rather than falling through to the fence",
  );
});

test("the claim path's fence is shared and statement-scoped", () => {
  // takeClaim opens no transaction of its own, so a lock taken by a preceding
  // statement would already be released by the time its UPDATE runs.
  assert.match(SRC, /export const RUN_CLAIM_FENCE_SQL =\s*\n?\s*`pg_advisory_xact_lock_shared/);
  // Asserted on the live values rather than on the source text, because both
  // ids are now mixed with the schema name: advisory locks share one namespace
  // per database, so a fixed id would make two deployments sharing one database
  // serialise their migrations and index builds against each other.
  assert.notEqual(
    RUN_CLAIM_FENCE_LOCK_ID,
    Number(/schemaScopedLockId\(([\d_]+)\);/.exec(SRC)?.[1]?.replace(/_/g, "")),
    "the fence must not reuse the migration lock, which claims never take",
  );
  assert.ok(RUN_CLAIM_FENCE_SQL.includes(String(RUN_CLAIM_FENCE_LOCK_ID)));
});

test("a rebuild from an INVALID index says so", () => {
  // Postgres cannot resume an interrupted concurrent build, so this path throws
  // away whatever the last attempt achieved. That is not visible from the
  // outside unless it is logged, and a boot that quietly restarts a half-hour
  // index build is the kind of thing an operator finds out about from latency.
  assert.match(FN, /db\.concurrent_index_rebuilding_from_invalid/);
});

// A build that *raises* never reaches the warn above: the error leaves through
// the `finally` that restores the timeout, out of initDb, and out of main()
// into process.exit(1) -- with the remaining DDL unapplied and assertSchema,
// the check written for exactly that state, never run. These drive the wrapper
// rather than the source text, because the thing at stake is which errors it
// lets past, and a grep of the body cannot tell.

/** A client that answers every statement, except the ones a test names. */
function fakeClient(raise?: { on: RegExp; err: Error }) {
  const seen: string[] = [];
  return {
    seen,
    client: {
      query: async (text: string) => {
        seen.push(text.trim());
        if (raise && raise.on.test(text)) throw raise.err;
        return { rows: [], rowCount: 0 };
      },
    } as never,
  };
}

test("a build that raises is reported, and the migration carries on", async () => {
  // 57014 is the ending this function's own ceiling is sized against, and the
  // one the file's comments anticipate; 40P01 and 53100 arrive the same way.
  const { seen, client } = fakeClient({
    on: /CREATE INDEX CONCURRENTLY/,
    err: Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    }),
  });
  await assert.doesNotReject(
    () => ensureConcurrentIndexOrWarn(client, "idx_x", "CREATE INDEX CONCURRENTLY idx_x ON t(a)"),
    "the statements below it in initDb still run",
  );
  const timeouts = seen.filter((t) => t.startsWith("SET statement_timeout"));
  assert.equal(timeouts.length, 2, "the ceiling is raised for the build and given back");
  assert.notEqual(timeouts[0], timeouts[1], "given back to the migration's own budget");
  assert.equal(seen.at(-1), timeouts[1],
    "and given back after the raise, not skipped by it");
});

test("but a caller bug still stops the process", async () => {
  // The name guard is not a data condition: it catches an identifier that was
  // about to be interpolated into DDL unvalidated. Reporting that one and
  // booting is the outcome this wrapper must not produce.
  const { seen, client } = fakeClient();
  await assert.rejects(
    () => ensureConcurrentIndexOrWarn(client, "bad-name", "CREATE INDEX CONCURRENTLY x ON t(a)"),
    /unsafe index name/,
  );
  assert.deepEqual(seen, [], "and it stops before issuing anything");
});

test("every index initDb builds concurrently goes through the wrapper", () => {
  // The wrapper is defined above initDb on purpose, so this slice sees the
  // migration's own call sites and not the wrapper's own delegation -- nor
  // ensureChatTurnClaimIndex's, which catches the throw itself to drive its
  // retry and would be silently reduced to a single pass by the swallow here.
  const INIT = SRC.slice(SRC.indexOf("export async function initDb"));
  assert.equal([...INIT.matchAll(/await ensureConcurrentIndex\(/g)].length, 0,
    "no call site in the migration may let a raised build abort it");
  assert.equal([...INIT.matchAll(/await ensureConcurrentIndexOrWarn\(/g)].length, 3);
  assert.match(CHAT_TURN_FN, /await ensureConcurrentIndex\(/,
    "the chat-turn builder is the exception, and catches the throw itself");
  assert.match(SRC, /db\.concurrent_index_build_failed/, "the reported ending is named");
});

/**
 * The fence path, driven statement by statement.
 *
 * `ensureChatTurnClaimIndex` runs in the middle of `initDb`, roughly two
 * hundred lines of DDL and `assertSchema` below it, and every ending asserted
 * here is about what it does to that sequence rather than about the index.
 */
function fenceClient(opts: {
  raise?: { on: RegExp; err: unknown };
  answers?: Array<[RegExp, Array<Record<string, unknown>>]>;
} = {}): { seen: string[]; client: pgPoolClient } {
  const seen: string[] = [];
  return {
    seen,
    client: {
      query: async (text: string) => {
        const sql = text.replace(/\s+/g, " ").trim();
        seen.push(sql);
        if (opts.raise?.on.test(sql)) throw opts.raise.err;
        for (const [re, rows] of opts.answers ?? []) {
          if (re.test(sql)) return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    } as never,
  };
}
type pgPoolClient = Parameters<typeof ensureChatTurnClaimIndex>[0];

const ATTEMPTS = Number(/CHAT_TURN_INDEX_ATTEMPTS = (\d+)/.exec(SRC)![1]);
const BUILD = /CREATE UNIQUE INDEX CONCURRENTLY/;
const AMBIGUOUS_PROBE = /HAVING COUNT\(\*\) FILTER/;

test("a turn two executions hold refuses to serve without aborting the migration", async () => {
  // The reconcile's refusal is a plain Error with no `code`, so the retry
  // classifier rethrows it -- and from here that throw leaves `initDb`, taking
  // the remaining DDL and `assertSchema` with it. That is the half-run
  // migration the two catches around the build exist to prevent, reached by the
  // one path neither of them covers. The refusal itself is not lost: nothing
  // builds the index, so assertChatTurnClaimIndex refuses at the end instead,
  // with the whole schema applied.
  const { seen, client } = fenceClient({
    answers: [[AMBIGUOUS_PROBE, [{ session_id: "s1", message_id: "m1" }]]],
  });

  await assert.doesNotReject(
    () => ensureChatTurnClaimIndex(client),
    "the DDL below this call, and the schema check at the end, still run",
  );
  assert.ok(!seen.some((t) => BUILD.test(t)),
    "and nothing builds a uniqueness index over a turn it has just refused");
  assert.equal(
    seen.filter((t) => t.startsWith("SELECT pg_advisory_lock")).length, 1,
    "the refusal is reported once rather than retried, so the one error an "
    + "operator has to read is not buried under two more copies",
  );
  assert.equal(
    seen.filter((t) => t.startsWith("SELECT pg_advisory_unlock")).length, 1,
    "and the fence is let go on the way out, or every claim in the fleet stalls",
  );
});

test("a lock ceiling the reconcile could not give back is not inherited by the build", async () => {
  // The reconcile borrows a five-second lock_timeout. The RESET that gives it
  // back was allowed to fail silently on the grounds that the next statement
  // would fail loudly -- but the next statement is the concurrent build, which
  // sets statement_timeout and never touches lock_timeout. It would run a
  // build sized for thirty minutes under a five-second ceiling, raise 55P03,
  // and have it read as a build failure: three drop-and-rebuild attempts
  // chasing a setting this function leaked.
  const { seen, client } = fenceClient({
    raise: {
      on: /^RESET lock_timeout$/,
      err: Object.assign(new Error("canceling statement due to user request"), {
        code: "57014",
      }),
    },
  });

  await assert.doesNotReject(() => ensureChatTurnClaimIndex(client));
  assert.equal(seen.filter((t) => BUILD.test(t)).length, 0,
    "no build may start under a ceiling this function set and cannot prove it gave back");
  assert.equal(
    seen.filter((t) => t.startsWith("SET lock_timeout")).length, ATTEMPTS,
    "each attempt issues the SET and the RESET again, so a failed restore is "
    + "recoverable rather than terminal",
  );
});

test("a reconcile that lost a row lock is still retried, and still builds", async () => {
  // The lock-wait classes are the ones this loop exists for, and narrowing the
  // rethrow above must not have narrowed them too.
  let first = true;
  const seen: string[] = [];
  const client = {
    query: async (text: string) => {
      const sql = text.replace(/\s+/g, " ").trim();
      seen.push(sql);
      if (AMBIGUOUS_PROBE.test(sql) && first) {
        first = false;
        throw Object.assign(new Error("canceling statement due to lock timeout"), {
          code: "55P03",
        });
      }
      if (/SELECT i.indisvalid/.test(sql) && !first) {
        return { rows: [{ indisvalid: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as never as pgPoolClient;

  await assert.doesNotReject(() => ensureChatTurnClaimIndex(client));
  assert.equal(seen.filter((t) => t.startsWith("SELECT pg_advisory_lock")).length, 2,
    "the second attempt is what 55P03 asks for");
});
