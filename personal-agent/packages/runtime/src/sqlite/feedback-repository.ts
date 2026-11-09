// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** FeedbackRepository on SQLite (tables `feedback_reports`, `feedback_asks`, `feedback_offers`, `feedback_prompts`). */
import {
  FEEDBACK_ASK_TTL_SECONDS,
  FEEDBACK_DEDUPE_SECONDS,
  FEEDBACK_KEEP_SECONDS,
  FEEDBACK_OFFER_KEEP_SECONDS,
  FEEDBACK_PROMPT_TTL_SECONDS,
  type FeedbackOffer,
  type FeedbackOfferState,
  type FeedbackPrompt,
  type FeedbackReport,
  type FeedbackRepository,
  type IssueRef,
  type NewFeedbackReport,
} from "@primusclaw/personal-agent";

import { type StoreContext, tokenUrlsafe } from "./context.js";
import { type Database, type Row, col, flag } from "./database.js";

const REPORT_COLUMNS =
  "id, aad_id, scope, session_id, text, scene, created_at, state, issue_number, issue_url, as_comment, " +
  "attempts, next_attempt_at, last_error, reporter_name, reporter_email";

function report(row: Row): FeedbackReport {
  return {
    id: col.num(row, "id"),
    userId: col.str(row, "aad_id"),
    scope: col.str(row, "scope"),
    sessionId: col.str(row, "session_id"),
    text: col.str(row, "text"),
    scene: col.str(row, "scene"),
    createdAt: col.num(row, "created_at"),
    state: col.str(row, "state"),
    issueNumber: col.numOrNull(row, "issue_number"),
    issueUrl: col.str(row, "issue_url"),
    asComment: col.bool(row, "as_comment"),
    attempts: col.num(row, "attempts"),
    nextAttemptAt: col.num(row, "next_attempt_at"),
    lastError: col.str(row, "last_error"),
    reporterName: col.str(row, "reporter_name"),
    reporterEmail: col.str(row, "reporter_email"),
  };
}

/** Delivered reports past FEEDBACK_KEEP_SECONDS go (undelivered ones are never dropped). */
export function pruneFiledReports(db: Database, now: number): void {
  db.run("DELETE FROM feedback_reports WHERE state = 'filed' AND created_at < ?", now - FEEDBACK_KEEP_SECONDS);
}

export class SqliteFeedbackRepository implements FeedbackRepository {
  constructor(private readonly ctx: StoreContext) {}

  addFeedbackReport(r: NewFeedbackReport): number {
    const now = this.ctx.now();
    pruneFiledReports(this.ctx.db, now);
    return this.ctx.db.insert(
      "INSERT INTO feedback_reports (aad_id, scope, session_id, text, scene, created_at, reporter_name, reporter_email) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      r.userId,
      r.scope,
      r.sessionId,
      r.text,
      r.scene,
      now,
      r.reporterName ?? "",
      r.reporterEmail ?? "",
    );
  }

  getFeedbackReport(reportId: number): FeedbackReport | null {
    const row = this.ctx.db.get(`SELECT ${REPORT_COLUMNS} FROM feedback_reports WHERE id = ?`, reportId);
    return row ? report(row) : null;
  }

  feedbackTarget(r: FeedbackReport): IssueRef | null {
    const row = this.ctx.db.get(
      "SELECT issue_number, issue_url FROM feedback_reports WHERE aad_id = ? AND scope = ? AND session_id = ? " +
        "AND state = 'filed' AND issue_number IS NOT NULL AND id < ? AND created_at >= ? " +
        "ORDER BY created_at DESC, id DESC LIMIT 1",
      r.userId,
      r.scope,
      r.sessionId,
      r.id,
      r.createdAt - FEEDBACK_DEDUPE_SECONDS,
    );
    return row ? { number: Math.trunc(col.num(row, "issue_number")), url: col.str(row, "issue_url") } : null;
  }

  markFeedbackFiled(reportId: number, issue: IssueRef, asComment: boolean): void {
    this.ctx.db.run(
      "UPDATE feedback_reports SET state = 'filed', issue_number = ?, issue_url = ?, as_comment = ?, last_error = '' WHERE id = ?",
      issue.number,
      issue.url,
      flag(asComment),
      reportId,
    );
  }

  markFeedbackFailed(reportId: number, error: string, retryAt: number): void {
    this.ctx.db.run(
      "UPDATE feedback_reports SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE id = ?",
      retryAt,
      Array.from(error).slice(0, 80).join(""),
      reportId,
    );
  }

