// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The assistant's cards and messages on SQLite (tables `assistant_cards`, `auto_replies`, `assistant_action_cards`,
 * `assistant_confirm_cards`, `assistant_choice_cards`, `assistant_messages`). */
import {
  ASSISTANT_CARD_KEEP_SECONDS,
  ASSISTANT_MESSAGE_KEEP_SECONDS,
  CONFIRM_CARD_KEEP_SECONDS,
  type ActionCard,
  type AssistantButtonRepository,
  type AssistantCard,
  type AssistantCardRepository,
  type AssistantMessage,
  type AssistantMessageRepository,
  type CardState,
  type ChoiceCard,
  type ConfirmCard,
  type JsonObject,
  type MoveOptions,
  type PlacedCard,
} from "@primusclaw/personal-agent";

import { type StoreContext, tokenUrlsafe } from "./context.js";
import { type Database, type Row, col, flag } from "./database.js";
import { jsonStrings, parseJson, pyJsonDumps, storedObject } from "./py-json.js";

/** Move a card of `table` to `state`; with `onlyFrom`, only from that state. True if this call moved it. */
function moveCard(db: Database, table: string, cardId: string, state: CardState, options: MoveOptions = {}): boolean {
  const from = options.onlyFrom;
  return from
    ? db.run(`UPDATE ${table} SET state = ? WHERE card_id = ? AND state = ?`, state, cardId, from) === 1
    : db.run(`UPDATE ${table} SET state = ? WHERE card_id = ?`, state, cardId) === 1;
}

function placed(row: Row): PlacedCard | null {
  const reference = parseJson(col.str(row, "reference_json"));
  const render = storedObject(col.str(row, "render_json") || "{}");
  if (typeof reference !== "object" || reference === null || Array.isArray(reference) || render === null) return null;
  return {
    cardId: col.str(row, "card_id"),
    userId: col.str(row, "aad_id"),
    itemId: col.str(row, "item_id"),
    activityId: col.str(row, "activity_id"),
    reference: reference as JsonObject,
    render,
    createdAt: col.num(row, "created_at"),
  };
}

export class SqliteAssistantCardRepository implements AssistantCardRepository {
  constructor(private readonly ctx: StoreContext) {}

  addAssistantCard(userId: string, itemId: string, version: number, canAccept: boolean): string {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM assistant_cards WHERE created_at < ?", now - ASSISTANT_CARD_KEEP_SECONDS);
    const cardId = tokenUrlsafe(this.ctx.random, 12);
    this.ctx.db.run(
      "INSERT INTO assistant_cards (card_id, aad_id, item_id, version, can_accept, state, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)",
      cardId,
      userId,
      itemId,
      version,
      flag(canAccept),
      now,
    );
    return cardId;
  }

  getAssistantCard(cardId: string): AssistantCard | null {
    const row = this.ctx.db.get(
      "SELECT card_id, aad_id, item_id, version, can_accept, state, created_at, ended FROM assistant_cards WHERE card_id = ?",
      cardId,
    );
    if (!row) return null;
    return {
      cardId: col.str(row, "card_id"),
      userId: col.str(row, "aad_id"),
      itemId: col.str(row, "item_id"),
      version: col.num(row, "version"),
      canAccept: col.bool(row, "can_accept"),
      state: col.str(row, "state"),
      createdAt: col.num(row, "created_at"),
      ended: col.str(row, "ended"),
    };
  }

  endAssistantCard(cardId: string, ended: string): boolean {
    return (
      this.ctx.db.run(
        "UPDATE assistant_cards SET state = 'ended', ended = ? WHERE card_id = ? AND state = 'open'",
        ended,
        cardId,
      ) === 1
    );
  }

  placeAssistantCard(
    cardId: string,
    placement: { readonly activityId: string; readonly reference: JsonObject; readonly render: JsonObject },
  ): void {
    this.ctx.db.run(
      "UPDATE assistant_cards SET activity_id = ?, reference_json = ?, render_json = ? WHERE card_id = ?",
      placement.activityId,
      pyJsonDumps(placement.reference),
      pyJsonDumps(placement.render),
      cardId,
    );
  }

