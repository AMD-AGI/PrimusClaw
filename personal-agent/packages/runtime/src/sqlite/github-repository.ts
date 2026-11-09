// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** GitHub review delegation on SQLite (tables `github_confirmations`, `acting_sessions`, `review_notices`,
 * `asker_follows`, `github_notices`). */
import {
  ACTING_SESSION_KEEP_SECONDS,
  type AskerFollow,
  type ConfirmationState,
  type GithubConfirmation,
  type GithubConfirmationRepository,
  type JsonObject,
  type NewGithubConfirmation,
  type ReviewDelegationRepository,
  type ReviewNotice,
} from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";
import { type Row, col, flag } from "./database.js";
import { parseJson, pyJsonDumps, storedObject } from "./py-json.js";

const CONFIRMATION_COLUMNS =
  "confirmation_id, session_id, actor_aad, requester_aad, repo, pr, reference_json, expires_at, state, created_at, kind, event";

function confirmation(row: Row): GithubConfirmation {
  return {
    confirmationId: col.str(row, "confirmation_id"),
    sessionId: col.str(row, "session_id"),
    actorId: col.str(row, "actor_aad"),
    requesterId: col.str(row, "requester_aad"),
    repo: col.str(row, "repo"),
    pr: col.num(row, "pr"),
    reference: storedObject(col.str(row, "reference_json")) ?? {},
    expiresAt: col.num(row, "expires_at"),
    state: col.str(row, "state"),
    createdAt: col.num(row, "created_at"),
    kind: col.str(row, "kind"),
    event: col.str(row, "event"),
  };
}

export class SqliteGithubConfirmationRepository implements GithubConfirmationRepository {
  constructor(private readonly ctx: StoreContext) {}

  addGithubConfirmation(c: NewGithubConfirmation): boolean {
    return (
      this.ctx.db.run(
        "INSERT OR IGNORE INTO github_confirmations (confirmation_id, session_id, actor_aad, requester_aad, repo, " +
          "pr, reference_json, expires_at, created_at, kind, event) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        c.confirmationId,
        c.sessionId,
        c.actorId,
        c.requesterId,
        c.repo,
        c.pr,
        pyJsonDumps(c.reference),
        c.expiresAt,
        this.ctx.now(),
        c.kind ?? "merge",
        c.event ?? "",
      ) === 1
    );
  }

  getGithubConfirmation(confirmationId: string): GithubConfirmation | null {
    const row = this.ctx.db.get(
      `SELECT ${CONFIRMATION_COLUMNS} FROM github_confirmations WHERE confirmation_id = ?`,
      confirmationId,
    );
    return row ? confirmation(row) : null;
  }

  pendingGithubConfirmations(actorId: string): GithubConfirmation[] {
    return this.ctx.db
      .all(
        `SELECT ${CONFIRMATION_COLUMNS} FROM github_confirmations WHERE actor_aad = ? AND state = 'pending' ` +
          "ORDER BY created_at, confirmation_id",
        actorId,
      )
      .map(confirmation);
  }

  moveGithubConfirmation(
    confirmationId: string,
    state: ConfirmationState,
    options: { readonly onlyFrom?: ConfirmationState } = {},
  ): boolean {
    return (
      this.ctx.db.run(
        "UPDATE github_confirmations SET state = ? WHERE confirmation_id = ? AND state = ?",
        state,
        confirmationId,
        options.onlyFrom ?? "pending",
      ) === 1
    );
  }

  forgetGithubConfirmation(confirmationId: string): void {
    this.ctx.db.run("DELETE FROM github_confirmations WHERE confirmation_id = ? AND state = 'pending'", confirmationId);
  }
}

export class SqliteReviewDelegationRepository implements ReviewDelegationRepository {
  constructor(private readonly ctx: StoreContext) {}

  noteActingSession(sessionId: string, requesterId: string, actorId: string): void {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM acting_sessions WHERE created_at < ?", now - ACTING_SESSION_KEEP_SECONDS);
    this.ctx.db.run(
      "INSERT OR IGNORE INTO acting_sessions (session_id, requester_aad, actor_aad, created_at) VALUES (?, ?, ?, ?)",
      sessionId,
      requesterId,
      actorId,
      now,
    );
  }

  isActingSession(sessionId: string): boolean {
    return (
      sessionId !== "" &&
      this.ctx.db.get("SELECT 1 AS x FROM acting_sessions WHERE session_id = ?", sessionId) !== undefined
    );
  }

  noteReviewNotice(n: ReviewNotice): void {
    this.ctx.db.run(
      "INSERT INTO review_notices (session_id, actor_aad, requester_aad, pull, delivered, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      n.sessionId,
      n.actorId,
      n.requesterId,
      n.pull,
      flag(n.delivered),
      n.reason,
      this.ctx.now(),
    );
  }

  reviewNotices(): ReviewNotice[] {
    return this.ctx.db
      .all("SELECT session_id, actor_aad, requester_aad, pull, delivered, reason FROM review_notices ORDER BY rowid")
      .map((r) => ({
        sessionId: col.str(r, "session_id"),
        actorId: col.str(r, "actor_aad"),
        requesterId: col.str(r, "requester_aad"),
        pull: col.str(r, "pull"),
        delivered: col.bool(r, "delivered"),
        reason: col.str(r, "reason"),
      }));
  }

  addAskerFollow(f: {
    readonly itemId: string;
    readonly batchId: string;
    readonly review: JsonObject;
    readonly reference: JsonObject;
    readonly deadline: number;
  }): void {
    this.ctx.db.run(
      "INSERT OR IGNORE INTO asker_follows (item_id, batch_id, review_json, reference_json, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      f.itemId,
      f.batchId,
      pyJsonDumps(f.review),
      pyJsonDumps(f.reference),
      f.deadline,
      this.ctx.now(),
    );
  }

  askerFollows(): AskerFollow[] {
    return this.ctx.db
      .all(
        "SELECT item_id, batch_id, review_json, reference_json, said, reviewer_told, deadline FROM asker_follows ORDER BY created_at, rowid",
      )
      .map((r) => ({
        itemId: col.str(r, "item_id"),
        batchId: col.str(r, "batch_id"),
        review: parseJson(col.str(r, "review_json")),
        reference: parseJson(col.str(r, "reference_json")),
        said: col.str(r, "said"),
        reviewerTold: col.bool(r, "reviewer_told"),
        deadline: col.num(r, "deadline"),
      }));
  }

  askerFollowSaid(itemId: string, said: string): void {
    this.ctx.db.run("UPDATE asker_follows SET said = ? WHERE item_id = ?", said, itemId);
  }

  askerFollowReviewerTold(itemId: string): void {
    this.ctx.db.run("UPDATE asker_follows SET reviewer_told = 1 WHERE item_id = ?", itemId);
  }

  dropAskerFollow(itemId: string): void {
    this.ctx.db.run("DELETE FROM asker_follows WHERE item_id = ?", itemId);
  }

  claimGithubNotice(userId: string, kind: string, interval: number): boolean {
    const now = this.ctx.now();
    const row = this.ctx.db.get("SELECT at FROM github_notices WHERE aad_id = ? AND kind = ?", userId, kind);
    if (row && col.num(row, "at") > now - interval) return false;
    this.ctx.db.run("INSERT OR REPLACE INTO github_notices (aad_id, kind, at) VALUES (?, ?, ?)", userId, kind, now);
    return true;
  }

  releaseGithubNotice(userId: string, kind: string): void {
    this.ctx.db.run("DELETE FROM github_notices WHERE aad_id = ? AND kind = ?", userId, kind);
  }
}
