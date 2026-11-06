// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A leader lock held on a connection made before a failover this process noticed is lost, against a real Postgres.
 *
 * A failover demotes the old primary in place, and a lock connection that reached it can stay connected: the lock it
 * holds there fences nothing on the new primary, where another replica takes the same lock. Nothing on that connection
 * says so. What says so is the failover generation db.ts advances when any connection meets a failover error, so a
 * hold whose connection predates it must be reported lost: in the lease a scan checks, in the verdict, and while the
 * scan runs. Skipped without DATABASE_URL; a skip is not a pass.
 *
 * Coverage:
 *   F1 a failover noticed mid-hold ends the lease and the pass throws LeadershipLostError
 *   F2 a hold on a connection made after the failover is not lost, and runs as before
 */
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import test, { after, describe } from "node:test";

import { db, noteFailover } from "../src/infra/db.js";
import { LeadershipLostError, withLeaderLock } from "../src/infra/leader-lock.js";
import { postgresSkipReason } from "./support/pg-cluster.js";

const skip = postgresSkipReason();

describe("leader lock across a failover", { skip }, () => {
  after(async () => {
    await db.pool.end().catch(() => {});
    await db.lockPool.end().catch(() => {});
  });
  const failover = () => noteFailover(Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }));
  const lockId = () => 8_264_179_299_000 + randomInt(1_000);

  test("F1 a failover noticed mid-hold ends the lease, and the pass is not called exclusive", async () => {
    const id = lockId();
    let before: Error | undefined;
    let afterIt: Error | undefined;
    let ranOn = false;
    await assert.rejects(
      withLeaderLock(id, "test-failover", async (lease) => {
        before = lease.lost();
        // Noticed on some other connection: this one is still up, and still answers.
        failover();
        afterIt = lease.lost();
        ranOn = true;
        return 1;
      }),
      (err: unknown) => err instanceof LeadershipLostError && /failover/.test(err.lostBy.message),
    );
    assert.equal(before, undefined, "held until the failover");
    assert.ok(afterIt, "the lease says the hold ended");
    assert.equal(ranOn, true);
  });

  test("F2 a hold on a connection made after the failover runs as before", async () => {
    failover();
    const out = await withLeaderLock(lockId(), "test-after-failover", async (lease) => {
      assert.equal(lease.lost(), undefined);
      return (await db.query("SELECT 1 AS one")).rows[0].one as number;
    });
    assert.deepEqual(out, { ran: true, result: 1 });
  });
});
