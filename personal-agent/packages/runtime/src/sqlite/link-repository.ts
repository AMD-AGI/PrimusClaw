// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** LinkRepository on SQLite (tables `links`, `pending_keys`, `link_attempts`). */
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  LINK_CODE_TTL_SECONDS,
  type LinkLimits,
  type LinkRepository,
  type RedeemOutcome,
} from "@primusclaw/personal-agent";

import { type StoreContext, type SecurityEventSink, drawCode } from "./context.js";
import { type Row, col } from "./database.js";
import { forgetNotifySub, forgetRepos } from "./forget.js";

/** What became of one typed code, as the security event names it. */
type Attempt = "success" | "wrong" | "used" | "expired" | "locked" | "global_limit";

interface Judged {
  readonly attempt: Attempt;
  readonly row?: Row | undefined;
  readonly lockouts: readonly (readonly ["user" | "global", number, number])[];
}

/** Tables keyed by the person, cleared on unlink. */
const PERSON_TABLES = [
  "links",
  "sessions",
  "conversation_refs",
  "held_events",
  "approvals",
  "assistant_cards",
  "auto_replies",
  "assistant_action_cards",
  "assistant_confirm_cards",
  "observed_groups",
  "observe_cards",
  "pending_requests",
] as const;

/** Tables that also hold the group chats the person bound to a session (`<userId>#<conversation>`). */
const GROUP_KEYED_TABLES = ["remote_state", "remote_permissions", "conversation_refs"] as const;

export class SqliteLinkRepository implements LinkRepository {
  constructor(
    private readonly ctx: StoreContext,
    private readonly limits: LinkLimits,
    private readonly securityEvent: SecurityEventSink,
  ) {}

  get linkWindowSeconds(): number {
    return this.limits.windowSeconds;
  }

  stashPending(key: string): string {
    const code = drawCode(this.ctx.random, CODE_ALPHABET, CODE_LENGTH);
    this.ctx.db.run(
      "INSERT INTO pending_keys (code_hash, key_enc, expires_at) VALUES (?, ?, ?)",
      this.ctx.secrets.primaryHash(code),
      this.ctx.secrets.encrypt(key),
      this.ctx.now() + LINK_CODE_TTL_SECONDS,
    );
    return code;
  }

  redeemPending(userId: string, name: string, code: string, activityId?: string): RedeemOutcome {
    const now = this.ctx.now();
    const judged = this.judge(userId, code.replace(/\s+/g, "").toUpperCase(), now);
    this.securityEvent("link_attempt", { aad_object_id: userId, activity_id: activityId, outcome: judged.attempt });
    for (const [scope, count, limit] of judged.lockouts) {
      this.securityEvent("link_lockout", {
        aad_object_id: userId,
        activity_id: activityId,
        scope,
        count,
        limit,
        window_seconds: this.limits.windowSeconds,
      });
    }
    if (judged.attempt === "locked") return "limited";
    if (judged.attempt === "global_limit") return "global_limit";
    if (judged.attempt !== "success" || judged.row === undefined) return "invalid";
    this.bind(userId, name, judged.row, now);
    return "ok";
  }

  /** The check, the spend and the count, as one step: two requests racing for one code bind it once. */
  private judge(userId: string, normalized: string, now: number): Judged {
    const { db } = this.ctx;
    db.run("DELETE FROM link_attempts WHERE at < ?", now - this.limits.windowSeconds);
    const mine = col.num(db.get("SELECT COUNT(*) AS n FROM link_attempts WHERE aad_id = ?", userId) ?? {}, "n");
    const everyone = col.num(db.get("SELECT COUNT(*) AS n FROM link_attempts") ?? {}, "n");
    if (mine >= this.limits.perUser) return { attempt: "locked", lockouts: [] };
    if (everyone >= this.limits.global) return { attempt: "global_limit", lockouts: [] };
    const hashes = this.ctx.secrets.hashes(normalized);
    const row = db.get(
      `SELECT code_hash, key_enc, expires_at, used FROM pending_keys WHERE code_hash IN (${hashes.map(() => "?").join(",")})`,
      ...hashes,
    );
    const attempt = this.spend(row, now);
    if (attempt === "success") return { attempt, row, lockouts: [] };
    db.run("INSERT INTO link_attempts (aad_id, at) VALUES (?, ?)", userId, now);
    // Judged apart: with the defaults (5 and 100) twenty accounts of five guesses each reach both limits on the same
    // failure, and the global lockout is the one an alert is set on.
    const lockouts: (readonly ["user" | "global", number, number])[] = [];
    if (mine + 1 === this.limits.perUser) lockouts.push(["user", mine + 1, this.limits.perUser]);
    if (everyone + 1 === this.limits.global) lockouts.push(["global", everyone + 1, this.limits.global]);
    return { attempt, lockouts };
  }

