// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** ApprovalRepository on SQLite (table `approvals`). Which cards are being sent right now is kept in this process only;
 * what outlives a crash is the `card_sent` column: a card recorded and not marked sent is sent by the next process. */
import {
  APPROVAL_TTL_SECONDS,
  type Approval,
  type ApprovalRepository,
  type ApprovalState,
  type NewApproval,
  type UnsentCard,
} from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";
import { col } from "./database.js";
import { pyJsonDumps, storedObject } from "./py-json.js";

const key = (sessionId: string, toolUseId: string): string => JSON.stringify([sessionId, toolUseId]);

export class SqliteApprovalRepository implements ApprovalRepository {
  readonly #sending = new Set<string>();

  constructor(private readonly ctx: StoreContext) {}

  saveApproval(approval: NewApproval): boolean {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM approvals WHERE expires_at < ?", now - APPROVAL_TTL_SECONDS);
    const recorded =
      this.ctx.db.run(
        "INSERT OR IGNORE INTO approvals (session_id, tool_use_id, aad_id, tool, expires_at, created_at, " +
          "card_sent, card_json) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
        approval.sessionId,
        approval.toolUseId,
        approval.userId,
        approval.tool,
        approval.expiresAt,
        now,
        approval.envelope === undefined || approval.envelope === null ? null : pyJsonDumps(approval.envelope),
      ) === 1;
    if (recorded) this.#sending.add(key(approval.sessionId, approval.toolUseId));
    return recorded;
  }

  approvalSent(sessionId: string, toolUseId: string): void {
    this.#sending.delete(key(sessionId, toolUseId));
    this.ctx.db.run(
      "UPDATE approvals SET card_sent = 1, card_json = NULL WHERE session_id = ? AND tool_use_id = ?",
      sessionId,
      toolUseId,
    );
  }

  approvalInFlight(sessionId: string, toolUseId: string): boolean {
    return this.#sending.has(key(sessionId, toolUseId));
  }

  forgetApproval(sessionId: string, toolUseId: string): void {
    this.#sending.delete(key(sessionId, toolUseId));
    this.ctx.db.run(
      "DELETE FROM approvals WHERE session_id = ? AND tool_use_id = ? AND state = 'pending'",
      sessionId,
      toolUseId,
    );
  }

  claimUnsentApprovals(): UnsentCard[] {
    const now = this.ctx.now();
    const rows = this.ctx.db.all(
      "SELECT session_id, tool_use_id, aad_id, expires_at, card_json FROM approvals " +
        "WHERE card_sent = 0 AND state = 'pending' AND card_json IS NOT NULL ORDER BY created_at",
    );
    const claimed: UnsentCard[] = [];
    for (const row of rows) {
      const sessionId = col.str(row, "session_id");
      const toolUseId = col.str(row, "tool_use_id");
      if (this.#sending.has(key(sessionId, toolUseId))) continue;
      const expiresAt = col.num(row, "expires_at");
      const envelope = expiresAt > now ? storedObject(col.str(row, "card_json")) : null;
      if (envelope === null) {
        // Out of time (or unreadable): there is nothing a person could still answer.
        this.ctx.db.run(
          "UPDATE approvals SET state = 'expired', card_sent = 1, card_json = NULL WHERE session_id = ? AND tool_use_id = ?",
          sessionId,
          toolUseId,
        );
        continue;
      }
      this.#sending.add(key(sessionId, toolUseId));
      claimed.push({ sessionId, toolUseId, userId: col.str(row, "aad_id"), expiresAt, envelope });
    }
    return claimed;
  }

  approvalSendFailed(sessionId: string, toolUseId: string): void {
    this.#sending.delete(key(sessionId, toolUseId));
  }

  getApproval(sessionId: string, toolUseId: string): Approval | null {
    const row = this.ctx.db.get(
      "SELECT session_id, tool_use_id, aad_id, tool, expires_at, state FROM approvals WHERE session_id = ? AND tool_use_id = ?",
      sessionId,
      toolUseId,
    );
    if (!row) return null;
    return {
      sessionId: col.str(row, "session_id"),
      toolUseId: col.str(row, "tool_use_id"),
      userId: col.str(row, "aad_id"),
      tool: col.str(row, "tool"),
      expiresAt: col.num(row, "expires_at"),
      state: col.str(row, "state"),
    };
  }

  closeApproval(sessionId: string, toolUseId: string, state: ApprovalState, options: { readonly onlyIfPending?: boolean } = {}): boolean {
    const onlyIfPending = options.onlyIfPending ?? true;
    return (
      this.ctx.db.run(
        `UPDATE approvals SET state = ? WHERE session_id = ? AND tool_use_id = ?${onlyIfPending ? " AND state = 'pending'" : ""}`,
        state,
        sessionId,
        toolUseId,
      ) === 1
    );
  }
}
