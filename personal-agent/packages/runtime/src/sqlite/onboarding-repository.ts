// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** OnboardingRepository on SQLite (tables `onboarding_cards`, `onboarding_dms`, `pending_requests`). */
import {
  ONBOARDING_INTERVAL_SECONDS,
  PENDING_REQUEST_TTL_SECONDS,
  type NewPendingRequest,
  type OnboardingCard,
  type OnboardingRepository,
  type PendingRequest,
} from "@primusclaw/personal-agent";

import { type StoreContext, tokenUrlsafe } from "./context.js";
import { type Database, col } from "./database.js";
import { pyJsonDumps, storedObject } from "./py-json.js";

/** Requests of people who did not link in time go. */
export function pruneExpiredRequests(db: Database, now: number): void {
  db.run("DELETE FROM pending_requests WHERE created_at < ?", now - PENDING_REQUEST_TTL_SECONDS);
}

export class SqliteOnboardingRepository implements OnboardingRepository {
  constructor(private readonly ctx: StoreContext) {}

  claimOnboardingCard(
    userId: string,
    scope: string,
    member: { readonly channelUserId: string; readonly name: string },
  ): string | null {
    const { db } = this.ctx;
    const now = this.ctx.now();
    db.run("DELETE FROM onboarding_cards WHERE created_at < ?", now - ONBOARDING_INTERVAL_SECONDS);
    if (db.get("SELECT 1 AS x FROM onboarding_cards WHERE aad_id = ? AND scope = ?", userId, scope)) return null;
    const promptId = tokenUrlsafe(this.ctx.random, 12);
    db.run(
      "INSERT INTO onboarding_cards (prompt_id, aad_id, scope, teams_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      promptId,
      userId,
      scope,
      member.channelUserId,
      member.name,
      now,
    );
    return promptId;
  }

  releaseOnboardingCard(promptId: string): void {
    this.ctx.db.run("DELETE FROM onboarding_cards WHERE prompt_id = ?", promptId);
  }

  getOnboardingCard(promptId: string): OnboardingCard | null {
    const row = this.ctx.db.get(
      "SELECT prompt_id, aad_id, scope, teams_id, name, created_at FROM onboarding_cards WHERE prompt_id = ? AND created_at >= ?",
      promptId,
      this.ctx.now() - ONBOARDING_INTERVAL_SECONDS,
    );
    if (!row) return null;
    return {
      promptId: col.str(row, "prompt_id"),
      userId: col.str(row, "aad_id"),
      scope: col.str(row, "scope"),
      channelUserId: col.str(row, "teams_id"),
      name: col.str(row, "name"),
      createdAt: col.num(row, "created_at"),
    };
  }

  claimOnboardingDm(userId: string): boolean {
    const now = this.ctx.now();
    const row = this.ctx.db.get("SELECT at FROM onboarding_dms WHERE aad_id = ?", userId);
    if (row && col.num(row, "at") > now - ONBOARDING_INTERVAL_SECONDS) return false;
    this.ctx.db.run("INSERT OR REPLACE INTO onboarding_dms (aad_id, at) VALUES (?, ?)", userId, now);
    return true;
  }

  releaseOnboardingDm(userId: string): void {
    this.ctx.db.run("DELETE FROM onboarding_dms WHERE aad_id = ?", userId);
  }

  savePendingRequest(r: NewPendingRequest): void {
    const now = this.ctx.now();
    pruneExpiredRequests(this.ctx.db, now);
    this.ctx.db.run(
      "INSERT OR REPLACE INTO pending_requests (aad_id, scope, message_id, text, reference_json, created_at, quote, sent) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      r.userId,
      r.scope,
      r.messageId,
      r.text,
      pyJsonDumps(r.reference),
      now,
      r.quote ?? "",
      r.sent ?? "",
    );
  }

  takePendingRequest(userId: string): PendingRequest | null {
    const row = this.ctx.db.get(
      "SELECT aad_id, scope, message_id, text, reference_json, created_at, quote, sent FROM pending_requests WHERE aad_id = ?",
      userId,
    );
    this.ctx.db.run("DELETE FROM pending_requests WHERE aad_id = ?", userId);
    if (!row || col.num(row, "created_at") < this.ctx.now() - PENDING_REQUEST_TTL_SECONDS) return null;
    return {
      userId: col.str(row, "aad_id"),
      scope: col.str(row, "scope"),
      messageId: col.str(row, "message_id"),
      text: col.str(row, "text"),
      reference: storedObject(col.str(row, "reference_json")) ?? {},
      createdAt: col.num(row, "created_at"),
      quote: col.str(row, "quote"),
      sent: col.str(row, "sent"),
    };
  }
}
