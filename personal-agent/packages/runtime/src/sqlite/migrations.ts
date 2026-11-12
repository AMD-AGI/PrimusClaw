// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Bringing a database to the current schema, in exactly the Python worker's order: the `sessions` rebuild, the DDL of
 * `schema.sql` (the Python `_SCHEMA` text, unchanged), then each column added after its table first shipped. SQLite
 * keeps an ALTER in the table's stored SQL, so the order of the columns below is part of the storage format: a
 * database either worker made must read the same in `sqlite_master` as one the other made.
 */
import { readFileSync } from "node:fs";

import type { Database } from "./database.js";

/** The DDL, as Python's `_SCHEMA`. */
export const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** table -> [column, declaration], in the order the Python worker adds them. */
export const ADDED_COLUMNS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  [
    "sessions",
    [
      ["plugin_id", "TEXT NOT NULL DEFAULT ''"], // '' = created without one
      ["model", "TEXT NOT NULL DEFAULT ''"], // '' = none was set on it
      ["shared", "INTEGER NOT NULL DEFAULT 0"], // 0 = created as the requester's own
    ],
  ],
  ["links", [["claw_user_id", "TEXT"]]],
  ["assistant_messages", [["people", "TEXT NOT NULL DEFAULT '[]'"]]], // the Claw user ids it named
  ["teams_users", [["email", "TEXT NOT NULL DEFAULT ''"]]], // '' = Teams never gave one
  [
    "user_prefs",
    [
      ["quiet_enabled", "INTEGER NOT NULL DEFAULT 1"],
      ["quiet_start", "TEXT NOT NULL DEFAULT '22:00'"],
      ["quiet_end", "TEXT NOT NULL DEFAULT '08:00'"],
      ["paused_until", "REAL"],
      ["brief_trigger_id", "TEXT"],
      ["lang", "TEXT NOT NULL DEFAULT ''"],
      ["lang_set", "INTEGER NOT NULL DEFAULT 0"],
      ["remote_window", "TEXT NOT NULL DEFAULT ''"],
    ],
  ],
  [
    "feedback_reports",
    [
      ["reporter_name", "TEXT NOT NULL DEFAULT ''"],
      ["reporter_email", "TEXT NOT NULL DEFAULT ''"],
    ],
  ],
  [
    "remote_state",
    [
      ["unattended", "INTEGER"],
      ["mode_flags_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["status_card", "TEXT NOT NULL DEFAULT ''"],
      ["attached_at", "REAL NOT NULL DEFAULT 0"],
      ["conversation", "TEXT NOT NULL DEFAULT ''"],
      ["conversation_ref", "TEXT NOT NULL DEFAULT ''"],
      ["chat_box", "TEXT NOT NULL DEFAULT 'chat'"],
      ["window_cards_json", "TEXT NOT NULL DEFAULT '[]'"],
    ],
  ],
  [
    "approvals",
    [
      ["card_sent", "INTEGER NOT NULL DEFAULT 1"],
      ["card_json", "TEXT"],
      ["card_id", "TEXT NOT NULL DEFAULT ''"], // '' = the channel never said the card's id
      ["questions_json", "TEXT NOT NULL DEFAULT ''"], // '' = not a turn's question card
    ],
  ],
  ["notify_subs", [["types_version", "INTEGER NOT NULL DEFAULT 0"]]],
  [
    "remote_permissions",
    [
      ["message_id", "TEXT NOT NULL DEFAULT ''"], // '' = the channel never said the card's id
      ["ask_json", "TEXT NOT NULL DEFAULT ''"], // '' = not a question a terminal asks
      ["lang", "TEXT NOT NULL DEFAULT ''"], // the card's language; '' = shown before it was kept
    ],
  ],
  [
    "turn_answers",
    [
      ["boot_id", "TEXT NOT NULL DEFAULT ''"],
      ["prompt", "TEXT NOT NULL DEFAULT ''"],
      ["ended", "INTEGER NOT NULL DEFAULT 0"],
      ["message_id", "TEXT NOT NULL DEFAULT ''"],
      ["turn_id", "TEXT NOT NULL DEFAULT ''"],
    ],
  ],
  [
    "github_confirmations",
    [
      ["kind", "TEXT NOT NULL DEFAULT 'merge'"],
      ["event", "TEXT NOT NULL DEFAULT ''"],
    ],
  ],
  [
    "assistant_cards",
    [
      ["ended", "TEXT NOT NULL DEFAULT ''"],
      ["activity_id", "TEXT NOT NULL DEFAULT ''"],
      ["reference_json", "TEXT NOT NULL DEFAULT ''"],
      ["render_json", "TEXT NOT NULL DEFAULT ''"],
    ],
  ],
  [
    "pending_requests",
    [
      ["quote", "TEXT NOT NULL DEFAULT ''"],
      ["sent", "TEXT NOT NULL DEFAULT ''"],
    ],
  ],
];

/**
 * The sessions table used to be keyed by the person alone. It is now keyed by (person, scope): scope '' is the 1:1
 * chat. Existing rows become the 1:1 session; plugin_id '' means created without one.
 */
export function migrateSessions(db: Database): void {
  const columns = db.columns("sessions");
  if (columns.size === 0 || columns.has("scope")) return;
  const plugin = columns.has("plugin_id") ? "plugin_id" : "''";
  db.exec(`
            BEGIN;
            ALTER TABLE sessions RENAME TO sessions_v1;
            CREATE TABLE sessions (
              aad_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL,
              updated_at REAL NOT NULL, plugin_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (aad_id, scope));
            INSERT INTO sessions (aad_id, scope, session_id, updated_at, plugin_id)
              SELECT aad_id, '', session_id, updated_at, ${plugin} FROM sessions_v1;
            DROP TABLE sessions_v1;
            COMMIT;
        `);
}

/** The whole start-up migration; idempotent. */
export function migrate(db: Database): void {
  migrateSessions(db);
  db.exec(SCHEMA_SQL);
  for (const [table, columns] of ADDED_COLUMNS) {
    const have = db.columns(table);
    for (const [column, declaration] of columns) {
      if (!have.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }
}
