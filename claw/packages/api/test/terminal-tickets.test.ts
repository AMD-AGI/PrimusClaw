// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The terminal's one-time tickets, against a real SQL engine.
 *
 * What these pin is the contract of a ticket, not its shape: it opens once, it
 * opens for a short time, it opens for the session it was minted for, and what
 * the table holds cannot be presented or read. They run on PGlite because the
 * one-shot is `DELETE ... RETURNING`, and a stubbed `db.query` would be asserting
 * that the SQL says so rather than that it does.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_OUTSTANDING_TICKETS_PER_USER, TICKET_TTL_SECONDS, TooManyTicketsError, mintTicket, redeemTicket,
  type TicketGrant,
} from "../src/terminal/tickets.js";
import { terminalTicketsSchemaSql } from "../src/terminal/schema.js";
import { REQUIRED_SCHEMA, missingSchemaObjects } from "../src/infra/schema-guard.js";
import { startHarness, type Harness } from "./scenario-harness.js";

let h: Harness;

before(async () => {
  h = await startHarness();
  for (const sql of terminalTicketsSchemaSql()) await h.sql(sql);
});
beforeEach(async () => { await h.sql("DELETE FROM claw_terminal_tickets"); });
after(async () => { await h?.close(); });

const GRANT: TicketGrant = {
  userId: "u-1",
  sessionId: "s-1",
  target: { workloadId: "wl-1", workspaceId: "ws-a", pod: "wl-1-pod-0", container: "main" },
  cols: 120,
  rows: 32,
  platformKey: "ak-secret-platform-key",
};

test("a ticket opens once and returns what it was minted with", async () => {
  const ticket = await mintTicket(GRANT);
  assert.deepEqual(await redeemTicket(ticket, "s-1"), GRANT);
  assert.equal(await redeemTicket(ticket, "s-1"), null, "the second presentation must find nothing");
});

test("two redemptions racing for one ticket: exactly one wins", async () => {
  const ticket = await mintTicket(GRANT);
  const results = await Promise.all(Array.from({ length: 8 }, () => redeemTicket(ticket, "s-1")));
  assert.equal(results.filter((r) => r !== null).length, 1);
});

test("an expired ticket does not open, and is gone afterwards", async () => {
  const ticket = await mintTicket(GRANT, -1);
  assert.equal(await redeemTicket(ticket, "s-1"), null);
  assert.equal((await h.sql("SELECT 1 FROM claw_terminal_tickets")).length, 0);
});

test("a ticket opens only for the session it was minted for, and is spent by trying the wrong one", async () => {
  const ticket = await mintTicket(GRANT);
  assert.equal(await redeemTicket(ticket, "s-2"), null);
  assert.equal(await redeemTicket(ticket, "s-1"), null, "presenting it elsewhere spends it");
});

test("what is not a ticket is refused without touching the table", async () => {
  await mintTicket(GRANT);
  const before = h.statements.length;
  for (const bad of ["", "x", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}!`, "' OR 1=1 --"]) {
    assert.equal(await redeemTicket(bad, "s-1"), null, JSON.stringify(bad));
  }
  assert.equal(h.statements.slice(before).filter((s) => /DELETE FROM claw_terminal_tickets/.test(s)).length, 0);
  assert.equal((await h.sql("SELECT 1 FROM claw_terminal_tickets")).length, 1, "the real ticket is untouched");
});

test("the table holds neither the ticket nor the key", async () => {
  const ticket = await mintTicket(GRANT);
  const rows = await h.sql("SELECT * FROM claw_terminal_tickets");
  assert.equal(rows.length, 1);
  const dump = JSON.stringify(rows);
  assert.equal(dump.includes(ticket), false, "the ticket itself must not be stored");
  assert.equal(dump.includes(GRANT.platformKey), false, "the SaFE key must be sealed");
  assert.equal(dump.includes("wl-1"), false, "so must the resolved target");
  assert.equal(rows[0].user_id, "u-1");
  assert.equal(rows[0].session_id, "s-1");
});

test("a ticket lives for the contract's 60 seconds at most", async () => {
  assert.ok(TICKET_TTL_SECONDS > 0 && TICKET_TTL_SECONDS <= 60);
  await mintTicket(GRANT);
  const rows = await h.sql(
    "SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::float AS ttl FROM claw_terminal_tickets",
  );
  assert.ok(Number(rows[0].ttl) <= 60, `ttl was ${String(rows[0].ttl)}`);
});

test("a blob that will not open is refused, and spent", async () => {
  const ticket = await mintTicket(GRANT);
  await h.sql("UPDATE claw_terminal_tickets SET sealed = 'AAAA'");
  assert.equal(await redeemTicket(ticket, "s-1"), null);
  assert.equal((await h.sql("SELECT 1 FROM claw_terminal_tickets")).length, 0);
});

test("a ticket that carries no key is refused: there would be nothing to open the shell with", async () => {
  const ticket = await mintTicket({ ...GRANT, platformKey: "" });
  assert.equal(await redeemTicket(ticket, "s-1"), null);
});

test("a user may have only so many tickets outstanding, and a spent one frees a place", async () => {
  const minted: string[] = [];
  for (let i = 0; i < MAX_OUTSTANDING_TICKETS_PER_USER; i++) minted.push(await mintTicket(GRANT));
  await assert.rejects(() => mintTicket(GRANT), TooManyTicketsError);
  // Another user is not affected.
  await mintTicket({ ...GRANT, userId: "u-2" });
  assert.ok(await redeemTicket(minted[0], "s-1"));
  await mintTicket(GRANT);
});

test("minting clears the expired, so the table holds only what is outstanding", async () => {
  await mintTicket(GRANT);
  await mintTicket({ ...GRANT, userId: "u-2" });
  await h.sql("UPDATE claw_terminal_tickets SET expires_at = NOW() - INTERVAL '1 second'");
  assert.equal((await h.sql("SELECT 1 FROM claw_terminal_tickets")).length, 2);
  await mintTicket(GRANT);
  assert.equal((await h.sql("SELECT 1 FROM claw_terminal_tickets")).length, 1);
});

test("the table the DDL makes is the one the schema guard requires, and the DDL can be run twice", async () => {
  const required = REQUIRED_SCHEMA.filter((r) => r.table === "claw_terminal_tickets");
  assert.equal(required.length, 1, "the schema guard must name the table");
  for (const sql of terminalTicketsSchemaSql()) await h.sql(sql);
  const present = await h.sql(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_name = 'claw_terminal_tickets'",
  );
  assert.deepEqual(
    missingSchemaObjects(required, present as { table_name: string; column_name: string }[]),
    [],
  );
});
