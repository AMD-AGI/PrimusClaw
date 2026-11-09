// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** ObserveRepository on SQLite (tables `observed_groups`, `observe_cards`). */
import {
  ASSISTANT_CARD_KEEP_SECONDS,
  type GroupObserver,
  type JsonObject,
  type NewObserveCard,
  type ObserveCard,
  type ObserveCardState,
  type ObserveRepository,
  type ObservedGroup,
} from "@primusclaw/personal-agent";

import { type StoreContext, tokenUrlsafe } from "./context.js";
import { col } from "./database.js";
import { pyJsonDumps, storedObject } from "./py-json.js";

export class SqliteObserveRepository implements ObserveRepository {
  constructor(private readonly ctx: StoreContext) {}

  observeGroup(conversationId: string, observer: GroupObserver & { readonly reference: JsonObject; readonly name?: string }): void {
    const now = this.ctx.now();
    this.ctx.db.run(
      "INSERT INTO observed_groups (conversation_id, aad_id, scope, reference_json, name, on_since, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (conversation_id) DO UPDATE SET aad_id = excluded.aad_id, " +
        "scope = excluded.scope, reference_json = excluded.reference_json, name = excluded.name, " +
        "on_since = excluded.on_since, updated_at = excluded.updated_at",
      conversationId,
      observer.userId,
      observer.scope,
      pyJsonDumps(observer.reference),
      [...(observer.name ?? "")].slice(0, 200).join(""),
      now,
      now,
    );
  }

  unobserveGroup(conversationId: string): string | null {
    const row = this.ctx.db.get(
      "SELECT aad_id FROM observed_groups WHERE conversation_id = ? AND on_since IS NOT NULL",
      conversationId,
    );
    if (!row) return null;
    this.ctx.db.run(
      "UPDATE observed_groups SET on_since = NULL, updated_at = ? WHERE conversation_id = ?",
      this.ctx.now(),
      conversationId,
    );
    return col.str(row, "aad_id");
  }

  groupObserver(conversationId: string): GroupObserver | null {
    const row = this.ctx.db.get(
      "SELECT aad_id, scope FROM observed_groups WHERE conversation_id = ? AND on_since IS NOT NULL",
      conversationId,
    );
    return row ? { userId: col.str(row, "aad_id"), scope: col.str(row, "scope") } : null;
  }

  observedBy(userId: string): ObservedGroup[] {
    return this.ctx.db
      .all(
        "SELECT conversation_id, scope, name, on_since IS NOT NULL AS is_on FROM observed_groups WHERE aad_id = ? " +
          "ORDER BY updated_at DESC",
        userId,
      )
      .map((r) => ({
        conversationId: col.str(r, "conversation_id"),
        scope: col.str(r, "scope"),
        name: col.str(r, "name"),
        on: col.bool(r, "is_on"),
      }));
  }

  observedReference(conversationId: string): JsonObject | null {
    const row = this.ctx.db.get("SELECT reference_json FROM observed_groups WHERE conversation_id = ?", conversationId);
    return row ? storedObject(col.str(row, "reference_json")) : null;
  }

  addObserveCard(card: NewObserveCard): string {
    const now = this.ctx.now();
    this.ctx.db.run(
      "DELETE FROM observe_cards WHERE created_at < ? AND state IN ('open', 'busy')",
      now - ASSISTANT_CARD_KEEP_SECONDS,
    );
    const cardId = tokenUrlsafe(this.ctx.random, 12);
    this.ctx.db.run(
      "INSERT INTO observe_cards (card_id, aad_id, conversation_id, run_id, seq, tool, args, message, state, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
      cardId,
      card.userId,
      card.conversationId,
      card.runId,
      card.seq,
      card.tool,
      card.args,
      card.message,
      now,
    );
    return cardId;
  }

  getObserveCard(cardId: string): ObserveCard | null {
    const row = this.ctx.db.get(
      "SELECT card_id, aad_id, conversation_id, run_id, seq, tool, args, message, state FROM observe_cards WHERE card_id = ?",
      cardId,
    );
    if (!row) return null;
    return {
      cardId: col.str(row, "card_id"),
      userId: col.str(row, "aad_id"),
      conversationId: col.str(row, "conversation_id"),
      runId: col.str(row, "run_id"),
      seq: col.num(row, "seq"),
      tool: col.str(row, "tool"),
      args: col.str(row, "args"),
      message: col.str(row, "message"),
      state: col.str(row, "state"),
    };
  }

  observeSuggestionSettled(userId: string, runId: string, seq: number): boolean {
    return (
      this.ctx.db.get(
        "SELECT 1 AS x FROM observe_cards WHERE aad_id = ? AND run_id = ? AND seq = ? AND state IN ('accepted', 'dismissed', 'unsure')",
        userId,
        runId,
        seq,
      ) !== undefined
    );
  }

  moveObserveCard(cardId: string, state: ObserveCardState, onlyFrom?: ObserveCardState): boolean {
    const { db } = this.ctx;
    if (onlyFrom === undefined) return db.run("UPDATE observe_cards SET state = ? WHERE card_id = ?", state, cardId) === 1;
    const row = db.get("SELECT aad_id, run_id, seq FROM observe_cards WHERE card_id = ? AND state = ?", cardId, onlyFrom);
    if (!row) return false;
    if (
      state === "busy" &&
      db.get(
        "SELECT 1 AS x FROM observe_cards WHERE aad_id = ? AND run_id = ? AND seq = ? AND state IN ('busy', 'accepted', 'dismissed', 'unsure')",
        col.str(row, "aad_id"),
        col.str(row, "run_id"),
        col.num(row, "seq"),
      )
    ) {
      return false;
    }
    return db.run("UPDATE observe_cards SET state = ? WHERE card_id = ? AND state = ?", state, cardId, onlyFrom) === 1;
  }
}
