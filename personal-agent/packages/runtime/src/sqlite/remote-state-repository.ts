// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Where a chat is attached on a remote agent, on SQLite (table `remote_state`). The key is the person's id for a 1:1
 * chat, or `<userId>#<conversation>` for a group chat bound to a session. */
import {
  WINDOW_CARDS_KEPT,
  type RemoteAttachment,
  type RemoteModes,
  type RemoteState,
  type RemoteStateRepository,
} from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";
import { type Row, col } from "./database.js";
import { jsonFlags, jsonStrings, pyJsonDumps } from "./py-json.js";

const COLUMNS =
  "session_id, connector_id, agent_id, agent_label, host, cwd, cursor, turn_open, mode, modes_json, listing_json, " +
  "unattended, mode_flags_json, status_card, attached_at, conversation, conversation_ref, chat_box, window_cards_json";

const chatBox = (window: string | undefined): "card" | "chat" => (window === "card" ? "card" : "chat");

function remoteState(row: Row): RemoteState {
  return {
    sessionId: col.strOrNull(row, "session_id"),
    connectorId: col.str(row, "connector_id"),
    agentId: col.str(row, "agent_id"),
    agentLabel: col.str(row, "agent_label"),
    host: col.str(row, "host"),
    cwd: col.str(row, "cwd"),
    cursor: col.str(row, "cursor"),
    turnOpen: col.bool(row, "turn_open"),
    mode: col.str(row, "mode"),
    modes: jsonStrings(col.str(row, "modes_json")),
    listing: jsonStrings(col.str(row, "listing_json")),
    unattended: row["unattended"] === null || row["unattended"] === undefined ? null : col.bool(row, "unattended"),
    modeFlags: jsonFlags(col.str(row, "mode_flags_json")),
    statusCard: col.str(row, "status_card"),
    attachedAt: col.num(row, "attached_at"),
    conversation: col.str(row, "conversation"),
    conversationRef: col.str(row, "conversation_ref"),
    window: col.str(row, "chat_box") || "chat",
    windowCards: jsonStrings(col.str(row, "window_cards_json")),
  };
}

const nullableFlag = (value: boolean | null | undefined): number | null =>
  value === null || value === undefined ? null : value ? 1 : 0;

export class SqliteRemoteStateRepository implements RemoteStateRepository {
  constructor(private readonly ctx: StoreContext) {}

  getRemote(chatKey: string): RemoteState | null {
    const row = this.ctx.db.get(`SELECT ${COLUMNS} FROM remote_state WHERE aad_id = ?`, chatKey);
    return row ? remoteState(row) : null;
  }

  remoteAttachedUsers(): string[] {
    return this.ctx.db
      .all("SELECT aad_id FROM remote_state WHERE session_id IS NOT NULL")
      .map((r) => col.str(r, "aad_id"));
  }

  attachedRemote(chatKey: string): RemoteState | null {
    const state = this.getRemote(chatKey);
    return state?.sessionId ? state : null;
  }

  attachRemote(chatKey: string, a: RemoteAttachment): void {
    const kept = this.ctx.db.get("SELECT listing_json, status_card FROM remote_state WHERE aad_id = ?", chatKey);
    const now = this.ctx.now();
    this.ctx.db.run(
      "INSERT OR REPLACE INTO remote_state (aad_id, session_id, connector_id, agent_id, agent_label, host, cwd, " +
        "cursor, turn_open, mode, modes_json, listing_json, updated_at, unattended, mode_flags_json, status_card, attached_at, " +
        "conversation, conversation_ref, chat_box, window_cards_json) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')",
      chatKey,
      a.sessionId,
      a.connectorId,
      a.agentId,
      a.agentLabel,
      a.host,
      a.cwd,
      a.cursor ?? "",
      a.mode ?? "",
      pyJsonDumps(a.modes ?? []),
      kept ? col.str(kept, "listing_json") : "[]",
      now,
      nullableFlag(a.unattended),
      pyJsonDumps(a.modeFlags ?? {}),
      kept ? col.str(kept, "status_card") : "",
      now,
      a.conversation ?? "",
      a.conversationRef ?? "",
      chatBox(a.window),
    );
  }

