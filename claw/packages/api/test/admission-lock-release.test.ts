// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the admission helpers do with a connection whose ROLLBACK failed.
 *
 * Both of them hold `pg_advisory_xact_lock(ADMISSION_LOCK_KEY)`, the one gate
 * every create, retry, expansion and claim in the fleet passes through, and
 * Postgres releases that lock only when the transaction holding it ends. So a
 * connection handed back to the pool still inside an unfinished transaction is
 * not an untidy connection: it is the fleet's admission gate held shut by
 * nobody, until `idle_in_transaction_session_timeout` kills the session or the
 * pool lends it out and the next caller's BEGIN joins the transaction instead
 * of starting one.
 *
 * `inTransaction` in infra/db.ts already destroys the connection in this case.
 * These pin that the two helpers here do, because the argument for it is
 * stronger, not weaker.
 *
 * Driven through a stubbed pool rather than a server: what is under test is the
 * argument `release` is called with, and no real Postgres makes ROLLBACK fail
 * on demand.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import { withAdmissionTransaction, withOwnedAdmissionLock } from "../src/tasks/admission.js";

/** A pool whose one connection refuses the statements a test names. */
function stubPool(refuse?: RegExp): {
  seen: string[];
  released: unknown[];
  restore: () => void;
} {
  const original = db.pool.connect;
  const seen: string[] = [];
  const released: unknown[] = [];
  db.pool.connect = (async () => ({
    query: async (text: string) => {
      seen.push(text);
      if (refuse?.test(text)) throw new Error(`refused: ${text}`);
      return { rows: [], rowCount: 0 };
    },
    release: (arg?: unknown) => { released.push(arg); },
  })) as unknown as typeof db.pool.connect;
  return { seen, released, restore: () => { db.pool.connect = original; } };
}

test("an owned hold whose rollback failed destroys its connection", async () => {
  const pool = stubPool(/^ROLLBACK$/);
  try {
    await assert.rejects(
      () => withOwnedAdmissionLock(async () => { throw new Error("boom"); }),
      /boom/,
      "the caller's failure is still what is reported",
    );
  } finally {
    pool.restore();
  }
  assert.ok(pool.seen.includes("ROLLBACK"), "it did try to end the transaction");
  assert.deepEqual(
    pool.released, [true],
    "and having failed to, it discards the connection: returning it leaves the fleet's "
    + "admission lock held by a transaction nothing will ever finish",
  );
});

test("the caller-decided variant does the same, because it takes the same lock", async () => {
  const pool = stubPool(/^ROLLBACK$/);
  try {
    await assert.rejects(
      () => withAdmissionTransaction(async () => ({ commit: false, value: 1 })),
      /refused: ROLLBACK/,
      "a refusal it cannot roll back is not a refusal it may report as applied",
    );
  } finally {
    pool.restore();
  }
  assert.deepEqual(pool.released, [true]);
});

test("a connection that did end its transaction goes back to the pool", async () => {
  // The other half, and a guard against over-correcting rather than a
  // regression: destroying a healthy connection on every refusal would turn a
  // queued run into a reconnect, on the path every admission decision takes.
  // Asserted on the truth of the argument and not its exact value, because
  // "not destroyed" is what the pool reads and both `false` and an absent
  // argument say it.
  const owned = stubPool();
  try {
    await assert.rejects(
      () => withOwnedAdmissionLock(async () => { throw new Error("boom"); }), /boom/,
    );
  } finally {
    owned.restore();
  }
  assert.equal(owned.released.length, 1);
  assert.ok(!owned.released[0], "rolled back cleanly, so it is reusable");

  const committed = stubPool();
  try {
    assert.equal(await withOwnedAdmissionLock(async () => 7), 7);
  } finally {
    committed.restore();
  }
  assert.ok(!committed.released[0]);
  assert.deepEqual(committed.seen, ["BEGIN", "COMMIT"]);
});