  placedAssistantCards(filter: { readonly itemId: string } | { readonly since?: number }): PlacedCard[] {
    const base =
      "SELECT card_id, aad_id, item_id, activity_id, reference_json, render_json, created_at FROM assistant_cards " +
      "WHERE state = 'open' AND activity_id != '' AND reference_json != ''";
    const rows =
      "itemId" in filter
        ? this.ctx.db.all(`${base} AND item_id = ? ORDER BY created_at`, filter.itemId)
        : this.ctx.db.all(`${base} AND created_at >= ? ORDER BY created_at`, filter.since ?? 0);
    return rows.map(placed).filter((card): card is PlacedCard => card !== null);
  }

  moveAssistantCard(cardId: string, state: CardState, options?: MoveOptions): boolean {
    return moveCard(this.ctx.db, "assistant_cards", cardId, state, options);
  }

  setAutoReply(userId: string, itemId: string, pull: string): void {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM auto_replies WHERE created_at < ?", now - ASSISTANT_CARD_KEEP_SECONDS);
    this.ctx.db.run(
      "INSERT OR REPLACE INTO auto_replies (aad_id, item_id, pull, created_at) VALUES (?, ?, ?, ?)",
      userId,
      itemId,
      pull,
      now,
    );
  }

  autoReply(userId: string, itemId: string): string | null {
    const row = this.ctx.db.get("SELECT pull FROM auto_replies WHERE aad_id = ? AND item_id = ?", userId, itemId);
    return row ? col.str(row, "pull") : null;
  }

  clearAutoReply(userId: string, itemId: string): void {
    this.ctx.db.run("DELETE FROM auto_replies WHERE aad_id = ? AND item_id = ?", userId, itemId);
  }
}

export class SqliteAssistantButtonRepository implements AssistantButtonRepository {
  constructor(private readonly ctx: StoreContext) {}

  addActionCard(userId: string, channelMessageId: string, name: string, args: string): string {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM assistant_action_cards WHERE created_at < ?", now - ASSISTANT_MESSAGE_KEEP_SECONDS);
    const cardId = tokenUrlsafe(this.ctx.random, 12);
    this.ctx.db.run(
      "INSERT INTO assistant_action_cards (card_id, aad_id, channel_message_id, name, args, state, created_at) " +
        "VALUES (?, ?, ?, ?, ?, 'open', ?)",
      cardId,
      userId,
      channelMessageId,
      name,
      args,
      now,
    );
    return cardId;
  }

  getActionCard(cardId: string): ActionCard | null {
    const row = this.ctx.db.get(
      "SELECT card_id, aad_id, channel_message_id, name, args, state, created_at FROM assistant_action_cards " +
        "WHERE card_id = ? AND created_at >= ?",
      cardId,
      this.ctx.now() - ASSISTANT_MESSAGE_KEEP_SECONDS,
    );
    if (!row) return null;
    return {
      cardId: col.str(row, "card_id"),
      userId: col.str(row, "aad_id"),
      channelMessageId: col.str(row, "channel_message_id"),
      name: col.str(row, "name"),
      args: col.str(row, "args"),
      state: col.str(row, "state"),
      createdAt: col.num(row, "created_at"),
    };
  }

  moveActionCard(cardId: string, state: CardState, options?: MoveOptions): boolean {
    return moveCard(this.ctx.db, "assistant_action_cards", cardId, state, options);
  }

  addConfirmCard(userId: string, confirmationId: string, kind: string, label = ""): string {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM assistant_confirm_cards WHERE created_at < ?", now - CONFIRM_CARD_KEEP_SECONDS);
    const cardId = tokenUrlsafe(this.ctx.random, 12);
    this.ctx.db.run(
      "INSERT INTO assistant_confirm_cards (card_id, aad_id, confirmation_id, kind, label, state, created_at) " +
        "VALUES (?, ?, ?, ?, ?, 'open', ?)",
      cardId,
      userId,
      confirmationId,
      kind,
      label,
      now,
    );
    return cardId;
  }

