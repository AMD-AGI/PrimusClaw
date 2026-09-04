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

test("a rebuild from an INVALID index says so", () => {
  // Postgres cannot resume an interrupted concurrent build, so this path throws
  // away whatever the last attempt achieved. That is not visible from the
  // outside unless it is logged, and a boot that quietly restarts a half-hour
  // index build is the kind of thing an operator finds out about from latency.
  assert.match(FN, /db\.concurrent_index_rebuilding_from_invalid/);
});
