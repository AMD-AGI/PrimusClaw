// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The table behind the browser terminal's one-time tickets.
 *
 * A ticket is minted by one request and redeemed by another, which is a
 * WebSocket upgrade that no longer carries the caller's credentials. The API
 * runs as several replicas and nothing ties the second request to the replica
 * that served the first, so the ticket has to live where every replica sees it
 * and where taking it is atomic: a row, deleted by the redemption.
 *
 * Statements, not one string, so initDb and the tests' fixture run the same DDL.
 */
export function terminalTicketsSchemaSql(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS claw_terminal_tickets (
       ticket_hash  TEXT PRIMARY KEY,
       user_id      TEXT NOT NULL,
       session_id   TEXT NOT NULL,
       sealed       TEXT NOT NULL,
       expires_at   TIMESTAMPTZ NOT NULL,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    "CREATE INDEX IF NOT EXISTS idx_terminal_tickets_user ON claw_terminal_tickets(user_id, expires_at)",
  ];
}
