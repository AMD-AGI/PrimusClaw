// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Remote session names and permission cards on SQLite (tables `remote_session_names`, `remote_permissions`). */
import {
  REMOTE_PERMISSION_KEEP_SECONDS,
  type NewRemotePermission,
  type RemotePermission,
  type RemotePermissionRepository,
  type RemotePermissionState,
  type RemoteSessionName,
  type RemoteSessionNameRepository,
} from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";
import { type Row, col } from "./database.js";
import { jsonList, pyJsonDumps } from "./py-json.js";

export class SqliteRemoteSessionNameRepository implements RemoteSessionNameRepository {
  constructor(private readonly ctx: StoreContext) {}

  nameRemoteSession(userId: string, sessionId: string, name: Partial<RemoteSessionName> = {}): void {
    this.ctx.db.run(
      "INSERT OR REPLACE INTO remote_session_names (session_id, aad_id, title, conversation_ref, created_at) VALUES (?, ?, ?, ?, ?)",
      sessionId,
      userId,
      name.title ?? "",
      name.conversationRef ?? "",
      this.ctx.now(),
    );
  }

  titleRemoteSession(sessionId: string, title: string): void {
    this.ctx.db.run("UPDATE remote_session_names SET title = ? WHERE session_id = ? AND title = ''", title, sessionId);
  }

  setRemoteSessionAcp(sessionId: string, acpSessionId: string): void {
    this.ctx.db.run("UPDATE remote_session_names SET acp_session_id = ? WHERE session_id = ?", acpSessionId, sessionId);
  }

  remoteSessionAcps(userId: string): Map<string, string> {
    const rows = this.ctx.db.all(
      "SELECT session_id, acp_session_id FROM remote_session_names WHERE aad_id = ? AND acp_session_id != ''",
      userId,
    );
    return new Map(rows.map((r) => [col.str(r, "session_id"), col.str(r, "acp_session_id")]));
  }

  remoteSessionNames(userId: string): Map<string, RemoteSessionName> {
    const rows = this.ctx.db.all(
      "SELECT session_id, title, conversation_ref FROM remote_session_names WHERE aad_id = ?",
      userId,
    );
    return new Map(
      rows.map((r) => [
        col.str(r, "session_id"),
        { title: col.str(r, "title"), conversationRef: col.str(r, "conversation_ref") },
      ]),
    );
  }
}

const PERMISSION_COLUMNS =
  "session_id, action_id, aad_id, tool, options_json, expires_at, state, message_id, ask_json, lang";

function permission(row: Row): RemotePermission {
  return {
    sessionId: col.str(row, "session_id"),
    actionId: col.str(row, "action_id"),
    userId: col.str(row, "aad_id"),
    tool: col.str(row, "tool"),
    options: jsonList(col.str(row, "options_json")),
    expiresAt: col.num(row, "expires_at"),
    state: col.str(row, "state"),
    messageId: col.str(row, "message_id"),
    ask: askOf(col.str(row, "ask_json")),
    lang: langOf(col.str(row, "lang")),
  };
}

function langOf(text: string): RemotePermission["lang"] {
  return text === "zh" || text === "en" ? text : "";
}

function askOf(text: string): Readonly<Record<string, unknown>> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class SqliteRemotePermissionRepository implements RemotePermissionRepository {
  constructor(private readonly ctx: StoreContext) {}

  saveRemotePermission(p: NewRemotePermission): boolean {
    const now = this.ctx.now();
    this.ctx.db.run("DELETE FROM remote_permissions WHERE expires_at < ?", now - REMOTE_PERMISSION_KEEP_SECONDS);
    return (
      this.ctx.db.run(
        "INSERT OR IGNORE INTO remote_permissions (session_id, action_id, aad_id, tool, options_json, expires_at, created_at, ask_json, lang) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        p.sessionId,
        p.actionId,
        p.userId,
        p.tool,
        pyJsonDumps(p.options),
        p.expiresAt,
        now,
        p.ask ? JSON.stringify(p.ask) : "",
        p.lang ?? "",
      ) === 1
    );
  }

  getRemotePermission(sessionId: string, actionId: string): RemotePermission | null {
    const row = this.ctx.db.get(
      `SELECT ${PERMISSION_COLUMNS} FROM remote_permissions WHERE session_id = ? AND action_id = ?`,
      sessionId,
      actionId,
    );
    return row ? permission(row) : null;
  }

  pendingRemotePermissions(userId: string, sessionId: string): RemotePermission[] {
    return this.ctx.db
      .all(
        `SELECT ${PERMISSION_COLUMNS} FROM remote_permissions ` +
          "WHERE aad_id = ? AND session_id = ? AND state = 'pending' AND expires_at > ? ORDER BY created_at",
        userId,
        sessionId,
        this.ctx.now(),
      )
      .map(permission);
  }

  waitingRemoteSessions(userId: string): Set<string> {
    const rows = this.ctx.db.all(
      "SELECT DISTINCT session_id FROM remote_permissions WHERE aad_id = ? AND state = 'pending' AND expires_at > ?",
      userId,
      this.ctx.now(),
    );
    return new Set(rows.map((r) => col.str(r, "session_id")));
  }

  setRemotePermissionMessage(sessionId: string, actionId: string, messageId: string): void {
    this.ctx.db.run(
      "UPDATE remote_permissions SET message_id = ? WHERE session_id = ? AND action_id = ?",
      messageId,
      sessionId,
      actionId,
    );
  }

  forgetRemotePermission(sessionId: string, actionId: string): void {
    this.ctx.db.run("DELETE FROM remote_permissions WHERE session_id = ? AND action_id = ?", sessionId, actionId);
  }

  closeRemotePermission(
    sessionId: string,
    actionId: string,
    state: RemotePermissionState,
    options: { readonly onlyIfPending?: boolean; readonly onlyIfState?: RemotePermissionState } = {},
  ): boolean {
    const from = options.onlyIfState ?? ((options.onlyIfPending ?? true) ? "pending" : null);
    const sql = "UPDATE remote_permissions SET state = ? WHERE session_id = ? AND action_id = ?";
    return from === null
      ? this.ctx.db.run(sql, state, sessionId, actionId) === 1
      : this.ctx.db.run(`${sql} AND state = ?`, state, sessionId, actionId, from) === 1;
  }
}
