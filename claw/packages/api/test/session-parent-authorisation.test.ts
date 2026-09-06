// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who may attach a child session to a parent.
 *
 * A child row is what grants visibility of a parent's tree, so writing one
 * without checking is a cross-tenant attachment. The check used to be a
 * precondition the two creation paths each remembered to run, which makes "did
 * we check?" a property of which branch ran and of a request field the branch
 * is about to persist. These pin the invariant at the write instead: a row
 * carrying a parent cannot be inserted without the witness the authorising read
 * issues, whichever path reaches it.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import {
  insertSessionRow, readParentAuthorisation, type NewSessionRow,
} from "../src/routes/sessions.js";
import { startHarness, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

const OWNER = { userId: "u-owner", roles: [] } as unknown as Parameters<typeof readParentAuthorisation>[2];
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
  const result = await readParentAuthorisation(db, "s-parent", INTRUDER);
  assert.deepEqual(result, {
    statusCode: 403,
    response: { ok: false, error: "parent_session_access_denied" },
  });
});

test("a parent that does not exist is refused rather than treated as unowned", async () => {
  const result = await readParentAuthorisation(db, "s-missing", INTRUDER);
  assert.equal((result as { statusCode?: number }).statusCode, 404);
});

test("a parent whose owner column is null is refused, not open to everyone", async () => {
  // A legacy row with no owner is the shape an "is this mine?" test answers
  // wrongly if it reads an absent owner as a match.
  await seedParent("s-orphan", null);
  assert.equal(
    (await readParentAuthorisation(db, "s-orphan", INTRUDER) as { statusCode?: number }).statusCode,
    403,
  );
});

test("an anonymous caller cannot claim a parent at all", async () => {
  await seedParent("s-parent", "u-owner");
  const result = await readParentAuthorisation(db, "s-parent", null);
  assert.deepEqual(result, {
    statusCode: 401,
    response: { ok: false, error: "authentication required" },
  });
});

test("the owner gets a witness naming the parent it was issued for", async () => {
  await seedParent("s-parent", "u-owner");
  assert.deepEqual(await readParentAuthorisation(db, "s-parent", OWNER), { parentSid: "s-parent" });
});

test("a parented row cannot be written without a witness", async () => {
  // This is the path the create route takes when the request carries no first
  // message: the branch that decides whether to authorise reads the same field
  // it is about to persist, so the write refuses unless the read actually ran.
  await seedParent("s-parent", "u-owner");
  await assert.rejects(
    () => insertSessionRow(db, childRow("s-parent")),
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

test("the authorised write goes through, and an unparented one needs no witness", async () => {
  await seedParent("s-parent", "u-owner");
  await insertSessionRow(db, childRow("s-parent"), { parentSid: "s-parent" });
  assert.equal(
    (await h.sql("SELECT 1 FROM claw_sessions WHERE parent_session_id = 's-parent'")).length, 1,
  );
  await insertSessionRow(db, { ...childRow(null), sessionId: "s-root" });
  assert.equal(
    (await h.sql("SELECT 1 FROM claw_sessions WHERE session_id = 's-root'")).length, 1,
  );
});
