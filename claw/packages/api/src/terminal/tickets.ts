// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One-time tickets for the terminal's WebSocket.
 *
 * A browser WebSocket cannot send an Authorization header, and the credential
 * that authenticated the request that minted the ticket is not necessarily one
 * the upgrade carries (a cookie it does, an API key or a bearer token it does
 * not). So the upgrade is authenticated by a ticket instead: a random value the
 * caller asked for over an authenticated request, good for one redemption and
 * for a short time, bound to one user and one session.
 *
 * What is stored, and what is not:
 *   - The ticket itself never is. The row is keyed by its SHA-256, so a read of
 *     the table yields nothing that can be presented.
 *   - What the upgrade needs in order to reach the shell -- the resolved pod and
 *     the caller's SaFE key -- is sealed with the same envelope the run
 *     credentials use. The key cannot be fetched again at upgrade time, and the
 *     row is gone within the ticket's lifetime.
 *
 * Redemption is one DELETE ... RETURNING, so two replicas racing for the same
 * ticket cannot both win, and a ticket is spent by being presented, whether or
 * not it then turns out to be for the wrong session or already expired. Expiry
 * is judged by the database clock, not by the replica's.
 */
import { createHash, randomBytes } from "node:crypto";
import { decryptUserEnvValue, encryptUserEnvValue } from "../crypto/user-env.js";
import { db } from "../infra/db.js";

/** The longest a ticket may live. The contract is 60 seconds; this is half. */
export const TICKET_TTL_SECONDS = 30;

/** Tickets one user may have outstanding. A cap on rows, not on terminals. */
export const MAX_OUTSTANDING_TICKETS_PER_USER = 20;

/** Where the shell is: everything the upstream URL is built from. */
export interface ShellTarget {
  workloadId: string;
  workspaceId: string;
  pod: string;
  container: string;
}

export interface TicketGrant {
  userId: string;
  sessionId: string;
  target: ShellTarget;
  cols: number;
  rows: number;
  /** The SaFE key the upstream connection authenticates with. Never logged. */
  platformKey: string;
}

export class TooManyTicketsError extends Error {
  constructor() {
    super("too many outstanding terminal tickets");
    this.name = "TooManyTicketsError";
  }
}

/** 32 random bytes, base64url: 43 characters. Anything else cannot be one. */
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

/**
 * Mint a ticket for `grant`.
 *
 * `ttlSeconds` exists for the tests (a negative one mints an expired ticket);
 * the route never passes it.
 */
export async function mintTicket(
  grant: TicketGrant,
  ttlSeconds: number = TICKET_TTL_SECONDS,
): Promise<string> {
  // Spent and abandoned tickets are removed here, by whoever mints next, so the
  // table needs no sweeper of its own and cannot grow past what is outstanding.
  await db.query("DELETE FROM claw_terminal_tickets WHERE expires_at < NOW()");
  const live = await db.query(
    "SELECT COUNT(*)::int AS n FROM claw_terminal_tickets WHERE user_id = $1 AND expires_at >= NOW()",
    [grant.userId],
  );
  if (Number(live.rows[0]?.n ?? 0) >= MAX_OUTSTANDING_TICKETS_PER_USER) throw new TooManyTicketsError();

  const ticket = randomBytes(32).toString("base64url");
  const sealed = encryptUserEnvValue(JSON.stringify({
    target: grant.target,
    cols: grant.cols,
    rows: grant.rows,
    platform_key: grant.platformKey,
  }));
  await db.query(
    `INSERT INTO claw_terminal_tickets (ticket_hash, user_id, session_id, sealed, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 second'))`,
    [hashTicket(ticket), grant.userId, grant.sessionId, sealed, ttlSeconds],
  );
  return ticket;
}

/**
 * Redeem a ticket for the session it is presented on.
 *
 * Null for every way a ticket can fail -- malformed, unknown, already spent,
 * expired, minted for another session, unreadable -- and the caller cannot tell
 * them apart, which is the point: a probe learns nothing about which.
 */
export async function redeemTicket(ticket: string, sessionId: string): Promise<TicketGrant | null> {
  if (!TICKET_RE.test(ticket)) return null;
  const r = await db.query(
    `DELETE FROM claw_terminal_tickets
      WHERE ticket_hash = $1
      RETURNING user_id, session_id, sealed, (expires_at > NOW()) AS live`,
    [hashTicket(ticket)],
  );
  const row = r.rows[0] as { user_id: string; session_id: string; sealed: string; live: boolean } | undefined;
  if (!row || !row.live || row.session_id !== sessionId) return null;
  try {
    const opened = JSON.parse(decryptUserEnvValue(row.sealed)) as {
      target?: Partial<ShellTarget>; cols?: unknown; rows?: unknown; platform_key?: unknown;
    };
    const t = opened.target;
    if (
      !t || typeof t.workloadId !== "string" || typeof t.workspaceId !== "string"
      || typeof t.pod !== "string" || typeof t.container !== "string"
      || typeof opened.cols !== "number" || typeof opened.rows !== "number"
      || typeof opened.platform_key !== "string" || !opened.platform_key
    ) return null;
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      target: { workloadId: t.workloadId, workspaceId: t.workspaceId, pod: t.pod, container: t.container },
      cols: opened.cols,
      rows: opened.rows,
      platformKey: opened.platform_key,
    };
  } catch {
    // A blob that will not open is permanent; the ticket is already spent.
    return null;
  }
}
