// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Which Claw session a chat uses, and what /repo and /sessions remember (tables `sessions`, `recent_repos`,
 * `pending_repo`, `session_history`). Scope '' is the 1:1 chat; a group chat's conversation id is its own scope. */

export interface ChatSession {
  readonly sessionId: string;
  /** The plugin it was created with ('' none). */
  readonly pluginId: string;
  /** The model it is known to have been given ('' Claw's default). */
  readonly model: string;
  /** Created shared (no memory in it). */
  readonly shared: boolean;
}

export interface SessionRepository {
  getSession(userId: string, scope?: string): string | null;
  getSessionPlugin(userId: string, scope?: string): string;
  getSessionModel(userId: string, scope?: string): string;
  getSessionShared(userId: string, scope?: string): boolean;
  setSession(userId: string, session: Partial<ChatSession> & { readonly sessionId: string }, scope?: string): void;
  clearSession(userId: string, scope?: string): void;
}

export interface RepoChoice {
  /** "owner/name" */
  readonly repo: string;
  /** '' the default branch. */
  readonly branch: string;
}

export interface HistorySession {
  readonly sessionId: string;
  /** What the session was started with ('' when never seen to start). */
  readonly title: string;
  readonly repo: string;
  readonly branch: string;
  /** When this chat last used it. */
  readonly lastAt: number;
}

export interface NotedSession {
  readonly title?: string;
  readonly repo?: string;
  readonly branch?: string;
}

export interface RepoHistoryRepository {
  /** The newest of the person's RECENT_REPOS (same repository, compared without case, and branch: one entry). */
  touchRecentRepo(userId: string, choice: RepoChoice): void;
  /** Newest first. */
  recentRepos(userId: string): RepoChoice[];
  /** The person's next new session is bound to this repository. */
  setPendingRepo(userId: string, choice: RepoChoice): void;
  /** Null when none, or older than PENDING_REPO_TTL_SECONDS. */
  getPendingRepo(userId: string): RepoChoice | null;
  clearPendingRepo(userId: string): void;
  /** The chat used `sessionId` now; a known session keeps its title and repository unless it had none. */
  noteSession(userId: string, sessionId: string, seen?: NotedSession): void;
  /** Newest first. */
  sessionHistory(userId: string, limit?: number): HistorySession[];
  forgetSession(userId: string, sessionId: string): void;
  /** Everything /repo and /sessions remember about the person. */
  forgetRepos(userId: string): void;
}
