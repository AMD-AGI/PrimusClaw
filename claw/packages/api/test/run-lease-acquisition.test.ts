// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Acceptance, renewal and takeover, run against a real Postgres.
 *
 * `run-lease-endpoint.test.ts` stubs `db.query` and matches the statement with
 * a regex, which proves a predicate was written and nothing about which rows it
 * matches. Everything here is about which rows: whether a generation actually
 * fences a stale attempt, whether a lapsed lease is takeable, whether an
 * acceptance really removes the receipt it says it removes. Those are the cases
 * a SQL-text assertion passes for the wrong reason.
 *
 * The route is the registered Fastify one and the schema is whatever `initDb`
 * produces, so a column this feature relies on and the migration never adds is
 * a failure here rather than a surprise in the cluster.
 */

import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";

import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
const TOKEN = "cluster-internal-token";

let cluster: PgCluster;
let observer: pg.Client;
let app: FastifyInstance;
let endPools: () => Promise<void>;

interface SeedRow {
  taskId: string;
  sessionId?: string;
  messageId?: string | null;
  status?: string;
  origin?: string;
  dispatch?: string | null;
  leaseOwner?: string | null;
  /** Seconds from now; negative is a lapsed lease, null is no lease at all. */
  leaseIn?: number | null;
  claimCount?: number;
  fenced?: boolean | null;
  receipt?: Record<string, unknown> | null;
}

async function seed(row: SeedRow): Promise<void> {
  const metadata: Record<string, unknown> = {};
  if (row.messageId !== null) metadata.message_id = row.messageId ?? "m-1";
  if (row.dispatch !== null) metadata.dispatch = row.dispatch ?? "fat";
  if (row.fenced !== null && row.fenced !== undefined) metadata.lease_fenced = row.fenced;
  if (row.receipt) metadata.dispatch_compensation = row.receipt;
  await observer.query(
    `INSERT INTO claw_tasks (
       task_id, session_id, name, status, origin, executor, metadata,
       claim_count, lease_owner, lease_expires_at
     ) VALUES (
       $1, $2, 'chat turn', $3, $4, 'brain', $5::jsonb, $6, $7,
       CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() + ($8::int * INTERVAL '1 second') END
     )`,
    [
      row.taskId, row.sessionId ?? "s-1", row.status ?? "preparing", row.origin ?? "chat",
      JSON.stringify(metadata), row.claimCount ?? 0, row.leaseOwner ?? null,
      row.leaseIn ?? null,
    ],
  );
}

async function taskRow(taskId: string): Promise<Record<string, unknown>> {
  const r = await observer.query(`SELECT * FROM claw_tasks WHERE task_id = $1`, [taskId]);
  assert.ok(r.rowCount, `no claw_tasks row ${taskId}`);
  return r.rows[0] as Record<string, unknown>;
}

