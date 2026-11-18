// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Deletions that more than one repository performs (a re-link, an unlink): one definition each. */
import type { Database } from "./database.js";

/** The person's notification subscription and its attempt record. */
export function forgetNotifySub(db: Database, userId: string): void {
  db.run("DELETE FROM notify_subs WHERE aad_id = ?", userId);
  db.run("DELETE FROM notify_sub_attempts WHERE aad_id = ?", userId);
}

/** Everything /repo and /sessions remember about the person. */
export function forgetRepos(db: Database, userId: string): void {
  for (const table of ["recent_repos", "pending_repo", "session_history"]) {
    db.run(`DELETE FROM ${table} WHERE aad_id = ?`, userId);
  }
}
