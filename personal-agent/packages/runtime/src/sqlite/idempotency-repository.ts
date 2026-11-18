// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** IdempotencyRepository on SQLite (tables `processed`, `event_claims`). A claim is one statement on the store, so of
 * any number of copies, in this process or another on the same file, one is sent. */
import {
  EVENT_CLAIM_LEASE_SECONDS,
  PROCESSED_TTL_SECONDS,
  type EventClaim,
  type IdempotencyRepository,
} from "@primusclaw/personal-agent";

import { type StoreContext, tokenHex } from "./context.js";
import { col } from "./database.js";
import { pruneFiledReports } from "./feedback-repository.js";
import { pruneExpiredRequests } from "./onboarding-repository.js";

export class SqliteIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly ctx: StoreContext) {}

  claimProcessed(activityId: string): boolean {
    return (
      this.ctx.db.run("INSERT OR IGNORE INTO processed (activity_id, at) VALUES (?, ?)", activityId, this.ctx.now()) ===
      1
    );
  }

  claimEvent(key: string): EventClaim {
    const now = this.ctx.now();
    const holder = tokenHex(this.ctx.random, 8);
    const { db } = this.ctx;
    if (db.get("SELECT 1 AS x FROM processed WHERE activity_id = ?", key)) return { state: "done", holder: "" };
    const got = db.run(
      "INSERT INTO event_claims (event_key, state, holder, until) VALUES (?, 'sending', ?, ?) " +
        "ON CONFLICT (event_key) DO UPDATE SET holder = excluded.holder, until = excluded.until " +
        "WHERE event_claims.state = 'sending' AND event_claims.until < ?",
      key,
      holder,
      now + EVENT_CLAIM_LEASE_SECONDS,
      now,
    );
    if (got === 1) return { state: "claimed", holder };
    const row = db.get("SELECT state FROM event_claims WHERE event_key = ?", key);
    return { state: row && col.str(row, "state") === "done" ? "done" : "busy", holder: "" };
  }

  finishEvent(key: string): void {
    const now = this.ctx.now();
    this.ctx.db.run(
      "UPDATE event_claims SET state = 'done', until = ? WHERE event_key = ?",
      now + PROCESSED_TTL_SECONDS,
      key,
    );
    this.ctx.db.run("DELETE FROM event_claims WHERE until < ?", now - EVENT_CLAIM_LEASE_SECONDS); // a done row's until is its expiry
  }

  releaseEvent(key: string, holder: string): void {
    this.ctx.db.run("DELETE FROM event_claims WHERE event_key = ? AND holder = ? AND state = 'sending'", key, holder);
  }

  seen(activityId: string): boolean {
    return this.ctx.db.get("SELECT 1 AS x FROM processed WHERE activity_id = ?", activityId) !== undefined;
  }

  markProcessed(activityId: string): void {
    const now = this.ctx.now();
    this.ctx.db.run("INSERT OR IGNORE INTO processed (activity_id, at) VALUES (?, ?)", activityId, now);
    this.ctx.db.run("DELETE FROM processed WHERE at < ?", now - PROCESSED_TTL_SECONDS);
    pruneExpiredRequests(this.ctx.db, now);
    // A delivered report is kept 30 days: pruned here, on every activity, not only when the next report is filed.
    pruneFiledReports(this.ctx.db, now);
  }
}
