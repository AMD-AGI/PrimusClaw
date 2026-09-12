// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who may attach a child session to a parent.
 *
 * A child row is what grants visibility of a parent's tree, so writing one
 * without checking is a cross-tenant attachment. Authorisation is resolved on
 * every create, including one that names no parent -- "none was named" is an
 * answer the resolver gives rather than a reason to skip it -- and the write
 * refuses any row whose parent the witness in hand does not name. These pin
 * both halves: what the resolver answers, and what the write demands.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import {
  insertSessionRow, resolveParentAuthorisation, type NewSessionRow,
} from "../src/routes/sessions.js";
import { startHarness, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

const OWNER = { userId: "u-owner", roles: [] } as unknown as Parameters<typeof resolveParentAuthorisation>[2];
const INTRUDER = { userId: "u-intruder", roles: [] } as unknown as typeof OWNER;

function childRow(parentSid: string | null): NewSessionRow {
  return {
    sessionId: `s-child-${Math.abs(parentSid?.length ?? 0)}`,
    name: "child",
    userId: "u-intruder",
    mode: "claw",
    agentStatus: "idle",
    systemPrompt: "",
    config: {},
    parentSid,
    role: "",
  };
}

async function seedParent(sessionId: string, ownerId: string | null): Promise<void> {
  await h.sql(
    "INSERT INTO claw_sessions (session_id, user_id, agent_status) VALUES ($1, $2, 'idle')",
    [sessionId, ownerId],
  );
}

test("a parent somebody else owns is refused", async () => {
  await seedParent("s-parent", "u-owner");
  const result = await resolveParentAuthorisation(db, "s-parent", INTRUDER);
  assert.deepEqual(result, {
    statusCode: 403,
    response: { ok: false, error: "parent_session_access_denied" },
  });
});

test("a parent that does not exist is refused rather than treated as unowned", async () => {
  const result = await resolveParentAuthorisation(db, "s-missing", INTRUDER);
  assert.equal((result as { statusCode?: number }).statusCode, 404);
});

test("a parent whose owner column is null is refused, not open to everyone", async () => {
  // A legacy row with no owner is the shape an "is this mine?" test answers
  // wrongly if it reads an absent owner as a match.
  await seedParent("s-orphan", null);
  assert.equal(
    (await resolveParentAuthorisation(db, "s-orphan", INTRUDER) as { statusCode?: number }).statusCode,
    403,
  );
});

test("an anonymous caller cannot claim a parent at all", async () => {
  await seedParent("s-parent", "u-owner");
  const result = await resolveParentAuthorisation(db, "s-parent", null);
  assert.deepEqual(result, {
    statusCode: 401,
    response: { ok: false, error: "authentication required" },
  });
});

test("the owner gets a witness naming the parent it was issued for", async () => {
  await seedParent("s-parent", "u-owner");
  assert.deepEqual(await resolveParentAuthorisation(db, "s-parent", OWNER), { parentSid: "s-parent" });
});

test("naming no parent is an answer the resolver gives, not a check it skips", async () => {
  // The create route calls this unconditionally, so the absent-parent case has
  // to come back as a witness the write will accept -- and it must not depend
  // on there being a caller, because a create with no parent authorises nothing.
  assert.deepEqual(await resolveParentAuthorisation(db, null, null), { parentSid: null });
  assert.deepEqual(await resolveParentAuthorisation(db, null, OWNER), { parentSid: null });
});

test("a parented row cannot be written under a no-parent witness", async () => {
  // The shape a create takes when it carries no first message. The write is
  // what refuses: a witness saying nothing was authorised cannot stand in for
  // one naming the parent about to be stored.
  await seedParent("s-parent", "u-owner");
  await assert.rejects(
    () => insertSessionRow(db, childRow("s-parent"), { parentSid: null }),
    /parent_not_authorised/,
  );
  assert.equal(
    (await h.sql("SELECT 1 FROM claw_sessions WHERE parent_session_id = 's-parent'")).length,
    0,
    "nothing may be written when the authorisation is absent",
  );
});

test("a witness for one parent does not authorise a different one", async () => {
  await seedParent("s-parent", "u-owner");
  await seedParent("s-other", "u-owner");
  await assert.rejects(
    () => insertSessionRow(db, childRow("s-other"), { parentSid: "s-parent" }),
    /parent_not_authorised/,
  );
});

test("the authorised write goes through, and so does an unparented one", async () => {
  await seedParent("s-parent", "u-owner");
  await insertSessionRow(db, childRow("s-parent"), { parentSid: "s-parent" });
  assert.equal(
    (await h.sql("SELECT 1 FROM claw_sessions WHERE parent_session_id = 's-parent'")).length, 1,
  );
  await insertSessionRow(db, { ...childRow(null), sessionId: "s-root" }, { parentSid: null });
  assert.equal(
    (await h.sql("SELECT 1 FROM claw_sessions WHERE session_id = 's-root'")).length, 1,
  );
});