  private spend(row: Row | undefined, now: number): Attempt {
    if (row === undefined) return "wrong";
    if (col.bool(row, "used")) return "used";
    if (col.num(row, "expires_at") <= now) return "expired";
    const spent = this.ctx.db.run(
      "UPDATE pending_keys SET used = 1 WHERE code_hash = ? AND used = 0",
      col.str(row, "code_hash"),
    );
    return spent === 1 ? "success" : "used";
  }

  /** A re-link may be another Claw account: its subscription, sessions and repositories must be its own. The wrong
   * codes stay counted until the window ends, or minting a code after every few guesses would make the limit none. */
  private bind(userId: string, name: string, row: Row, now: number): void {
    const { db } = this.ctx;
    db.run("DELETE FROM pending_keys WHERE code_hash = ?", col.str(row, "code_hash"));
    db.run(
      "INSERT OR REPLACE INTO links (aad_id, name, key_enc, created_at) VALUES (?, ?, ?, ?)",
      userId,
      name,
      col.bytes(row, "key_enc"),
      now,
    );
    forgetNotifySub(db, userId);
    forgetRepos(db, userId);
    db.run("DELETE FROM sessions WHERE aad_id = ?", userId);
  }

  takeExpiredPending(): string[] {
    const { db, secrets } = this.ctx;
    const rows = db.all(
      "SELECT code_hash, key_enc FROM pending_keys WHERE expires_at <= ? AND used = 0",
      this.ctx.now(),
    );
    for (const row of rows) db.run("DELETE FROM pending_keys WHERE code_hash = ?", col.str(row, "code_hash"));
    return rows.map((row) => secrets.decrypt(col.bytes(row, "key_enc"))).filter((key): key is string => key !== null);
  }

  getKey(userId: string): string | null {
    const row = this.ctx.db.get("SELECT key_enc FROM links WHERE aad_id = ?", userId);
    return row ? this.ctx.secrets.decrypt(col.bytes(row, "key_enc")) : null;
  }

  unlink(userId: string): void {
    const { db } = this.ctx;
    for (const table of PERSON_TABLES) db.run(`DELETE FROM ${table} WHERE aad_id = ?`, userId);
    forgetRepos(db, userId);
    db.run("DELETE FROM remote_state WHERE aad_id = ?", userId);
    db.run("DELETE FROM remote_permissions WHERE aad_id = ?", userId);
    for (const table of GROUP_KEYED_TABLES) {
      db.run(`DELETE FROM ${table} WHERE substr(aad_id, 1, ?) = ?`, userId.length + 1, `${userId}#`);
    }
    forgetNotifySub(db, userId);
    db.run("UPDATE user_prefs SET brief_trigger_id = NULL WHERE aad_id = ?", userId);
  }

  setClawUserId(userId: string, clawUserId: string): void {
    this.ctx.db.run("UPDATE links SET claw_user_id = ? WHERE aad_id = ?", clawUserId, userId);
  }

  needsClawUserId(userId: string): boolean {
    const row = this.ctx.db.get("SELECT claw_user_id FROM links WHERE aad_id = ?", userId);
    return row !== undefined && !col.bool(row, "claw_user_id");
  }

  clawUserIdOf(userId: string): string | null {
    const row = this.ctx.db.get("SELECT claw_user_id FROM links WHERE aad_id = ?", userId);
    return row && col.bool(row, "claw_user_id") ? col.str(row, "claw_user_id") : null;
  }

  linkedUsers(): string[] {
    return this.ctx.db.all("SELECT aad_id FROM links ORDER BY aad_id").map((r) => col.str(r, "aad_id"));
  }

  userForClawUser(clawUserId: string): string | null {
    const row = this.ctx.db.get("SELECT aad_id FROM links WHERE claw_user_id = ?", clawUserId);
    return row ? col.str(row, "aad_id") : null;
  }

  usersForClawUser(clawUserId: string): string[] {
    return this.ctx.db
      .all("SELECT aad_id FROM links WHERE claw_user_id = ?", clawUserId)
      .map((r) => col.str(r, "aad_id"));
  }
}