  getConfirmCard(cardId: string): ConfirmCard | null {
    const row = this.ctx.db.get(
      "SELECT card_id, aad_id, confirmation_id, kind, label, state, created_at FROM assistant_confirm_cards " +
        "WHERE card_id = ? AND created_at >= ?",
      cardId,
      this.ctx.now() - CONFIRM_CARD_KEEP_SECONDS,
    );
    if (!row) return null;
    return {
      cardId: col.str(row, "card_id"),
      userId: col.str(row, "aad_id"),
      confirmationId: col.str(row, "confirmation_id"),
      kind: col.str(row, "kind"),
      label: col.str(row, "label"),
      state: col.str(row, "state"),
      createdAt: col.num(row, "created_at"),
    };
  }

  moveConfirmCard(cardId: string, state: CardState, options?: MoveOptions): boolean {
    return moveCard(this.ctx.db, "assistant_confirm_cards", cardId, state, options);
  }

  addChoiceCard(
    userId: string,
    choice: {
      readonly text: string;
      readonly options: readonly string[];
      readonly multiple: boolean;
      readonly lang: string;
    },
  ): string {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM assistant_choice_cards WHERE created_at < ?", now - ASSISTANT_MESSAGE_KEEP_SECONDS);
    const cardId = tokenUrlsafe(this.ctx.random, 12);
    this.ctx.db.run(
      "INSERT INTO assistant_choice_cards (card_id, aad_id, text, options_json, multiple, lang, state, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'open', ?)",
      cardId,
      userId,
      choice.text,
      pyJsonDumps(choice.options),
      flag(choice.multiple),
      choice.lang,
      now,
    );
    return cardId;
  }

  getChoiceCard(cardId: string): ChoiceCard | null {
    const row = this.ctx.db.get(
      "SELECT card_id, aad_id, text, options_json, multiple, chosen_json, lang, state, created_at FROM assistant_choice_cards " +
        "WHERE card_id = ? AND created_at >= ?",
      cardId,
      this.ctx.now() - ASSISTANT_MESSAGE_KEEP_SECONDS,
    );
    if (!row) return null;
    return {
      cardId: col.str(row, "card_id"),
      userId: col.str(row, "aad_id"),
      text: col.str(row, "text"),
      options: jsonStrings(col.str(row, "options_json") || "[]"),
      multiple: col.bool(row, "multiple"),
      chosen: jsonStrings(col.str(row, "chosen_json") || "[]"),
      lang: col.str(row, "lang"),
      state: col.str(row, "state"),
      createdAt: col.num(row, "created_at"),
    };
  }

  chooseChoiceCard(cardId: string, chosen: readonly string[]): boolean {
    return (
      this.ctx.db.run(
        "UPDATE assistant_choice_cards SET state = 'done', chosen_json = ? WHERE card_id = ? AND state = 'open'",
        pyJsonDumps(chosen),
        cardId,
      ) === 1
    );
  }
}

export class SqliteAssistantMessageRepository implements AssistantMessageRepository {
  constructor(private readonly ctx: StoreContext) {}

  noteAssistantMessage(
    channelMessageId: string,
    userId: string,
    actions: readonly string[],
    people: readonly string[] = [],
  ): void {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM assistant_messages WHERE sent_at < ?", now - ASSISTANT_MESSAGE_KEEP_SECONDS);
    this.ctx.db.run(
      "INSERT OR REPLACE INTO assistant_messages (channel_message_id, aad_id, actions, sent_at, people) VALUES (?, ?, ?, ?, ?)",
      channelMessageId,
      userId,
      pyJsonDumps(actions),
      now,
      pyJsonDumps(people),
    );
  }

  assistantMessagePeople(channelMessageId: string): ReadonlySet<string> {
    const row = this.ctx.db.get(
      "SELECT people FROM assistant_messages WHERE channel_message_id = ? AND sent_at >= ?",
      channelMessageId,
      this.ctx.now() - ASSISTANT_MESSAGE_KEEP_SECONDS,
    );
    return new Set(row ? jsonStrings(col.str(row, "people") || "[]") : []);
  }

  assistantMessage(channelMessageId: string): AssistantMessage | null {
    const row = this.ctx.db.get(
      "SELECT aad_id, actions FROM assistant_messages WHERE channel_message_id = ? AND sent_at >= ?",
      channelMessageId,
      this.ctx.now() - ASSISTANT_MESSAGE_KEEP_SECONDS,
    );
    return row ? { userId: col.str(row, "aad_id"), actions: new Set(jsonStrings(col.str(row, "actions"))) } : null;
  }
}