  dueFeedback(limit: number): FeedbackReport[] {
    return this.ctx.db
      .all(
        `SELECT ${REPORT_COLUMNS} FROM feedback_reports WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`,
        this.ctx.now(),
        limit,
      )
      .map(report);
  }

  pendingFeedbackCount(): number {
    return col.num(this.ctx.db.get("SELECT COUNT(*) AS n FROM feedback_reports WHERE state = 'pending'") ?? {}, "n");
  }

  openFeedbackAsk(userId: string, scope: string): void {
    this.ctx.db.run(
      "INSERT OR REPLACE INTO feedback_asks (aad_id, scope, asked_at) VALUES (?, ?, ?)",
      userId,
      scope,
      this.ctx.now(),
    );
  }

  takeFeedbackAsk(userId: string, scope: string): boolean {
    this.ctx.db.run("DELETE FROM feedback_asks WHERE asked_at < ?", this.ctx.now() - FEEDBACK_ASK_TTL_SECONDS);
    return this.ctx.db.run("DELETE FROM feedback_asks WHERE aad_id = ? AND scope = ?", userId, scope) === 1;
  }

  hasFeedbackAsk(userId: string, scope: string): boolean {
    const row = this.ctx.db.get("SELECT asked_at FROM feedback_asks WHERE aad_id = ? AND scope = ?", userId, scope);
    return row !== undefined && this.ctx.now() - col.num(row, "asked_at") < FEEDBACK_ASK_TTL_SECONDS;
  }

  addFeedbackOffer(userId: string, issueNumber: number, sessionId: string, turnId: string): string {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM feedback_offers WHERE created_at < ?", now - FEEDBACK_OFFER_KEEP_SECONDS);
    const offerId = tokenUrlsafe(this.ctx.random, 9);
    this.ctx.db.run(
      "INSERT INTO feedback_offers (offer_id, aad_id, issue_number, session_id, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      offerId,
      userId,
      issueNumber,
      sessionId,
      turnId,
      now,
    );
    return offerId;
  }

  getFeedbackOffer(offerId: string): FeedbackOffer | null {
    const row = this.ctx.db.get(
      "SELECT offer_id, aad_id, issue_number, session_id, turn_id, created_at, state FROM feedback_offers WHERE offer_id = ?",
      offerId,
    );
    if (!row) return null;
    return {
      offerId: col.str(row, "offer_id"),
      userId: col.str(row, "aad_id"),
      issueNumber: col.num(row, "issue_number"),
      sessionId: col.str(row, "session_id"),
      turnId: col.str(row, "turn_id"),
      createdAt: col.num(row, "created_at"),
      state: col.str(row, "state"),
    };
  }

  moveFeedbackOffer(
    offerId: string,
    state: FeedbackOfferState,
    options: { readonly onlyFrom?: FeedbackOfferState | null } = {},
  ): boolean {
    const from = options.onlyFrom === undefined ? "open" : options.onlyFrom;
    return from
      ? this.ctx.db.run(
          "UPDATE feedback_offers SET state = ? WHERE offer_id = ? AND state = ?",
          state,
          offerId,
          from,
        ) === 1
      : this.ctx.db.run("UPDATE feedback_offers SET state = ? WHERE offer_id = ?", state, offerId) === 1;
  }

  addFeedbackPrompt(userId: string, scope: string): string {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM feedback_prompts WHERE created_at < ?", now - FEEDBACK_PROMPT_TTL_SECONDS);
    const promptId = tokenUrlsafe(this.ctx.random, 9);
    this.ctx.db.run(
      "INSERT INTO feedback_prompts (prompt_id, aad_id, scope, created_at) VALUES (?, ?, ?, ?)",
      promptId,
      userId,
      scope,
      now,
    );
    return promptId;
  }

  getFeedbackPrompt(promptId: string): FeedbackPrompt | null {
    const row = this.ctx.db.get(
      "SELECT prompt_id, aad_id, scope, created_at FROM feedback_prompts WHERE prompt_id = ?",
      promptId,
    );
    if (!row || this.ctx.now() - col.num(row, "created_at") > FEEDBACK_PROMPT_TTL_SECONDS) return null;
    return {
      promptId: col.str(row, "prompt_id"),
      userId: col.str(row, "aad_id"),
      scope: col.str(row, "scope"),
      createdAt: col.num(row, "created_at"),
    };
  }
}