async function lease(taskId: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/internal/tasks/${taskId}/lease`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: body,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** An acceptance, which is the first lease a fat delivery takes. */
const accept = (taskId: string, brainId: string, extra: Record<string, unknown> = {}) =>
  lease(taskId, { brain_id: brainId, lease_seconds: 45, accept: true, ...extra });

/** A renewal: no flag, and the generation the acceptance issued, if any. */
const renew = (taskId: string, brainId: string, runClaim?: number) =>
  lease(taskId, {
    brain_id: brainId, lease_seconds: 45,
    ...(runClaim === undefined ? {} : { run_claim: runClaim }),
  });

/** An old Brain's first lease: no flag, no generation, nothing held yet. */
const flaglessFirstLease = (taskId: string, brainId: string) => renew(taskId, brainId);

before(async () => {
  if (skip) return;
  cluster = await startPgCluster();
  process.env.DATABASE_URL = cluster.url;
  delete process.env.DB_SCHEMA;
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const db = await import("../src/infra/db.js");
  await db.initDb();
  endPools = async () => {
    await db.db.pool.end();
    await db.db.lockPool.end();
  };
  observer = await cluster.connect();
  const { registerInternalTaskRoutes } = await import("../src/routes/internal-tasks.js");
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await app.ready();
});

after(async () => {
  if (skip) return;
  await app.close();
  await endPools();
  await cluster.end();
});

beforeEach(async () => {
  if (skip) return;
  await observer.query("TRUNCATE claw_tasks");
});

describe("acceptance of a fat row nobody holds", () => {
  it_("acceptance of a pristine row writes the holder and the generation", async () => {
    await seed({
      taskId: "t-1",
      receipt: { version: 1, state: "armed", publish: "attempted" },
    });

    const res = await accept("t-1", "brain-7");

    assert.equal(res.status, 200);
    assert.equal(res.body.status, "preparing");
    assert.equal(res.body.claim_count, 1);
    const row = await taskRow("t-1");
    assert.equal(row.lease_owner, "brain-7");
    assert.ok(row.lease_expires_at, "an acceptance that writes no expiry is not a lease");
    assert.ok(row.heartbeat_at);
    assert.equal(row.claim_count, 1);
    const metadata = row.metadata as Record<string, unknown>;
    assert.equal(metadata.lease_fenced, true);
    assert.equal(metadata.dispatch_compensation, undefined,
      "the armed receipt is the one an acceptance is entitled to remove");
  });

  it_("acceptance leaves a receipt this deployment cannot act on in place", async () => {
    await seed({ taskId: "t-1", receipt: { version: 9, state: "armed" } });

    const res = await accept("t-1", "brain-7");

    assert.equal(res.status, 200);
    const metadata = (await taskRow("t-1")).metadata as Record<string, unknown>;
    assert.deepEqual(metadata.dispatch_compensation, { version: 9, state: "armed" });
  });

  it_("a legacy row with no dispatch marker accepts like a fat one", async () => {
    await seed({ taskId: "t-1", dispatch: null });

    const res = await accept("t-1", "brain-7");

    assert.equal(res.body.claim_count, 1);
    assert.equal((await taskRow("t-1")).lease_owner, "brain-7");
  });
});

describe("acceptance refused on a row that is already spoken for", () => {
  for (const undefinedTarget of [
    { name: "owner with no expiry", row: { leaseOwner: "brain-9", leaseIn: null } },
    { name: "expiry with no owner", row: { leaseOwner: null, leaseIn: 60 } },
    { name: "a generation with neither", row: { claimCount: 3 } },
    { name: "a live lease in another pod's name", row: { leaseOwner: "brain-9", leaseIn: 60, fenced: true, claimCount: 1 } },
    { name: "a live lease in this pod's name", row: { leaseOwner: "brain-7", leaseIn: 60, fenced: true, claimCount: 1 } },
    { name: "a cancelling row", row: { status: "cancelling" } },
    { name: "a queued row", row: { status: "queued" } },
  ]) {
    it_(`acceptance is refused for ${undefinedTarget.name}, changing nothing`, async () => {
      await seed({ taskId: "t-1", ...undefinedTarget.row });
      const before_ = await taskRow("t-1");

      const res = await accept("t-1", "brain-7");

      assert.equal(res.status, 409);
      assert.deepEqual(await taskRow("t-1"), before_);
    });
  }

});

describe("a lapsed lease, and the first lease a Brain that predates acceptance takes", () => {
  it_("a fully lapsed fenced lease is takeable by a caller that declares acceptance", async () => {
    await seed({
      taskId: "t-1", leaseOwner: "brain-9", leaseIn: -30, fenced: true, claimCount: 1,
      receipt: { version: 1, state: "armed", publish: "attempted" },
    });

    const res = await accept("t-1", "brain-8");

    assert.equal(res.status, 200);
    assert.equal(res.body.claim_count, 2, "a takeover increments the generation exactly once");
    const row = await taskRow("t-1");
    assert.equal(row.lease_owner, "brain-8");
    assert.equal((row.metadata as Record<string, unknown>).dispatch_compensation, undefined);
  });

  it_("a lapsed lease whose holder was never fenced is not takeable", async () => {
    // The row an API that predates the generation left behind: it has a holder
    // that cannot quote one, so its successor could not be told apart from it.
    await seed({ taskId: "t-1", leaseOwner: "brain-9", leaseIn: -30, claimCount: 1 });

    const res = await accept("t-1", "brain-8");

    assert.equal(res.status, 409);
    assert.equal((await taskRow("t-1")).lease_owner, "brain-9");
  });

  it_("a lapsed fenced lease is not takeable by an acceptance the route supplied", async () => {
    // An old Brain's first lease is bound to the acquisition path by the route,
    // not declared by the body, and only the declaration proves the caller will
    // be fenced and will quote the generation it is about to be issued.
    await seed({ taskId: "t-1", leaseOwner: "brain-9", leaseIn: -30, fenced: true, claimCount: 1 });

    const res = await flaglessFirstLease("t-1", "brain-8");

    assert.equal(res.status, 409);
    assert.equal((await taskRow("t-1")).lease_owner, "brain-9");
  });

  it_("an old Brain's first lease on a pristine fat row is an acceptance", async () => {
    await seed({
      taskId: "t-1", receipt: { version: 1, state: "armed", publish: "attempted" },
    });

    const res = await flaglessFirstLease("t-1", "brain-7");

    assert.equal(res.status, 200);
    assert.equal(res.body.claim_count, 1);
    const row = await taskRow("t-1");
    assert.equal(row.lease_owner, "brain-7");
    assert.equal((row.metadata as Record<string, unknown>).lease_fenced, false,
      "a caller that never declared acceptance will never quote a generation");
  });

  it_("an old Brain's first lease is refused on an owner-only row", async () => {
    await seed({ taskId: "t-1", leaseOwner: "brain-9", leaseIn: null });

    assert.equal((await flaglessFirstLease("t-1", "brain-8")).status, 409);
    assert.equal((await taskRow("t-1")).lease_owner, "brain-9");
  });

});

describe("renewal", () => {
  it_("a same-owner redelivery without the flag renews and moves nothing else", async () => {
    await seed({
      taskId: "t-1", leaseOwner: "brain-7", leaseIn: 5, fenced: true, claimCount: 1,
      receipt: { version: 1, state: "armed", publish: "attempted" },
    });

    const res = await renew("t-1", "brain-7", 1);

    assert.equal(res.status, 200);
    const row = await taskRow("t-1");
    assert.equal(row.claim_count, 1, "a renewal may not open a generation");
    assert.deepEqual((row.metadata as Record<string, unknown>).dispatch_compensation,
      { version: 1, state: "armed", publish: "attempted" });
    assert.ok(
      (row.lease_expires_at as Date).getTime() > Date.now() + 30_000,
      "the renewal has to have extended the lease it matched",
    );
  });

  it_("a renewal quoting no generation is honored on an unfenced row", async () => {
    await seed({ taskId: "t-1", leaseOwner: "brain-7", leaseIn: 5, fenced: false, claimCount: 1 });

    assert.equal((await renew("t-1", "brain-7")).status, 200);
  });

  it_("a renewal quoting no generation is refused on a fenced row", async () => {
    await seed({ taskId: "t-1", leaseOwner: "brain-7", leaseIn: 5, fenced: true, claimCount: 1 });

    const res = await renew("t-1", "brain-7");

    assert.equal(res.status, 409);
    assert.equal(res.body.reason, "superseded");
  });

  it_("a renewal is refused when the owner is null or names another pod", async () => {
    await seed({ taskId: "t-1", leaseOwner: null, leaseIn: 5, fenced: true, claimCount: 1 });
    assert.equal((await renew("t-1", "brain-7", 1)).status, 409);

    await observer.query("TRUNCATE claw_tasks");
    await seed({ taskId: "t-1", leaseOwner: "brain-9", leaseIn: 5, fenced: true, claimCount: 1 });
    assert.equal((await renew("t-1", "brain-7", 1)).status, 409);
  });
});

describe("the generation fence", () => {
  it_("a stale attempt cannot renew the lease its own pod took over", async () => {
    // `BRAIN_ID` is a pod name reused across claims, so after this pod takes a
    // lapsed row over from itself the previous attempt's heartbeat names the
    // owner the row recognises. Matching on owner alone renewed the successor's
    // lease and let the loser carry on running the same turn.
    await seed({
      taskId: "t-1", leaseOwner: "brain-7", leaseIn: -30, fenced: true, claimCount: 1,
    });
    const takeover = await accept("t-1", "brain-7");
    assert.equal(takeover.body.claim_count, 2);
    const successorLease = (await taskRow("t-1")).lease_expires_at as Date;

    const stale = await renew("t-1", "brain-7", 1);

    assert.equal(stale.status, 409);
    assert.equal(stale.body.reason, "superseded",
      "the loser has to be told the answer that makes it let go of everything");
    assert.deepEqual((await taskRow("t-1")).lease_expires_at, successorLease,
      "the stale attempt must not have extended its successor's lease");
    assert.equal((await renew("t-1", "brain-7", 2)).status, 200,
      "the successor's own renewal still has to work");
  });

  it_("an old API's acceptance leaves a row no successor can be created on", async () => {
    // The other half: an acceptance served by an API that predates the
    // generation returns none, so that holder's completion carries none either
    // and is admissible on any generation of the row. Nothing may take such a
    // row over, because a successor's row would then be closable by the
    // original holder's late completion.
    await seed({ taskId: "t-1", leaseOwner: "brain-7", leaseIn: -30, claimCount: 1 });

    assert.equal((await accept("t-1", "brain-8")).status, 409);
    assert.equal((await accept("t-1", "brain-7")).status, 409);
    const row = await taskRow("t-1");
    assert.equal(row.claim_count, 1, "no successor generation may exist on an unfenced row");
    assert.equal(row.lease_owner, "brain-7");
  });
});

describe("one holder per logical message", () => {
  it_("a sibling carrying holder evidence refuses the acceptance as superseded", async () => {
    // Durable evidence, not current: the sibling below has finished, and its
    // lease and generation are the record that this logical message was
    // already someone's. A second row accepting on top of it is the second
    // holder the invariant exists to make impossible.
    await seed({
      taskId: "t-holder", messageId: "m-1", status: "completed",
      leaseOwner: "brain-9", leaseIn: 60, fenced: true, claimCount: 1,
    });
    await seed({ taskId: "t-replay", messageId: "m-1" });
    const holder = await taskRow("t-holder");

    const res = await accept("t-replay", "brain-7");

    assert.equal(res.status, 409);
    assert.equal(res.body.reason, "superseded");
    assert.equal((await taskRow("t-replay")).lease_owner, null);
    assert.deepEqual(await taskRow("t-holder"), holder);
  });

  it_("a claim count alone on the sibling is holder evidence", async () => {
    // What `requeueLostDoorbellLeases` leaves: queued, holder columns cleared,
    // the generation intact. It records that a worker once held the message.
    await seed({ taskId: "t-holder", messageId: "m-1", status: "queued", claimCount: 2 });
    await seed({ taskId: "t-replay", messageId: "m-1" });

    assert.equal((await accept("t-replay", "brain-7")).status, 409);
  });

  it_("a row with no message_id is exempt from the sibling test", async () => {
    await seed({ taskId: "t-holder", messageId: null, leaseOwner: "brain-9", leaseIn: 60, claimCount: 1 });
    await seed({ taskId: "t-other", messageId: null });

    assert.equal((await accept("t-other", "brain-7")).status, 200);
  });
});

describe("everything outside the fat set", () => {
  it_("a doorbell row renews and takes over without gaining a generation", async () => {
    await seed({
      taskId: "t-1", dispatch: "doorbell", status: "running",
      leaseOwner: "brain-9", leaseIn: -30, claimCount: 4,
    });

    const res = await flaglessFirstLease("t-1", "brain-8");

    assert.equal(res.status, 200);
    assert.equal(res.body.claim_count, undefined);
    const row = await taskRow("t-1");
    assert.equal(row.lease_owner, "brain-8");
    assert.equal(row.claim_count, 4, "the doorbell path owns its own claim counting");
  });

  it_("a non-chat task keeps today's behavior, receipt included", async () => {
    await seed({
      taskId: "t-1", origin: "api", dispatch: null, status: "running",
      leaseOwner: null, leaseIn: null,
      receipt: { version: 1, state: "armed", publish: "attempted" },
    });

    const res = await flaglessFirstLease("t-1", "brain-8");

    assert.equal(res.status, 200);
    const row = await taskRow("t-1");
    assert.equal(row.lease_owner, "brain-8");
    assert.equal(row.claim_count, 0);
    assert.deepEqual((row.metadata as Record<string, unknown>).dispatch_compensation,
      { version: 1, state: "armed", publish: "attempted" });
  });
});

/**
 * `node:test` has no per-`describe` skip that also reports why, and a suite
 * that skips silently is indistinguishable from one that proved something.
 */
function it_(name: string, fn: () => Promise<void>): void {
  test(name, { skip }, fn);
}
