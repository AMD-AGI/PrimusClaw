// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Chat turns that answered in the chat, on SQLite (tables `turn_answers`, `answered_messages`). A turn row carries the
 * id of the process that started it: a turn of another process died with it. */
import {
  ANSWERED_MESSAGE_KEEP_SECONDS,
  type AnsweredInChat,
  type TurnAnswerRepository,
  type TurnRun,
} from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";
import { type Row, col } from "./database.js";

export class SqliteTurnAnswerRepository implements TurnAnswerRepository {
  /** @param bootId this process's id (Python's `secrets.token_hex(8)` at start). */
  constructor(
    private readonly ctx: StoreContext,
    private readonly bootId: string,
  ) {}

  turnStarted(
    sessionId: string,
    turn: { readonly prompt?: string; readonly messageId?: string; readonly turnId?: string } = {},
  ): void {
    this.ctx.db.run(
      "INSERT OR REPLACE INTO turn_answers (session_id, started_at, delivered_at, boot_id, prompt, message_id, turn_id) " +
        "VALUES (?, ?, NULL, ?, ?, ?, ?)",
      sessionId,
      this.ctx.now(),
      this.bootId,
      turn.prompt ?? "",
      turn.messageId ?? "",
      turn.turnId ?? "",
    );
  }

  turnDelivered(sessionId: string, turn: { readonly messageId?: string; readonly turnId?: string } = {}): void {
    const now = this.ctx.now();
    const messageId = turn.messageId ?? "";
    const turnId = turn.turnId ?? "";
    this.ctx.db.run(
      "UPDATE turn_answers SET delivered_at = ?, message_id = CASE WHEN ? <> '' THEN ? ELSE message_id END " +
        "WHERE session_id = ? AND (? = '' OR turn_id = ?)",
      now,
      messageId,
      messageId,
      sessionId,
      turnId,
      turnId,
    );
    if (!messageId) return;
    this.ctx.db.run("DELETE FROM answered_messages WHERE delivered_at < ?", now - ANSWERED_MESSAGE_KEEP_SECONDS);
    this.ctx.db.run(
      "INSERT OR REPLACE INTO answered_messages (session_id, message_id, delivered_at) VALUES (?, ?, ?)",
      sessionId,
      messageId,
      now,
    );
  }

  turnNotDelivered(sessionId: string, turnId = ""): void {
    // Kept, not deleted: what was asked still names the run in its card (`turnPrompt`).
    this.ctx.db.run(
      "UPDATE turn_answers SET ended = 1 WHERE session_id = ? AND delivered_at IS NULL AND (? = '' OR turn_id = ?)",
      sessionId,
      turnId,
      turnId,
    );
  }

  answeredInChat(sessionId: string, run: TurnRun): AnsweredInChat | null {
    const messageId = run.messageId ?? "";
    if (
      messageId &&
      this.ctx.db.get(
        "SELECT 1 AS x FROM answered_messages WHERE session_id = ? AND message_id = ?",
        sessionId,
        messageId,
      )
    ) {
      return "delivered";
    }
    const row = this.ctx.db.get(
      "SELECT started_at, delivered_at, boot_id, ended, message_id FROM turn_answers WHERE session_id = ?",
      sessionId,
    );
    return row ? this.judge(row, run, messageId) : null;
  }

  /** The two message ids decide when both are known; else the clock does (see the port's description). */
  private judge(row: Row, run: TurnRun, messageId: string): AnsweredInChat | null {
    const rowMessage = col.str(row, "message_id");
    const known = messageId !== "" && rowMessage !== "";
    if (known && rowMessage !== messageId) return null; // the run of another message
    const same = known && rowMessage === messageId;
    const startedAt = col.num(row, "started_at");
    if (!same && startedAt > run.finishedAt) return null;
    const deliveredAt = col.numOrNull(row, "delivered_at");
    if (deliveredAt === null) {
      if (col.bool(row, "ended")) return null; // it ended without its answer reaching the chat
      if (col.str(row, "boot_id") !== this.bootId) return "lost";
      return this.ctx.now() - startedAt < run.runningMax ? "running" : null;
    }
    return same || run.finishedAt <= deliveredAt + run.slack ? "delivered" : null;
  }

  turnPrompt(sessionId: string, finishedAt: number): string {
    const row = this.ctx.db.get("SELECT started_at, prompt FROM turn_answers WHERE session_id = ?", sessionId);
    return row && col.num(row, "started_at") <= finishedAt ? col.str(row, "prompt") : "";
  }
}