  setRemoteWindow(chatKey: string, window: string): void {
    if (window === "card" || window === "chat") {
      this.ctx.db.run("UPDATE remote_state SET chat_box = ? WHERE aad_id = ?", window, chatKey);
    }
  }

  noteWindowCard(chatKey: string, cardId: string, kept = WINDOW_CARDS_KEPT): void {
    if (!cardId) return;
    const row = this.ctx.db.get("SELECT window_cards_json FROM remote_state WHERE aad_id = ?", chatKey);
    const ids = [...jsonStrings(row ? col.str(row, "window_cards_json") : "[]").filter((id) => id !== cardId), cardId];
    // As Python's ids[-kept:] (kept 0 keeps them all).
    this.ctx.db.run(
      "UPDATE remote_state SET window_cards_json = ? WHERE aad_id = ?",
      pyJsonDumps(ids.slice(-kept)),
      chatKey,
    );
  }

  detachRemote(chatKey: string): void {
    this.ctx.db.run(
      "UPDATE remote_state SET session_id = NULL, cursor = '', turn_open = 0, window_cards_json = '[]', updated_at = ? WHERE aad_id = ?",
      this.ctx.now(),
      chatKey,
    );
  }

  setRemoteCursor(chatKey: string, sessionId: string, cursor: string): void {
    if (!isDigits(cursor)) return;
    this.ctx.db.run(
      "UPDATE remote_state SET cursor = ?, updated_at = ? WHERE aad_id = ? AND session_id = ? " +
        "AND (cursor = '' OR CAST(cursor AS INTEGER) < CAST(? AS INTEGER))",
      cursor,
      this.ctx.now(),
      chatKey,
      sessionId,
      cursor,
    );
  }

  setRemoteTurn(chatKey: string, sessionId: string, isOpen: boolean): void {
    this.ctx.db.run(
      "UPDATE remote_state SET turn_open = ? WHERE aad_id = ? AND session_id = ?",
      isOpen ? 1 : 0,
      chatKey,
      sessionId,
    );
  }

  setRemoteModes(chatKey: string, sessionId: string, modes: RemoteModes): void {
    const set = (column: string, value: string | number): void => {
      this.ctx.db.run(
        `UPDATE remote_state SET ${column} = ? WHERE aad_id = ? AND session_id = ?`,
        value,
        chatKey,
        sessionId,
      );
    };
    if (modes.unattended !== undefined && modes.unattended !== null) set("unattended", modes.unattended ? 1 : 0);
    if (modes.modeFlags !== undefined && modes.modeFlags !== null) set("mode_flags_json", pyJsonDumps(modes.modeFlags));
    if (modes.mode !== undefined && modes.mode !== null) set("mode", modes.mode);
    if (modes.modes !== undefined && modes.modes !== null) set("modes_json", pyJsonDumps(modes.modes));
  }

  setRemoteStatusCard(chatKey: string, cardId: string): void {
    this.ctx.db.run(
      "INSERT INTO remote_state (aad_id, status_card, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(aad_id) DO UPDATE SET status_card = excluded.status_card",
      chatKey,
      cardId,
      this.ctx.now(),
    );
  }

  setRemoteListing(chatKey: string, sessionIds: readonly string[]): void {
    this.ctx.db.run(
      "INSERT INTO remote_state (aad_id, listing_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(aad_id) DO UPDATE SET listing_json = excluded.listing_json",
      chatKey,
      pyJsonDumps(sessionIds),
      this.ctx.now(),
    );
  }
}

/** Python's `str.isdigit()` for the ids a connector sends: one or more digits (Unicode decimal digits included). */
function isDigits(text: string): boolean {
  return /^\p{Nd}+$/u.test(text);
}
