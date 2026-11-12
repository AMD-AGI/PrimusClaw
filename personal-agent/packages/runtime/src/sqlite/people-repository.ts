// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Conversation references, preferences and held notices on SQLite (tables `conversation_refs`, `user_prefs`,
 * `held_events`). */
import {
  DEFAULT_QUIET,
  DEFAULT_TIMEZONE,
  HELD_TTL_SECONDS,
  MAX_HELD_PER_USER,
  type ConversationRefRepository,
  type HeldEventRepository,
  type JsonObject,
  type Prefs,
  type PrefsRepository,
} from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";
import { type SqlValue, col, flag } from "./database.js";
import { pyJsonDumps, storedObject } from "./py-json.js";

export class SqliteConversationRefRepository implements ConversationRefRepository {
  constructor(private readonly ctx: StoreContext) {}

  saveReference(userId: string, reference: JsonObject): void {
    const kept = Object.fromEntries(Object.entries(reference).filter(([key]) => key !== "activityId"));
    this.ctx.db.run(
      "INSERT OR REPLACE INTO conversation_refs (aad_id, reference_json, updated_at) VALUES (?, ?, ?)",
      userId,
      pyJsonDumps(kept),
      this.ctx.now(),
    );
  }

  getReference(userId: string): JsonObject | null {
    const row = this.ctx.db.get("SELECT reference_json FROM conversation_refs WHERE aad_id = ?", userId);
    return row ? storedObject(col.str(row, "reference_json")) : null;
  }

  lastInboundAt(userId: string): number | null {
    const row = this.ctx.db.get("SELECT updated_at FROM conversation_refs WHERE aad_id = ?", userId);
    return row ? col.num(row, "updated_at") : null;
  }
}

const DEFAULT_PREFS: Prefs = {
  timezone: DEFAULT_TIMEZONE,
  quietEnabled: true,
  quietStart: DEFAULT_QUIET[0],
  quietEnd: DEFAULT_QUIET[1],
  pausedUntil: null,
  briefTriggerId: null,
  lang: "",
  langSet: false,
  remoteWindow: "",
};

/** The columns a single preference is written to. */
type PrefColumn =
  | "timezone"
  | "quiet_enabled"
  | "quiet_start"
  | "quiet_end"
  | "paused_until"
  | "brief_trigger_id"
  | "lang"
  | "lang_set"
  | "remote_window";

export class SqlitePrefsRepository implements PrefsRepository {
  constructor(private readonly ctx: StoreContext) {}

  getPrefs(userId: string): Prefs {
    const row = this.ctx.db.get(
      "SELECT timezone, quiet_enabled, quiet_start, quiet_end, paused_until, brief_trigger_id, lang, lang_set, remote_window " +
        "FROM user_prefs WHERE aad_id = ?",
      userId,
    );
    if (!row) return DEFAULT_PREFS;
    return {
      timezone: col.str(row, "timezone"),
      quietEnabled: col.bool(row, "quiet_enabled"),
      quietStart: col.str(row, "quiet_start"),
      quietEnd: col.str(row, "quiet_end"),
      pausedUntil: col.numOrNull(row, "paused_until"),
      briefTriggerId: col.strOrNull(row, "brief_trigger_id"),
      lang: col.str(row, "lang"),
      langSet: col.bool(row, "lang_set"),
      remoteWindow: col.str(row, "remote_window"),
    };
  }

  getTimezone(userId: string): string {
    return this.getPrefs(userId).timezone;
  }

  setTimezone(userId: string, timezone: string): void {
    this.setPref(userId, "timezone", timezone);
  }

  setQuiet(userId: string, window: readonly [string, string] | null): void {
    if (window === null) {
      this.setPref(userId, "quiet_enabled", 0);
      return;
    }
    this.setPref(userId, "quiet_enabled", 1);
    this.setPref(userId, "quiet_start", window[0]);
    this.setPref(userId, "quiet_end", window[1]);
  }

  setPausedUntil(userId: string, until: number | null): void {
    this.setPref(userId, "paused_until", until);
  }

  setRemoteWindowPref(userId: string, window: string): void {
    if (window === "card" || window === "chat") this.setPref(userId, "remote_window", window);
  }

  setBriefTrigger(userId: string, triggerId: string | null): void {
    this.setPref(userId, "brief_trigger_id", triggerId);
  }

  setLang(userId: string, lang: string, said = true): void {
    this.setPref(userId, "lang", lang);
    this.setPref(userId, "lang_set", flag(said));
  }

  learnLang(userId: string, lang: string): void {
    const prefs = this.getPrefs(userId);
    if (!prefs.langSet && prefs.lang !== lang) this.setPref(userId, "lang", lang);
  }

  /** Upsert one preference; the others keep their value (or their default for a new row). */
  private setPref(userId: string, column: PrefColumn, value: SqlValue): void {
    if (column === "timezone") {
      this.ctx.db.run(
        "INSERT INTO user_prefs (aad_id, timezone) VALUES (?, ?) ON CONFLICT(aad_id) DO UPDATE SET timezone = excluded.timezone",
        userId,
        value,
      );
      return;
    }
    this.ctx.db.run(
      `INSERT INTO user_prefs (aad_id, timezone, ${column}) VALUES (?, ?, ?) ` +
        `ON CONFLICT(aad_id) DO UPDATE SET ${column} = excluded.${column}`,
      userId,
      DEFAULT_TIMEZONE,
      value,
    );
  }
}

export class SqliteHeldEventRepository implements HeldEventRepository {
  constructor(private readonly ctx: StoreContext) {}

  holdEvent(userId: string, event: JsonObject): void {
    const { db } = this.ctx;
    const now = this.ctx.now();
    db.run("DELETE FROM held_events WHERE held_at < ?", now - HELD_TTL_SECONDS);
    // (synced: the event endpoint answers Claw that a held event was taken, and Claw never sends it again)
    db.durably(() =>
      db.run(
        "INSERT OR IGNORE INTO held_events (event_id, aad_id, event_json, held_at) VALUES (?, ?, ?, ?)",
        pyStr(event["event_id"]),
        userId,
        pyJsonDumps(event),
        now,
      ),
    );
    db.run(
      "DELETE FROM held_events WHERE aad_id = ? AND event_id NOT IN " +
        "(SELECT event_id FROM held_events WHERE aad_id = ? ORDER BY held_at DESC, rowid DESC LIMIT ?)",
      userId,
      userId,
      MAX_HELD_PER_USER,
    );
  }

  usersWithHeld(): string[] {
    return this.ctx.db.all("SELECT DISTINCT aad_id FROM held_events").map((r) => col.str(r, "aad_id"));
  }

  takeHeld(userId: string): JsonObject[] {
    const rows = this.ctx.db.all(
      "SELECT event_id, event_json FROM held_events WHERE aad_id = ? ORDER BY held_at, rowid",
      userId,
    );
    this.ctx.db.run("DELETE FROM held_events WHERE aad_id = ?", userId);
    return rows.map((r) => storedObject(col.str(r, "event_json"))).filter((e): e is JsonObject => e !== null);
  }
}

/** Python's `str(value)` for the scalar an id field holds. */
function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) throw new RangeError("a held event needs an event_id");
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return pyJsonDumps(value);
}
