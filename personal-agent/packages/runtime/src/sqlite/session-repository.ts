// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Which session a chat uses, and what /repo and /sessions remember, on SQLite (tables `sessions`, `recent_repos`,
 * `pending_repo`, `session_history`). Order is by a per-person counter, not the clock, so two picks in one second keep
 * their order. */
import {
  PENDING_REPO_TTL_SECONDS,
  RECENT_REPOS,
  SESSION_HISTORY_KEEP,
  SESSION_LIST,
  type ChatSession,
  type HistorySession,
  type NotedSession,
  type RepoChoice,
  type RepoHistoryRepository,
  type SessionRepository,
} from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";
import { col, flag } from "./database.js";
import { forgetRepos } from "./forget.js";

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly ctx: StoreContext) {}

  getSession(userId: string, scope = ""): string | null {
    const row = this.ctx.db.get("SELECT session_id FROM sessions WHERE aad_id = ? AND scope = ?", userId, scope);
    return row ? col.str(row, "session_id") : null;
  }

  getSessionPlugin(userId: string, scope = ""): string {
    const row = this.ctx.db.get("SELECT plugin_id FROM sessions WHERE aad_id = ? AND scope = ?", userId, scope);
    return row ? col.str(row, "plugin_id") : "";
  }

  getSessionModel(userId: string, scope = ""): string {
    const row = this.ctx.db.get("SELECT model FROM sessions WHERE aad_id = ? AND scope = ?", userId, scope);
    return row ? col.str(row, "model") : "";
  }

  getSessionShared(userId: string, scope = ""): boolean {
    const row = this.ctx.db.get("SELECT shared FROM sessions WHERE aad_id = ? AND scope = ?", userId, scope);
    return row !== undefined && col.bool(row, "shared");
  }

  setSession(userId: string, session: Partial<ChatSession> & { readonly sessionId: string }, scope = ""): void {
    this.ctx.db.run(
      "INSERT OR REPLACE INTO sessions (aad_id, scope, session_id, updated_at, plugin_id, model, shared) VALUES (?, ?, ?, ?, ?, ?, ?)",
      userId,
      scope,
      session.sessionId,
      this.ctx.now(),
      session.pluginId ?? "",
      session.model ?? "",
      flag(session.shared ?? false),
    );
  }

  clearSession(userId: string, scope = ""): void {
    this.ctx.db.run("DELETE FROM sessions WHERE aad_id = ? AND scope = ?", userId, scope);
  }
}

export class SqliteRepoHistoryRepository implements RepoHistoryRepository {
  constructor(private readonly ctx: StoreContext) {}

  touchRecentRepo(userId: string, choice: RepoChoice): void {
    const { db } = this.ctx;
    const seq = this.nextSeq("recent_repos", userId);
    db.run(
      "INSERT INTO recent_repos (aad_id, repo_key, repo, branch, seq) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(aad_id, repo_key, branch) DO UPDATE SET repo = excluded.repo, seq = excluded.seq",
      userId,
      choice.repo.toLowerCase(),
      choice.repo,
      choice.branch,
      seq,
    );
    db.run(
      "DELETE FROM recent_repos WHERE aad_id = ? AND seq NOT IN " +
        "(SELECT seq FROM recent_repos WHERE aad_id = ? ORDER BY seq DESC LIMIT ?)",
      userId,
      userId,
      RECENT_REPOS,
    );
  }

  recentRepos(userId: string): RepoChoice[] {
    return this.ctx.db
      .all("SELECT repo, branch FROM recent_repos WHERE aad_id = ? ORDER BY seq DESC LIMIT ?", userId, RECENT_REPOS)
      .map((r) => ({ repo: col.str(r, "repo"), branch: col.str(r, "branch") }));
  }

  setPendingRepo(userId: string, choice: RepoChoice): void {
    this.ctx.db.run(
      "INSERT OR REPLACE INTO pending_repo (aad_id, repo, branch, set_at) VALUES (?, ?, ?, ?)",
      userId,
      choice.repo,
      choice.branch,
      this.ctx.now(),
    );
  }

  getPendingRepo(userId: string): RepoChoice | null {
    const row = this.ctx.db.get("SELECT repo, branch, set_at FROM pending_repo WHERE aad_id = ?", userId);
    return row && this.ctx.now() - col.num(row, "set_at") < PENDING_REPO_TTL_SECONDS
      ? { repo: col.str(row, "repo"), branch: col.str(row, "branch") }
      : null;
  }

  clearPendingRepo(userId: string): void {
    this.ctx.db.run("DELETE FROM pending_repo WHERE aad_id = ?", userId);
  }

  noteSession(userId: string, sessionId: string, seen: NotedSession = {}): void {
    const { db } = this.ctx;
    const seq = this.nextSeq("session_history", userId);
    db.run(
      "INSERT INTO session_history (aad_id, session_id, title, repo, branch, last_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(aad_id, session_id) DO UPDATE SET last_at = excluded.last_at, seq = excluded.seq, " +
        "title = CASE WHEN session_history.title = '' THEN excluded.title ELSE session_history.title END, " +
        "repo = CASE WHEN session_history.repo = '' THEN excluded.repo ELSE session_history.repo END, " +
        "branch = CASE WHEN session_history.repo = '' THEN excluded.branch ELSE session_history.branch END",
      userId,
      sessionId,
      seen.title ?? "",
      seen.repo ?? "",
      seen.branch ?? "",
      this.ctx.now(),
      seq,
    );
    db.run(
      "DELETE FROM session_history WHERE aad_id = ? AND seq NOT IN " +
        "(SELECT seq FROM session_history WHERE aad_id = ? ORDER BY seq DESC LIMIT ?)",
      userId,
      userId,
      SESSION_HISTORY_KEEP,
    );
  }

  sessionHistory(userId: string, limit = SESSION_LIST): HistorySession[] {
    return this.ctx.db
      .all(
        "SELECT session_id, title, repo, branch, last_at FROM session_history WHERE aad_id = ? ORDER BY seq DESC LIMIT ?",
        userId,
        limit,
      )
      .map((r) => ({
        sessionId: col.str(r, "session_id"),
        title: col.str(r, "title"),
        repo: col.str(r, "repo"),
        branch: col.str(r, "branch"),
        lastAt: col.num(r, "last_at"),
      }));
  }

  forgetSession(userId: string, sessionId: string): void {
    this.ctx.db.run("DELETE FROM session_history WHERE aad_id = ? AND session_id = ?", userId, sessionId);
  }

  forgetRepos(userId: string): void {
    forgetRepos(this.ctx.db, userId);
  }

  private nextSeq(table: "recent_repos" | "session_history", userId: string): number {
    return col.num(
      this.ctx.db.get(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ${table} WHERE aad_id = ?`, userId) ?? {},
      "seq",
    );
  }
}
