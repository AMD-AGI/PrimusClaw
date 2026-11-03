// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The outstanding-ticket cap under real concurrency, on a real Postgres.
 *
 * Counting a user's tickets and inserting one are two statements, so the cap
 * holds only if mints of one user take turns. PGlite is one connection and
 * cannot show that: the burst below needs separate pooled connections, which is
 * what several API replicas (or one busy one) have. It runs where the suite
 * already has a database (DATABASE_URL, as in CI) and is skipped, saying so,
 * without one.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { db } from "../src/infra/db.js";
import { initUserEnvCrypto } from "../src/crypto/user-env.js";
import { terminalTicketsSchemaSql } from "../src/terminal/schema.js";
import {
  MAX_OUTSTANDING_TICKETS_PER_USER, TooManyTicketsError, mintTicket, redeemTicket, type TicketGrant,
} from "../src/terminal/tickets.js";

const skip = postgresSkipReason();

const GRANT: TicketGrant = {
  userId: "u-race",
  sessionId: "s-race",
  target: { workloadId: "wl-1", workspaceId: "ws-a", pod: "wl-1-pod-0", container: "main" },
  cols: 80,
  rows: 24,
  platformKey: "ak-race",
};

before(async () => {
  if (skip) return;
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
  initUserEnvCrypto();
  for (const sql of terminalTicketsSchemaSql()) await db.query(sql);
  await db.query("DELETE FROM claw_terminal_tickets WHERE user_id IN ('u-race', 'u-race-2')");
});

after(async () => {
  if (skip) return;
  await db.query("DELETE FROM claw_terminal_tickets WHERE user_id IN ('u-race', 'u-race-2')");
  await db.pool.end();
  await db.lockPool.end();
});

test("a burst of concurrent mints by one user stops at the cap, not past it", { skip }, async () => {
  const burst = MAX_OUTSTANDING_TICKETS_PER_USER * 3;
  const results = await Promise.allSettled(Array.from({ length: burst }, () => mintTicket(GRANT)));
  const minted = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled");
  const refused = results.filter((r) => r.status === "rejected" && r.reason instanceof TooManyTicketsError);
  assert.equal(minted.length, MAX_OUTSTANDING_TICKETS_PER_USER, "exactly the cap was minted");
  assert.equal(refused.length, burst - MAX_OUTSTANDING_TICKETS_PER_USER, "every other mint was refused for the cap, not for anything else");
  const rows = await db.query("SELECT COUNT(*)::int AS n FROM claw_terminal_tickets WHERE user_id = 'u-race'");
  assert.equal(rows.rows[0].n, MAX_OUTSTANDING_TICKETS_PER_USER);
  // Another user is not held up by this one's burst, and a spent ticket makes room.
  await mintTicket({ ...GRANT, userId: "u-race-2" });
  assert.ok(await redeemTicket(minted[0].value, "s-race"));
  await mintTicket(GRANT);
});
