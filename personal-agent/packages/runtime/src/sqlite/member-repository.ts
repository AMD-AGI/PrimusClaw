// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** MemberDirectoryRepository on SQLite (tables `teams_users`, `personal_clicks`). */
import type { KnownMember, MemberDirectoryRepository, MemberListEntry } from "@primusclaw/personal-agent";

import type { StoreContext } from "./context.js";
import { col } from "./database.js";

/** Python's `str(m.get(k) or "")`. */
function text(value: unknown): string {
  if (value === null || value === undefined || value === "" || value === false || value === 0) return "";
  return typeof value === "string" ? value : String(value);
}

export class SqliteMemberDirectoryRepository implements MemberDirectoryRepository {
  constructor(private readonly ctx: StoreContext) {}

  rememberMember(channelUserId: string, userId: string, name: string, email = ""): void {
    this.ctx.db.run(
      "INSERT INTO teams_users (teams_id, aad_id, name, updated_at, email) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(teams_id) DO UPDATE SET aad_id = excluded.aad_id, name = excluded.name, updated_at = excluded.updated_at, " +
        "email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE teams_users.email END",
      channelUserId,
      userId,
      name,
      this.ctx.now(),
      email,
    );
  }

  rememberMemberEmails(members: readonly MemberListEntry[]): void {
    for (const member of members) {
      const channelUserId = text(member.id);
      const email = (text(member.email) || text(member.userPrincipalName)).trim();
      if (channelUserId && email.includes("@")) {
        this.ctx.db.run("UPDATE teams_users SET email = ? WHERE teams_id = ? AND email <> ?", email, channelUserId, email);
      }
    }
  }

  knownMembers(limit = 5000): KnownMember[] {
    return this.ctx.db
      .all("SELECT teams_id, aad_id, name, email FROM teams_users ORDER BY updated_at DESC LIMIT ?", limit)
      .map((r) => {
        const email = col.str(r, "email");
        const member = { id: col.str(r, "teams_id"), objectId: col.str(r, "aad_id"), name: col.str(r, "name") };
        return email ? { ...member, email } : member;
      });
  }

  userForChannelId(channelUserId: string): string | null {
    const row = this.ctx.db.get("SELECT aad_id FROM teams_users WHERE teams_id = ?", channelUserId);
    return row ? col.str(row, "aad_id") : null;
  }

  channelIdOf(userId: string): string | null {
    const row = this.ctx.db.get("SELECT teams_id FROM teams_users WHERE aad_id = ? ORDER BY updated_at DESC", userId);
    return row ? col.str(row, "teams_id") : null;
  }

  memberName(userId: string): string | null {
    const row = this.ctx.db.get("SELECT name FROM teams_users WHERE aad_id = ? ORDER BY updated_at DESC", userId);
    return row && col.str(row, "name") ? col.str(row, "name") : null;
  }

  notePersonalClick(userId: string): void {
    this.ctx.db.run("INSERT OR REPLACE INTO personal_clicks (aad_id, at) VALUES (?, ?)", userId, this.ctx.now());
  }

  clickedPersonally(userId: string): boolean {
    return this.ctx.db.get("SELECT 1 AS x FROM personal_clicks WHERE aad_id = ?", userId) !== undefined;
  }
}
