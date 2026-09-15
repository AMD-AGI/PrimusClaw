// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The conversation gate on a session that is being deleted.
 *
 * `agent_status` is what dispatch consults before admitting a message, and
 * `running` means a turn is executing. Deletion cancels every non-terminal run
 * the session had, so by the time the row is hidden nothing is -- but the field
 * used to be left at whatever it happened to hold. Nothing corrects it
 * afterwards either: `reapStuckSessions` skips deleted rows on purpose, there
 * being no gate left to open. On this deployment that left 130 rows reading
 * `running` with nothing running, every one of them deleted.
 *
 * Harmless to dispatch, which cannot reach a deleted session at all. Not
 * harmless to anything that reads the column and believes it.
 */
import { seedSession, startHarness } from "./scenario-harness.js";
import test from "node:test";
import assert from "node:assert/strict";

import { commitSessionDeletion } from "../src/sessions/teardown.js";
import { stubDb, type SeenQuery } from "./support/db-stub.js";

// commitSessionDeletion runs inside inTransaction, which takes its own
// connection: a db.query stub never sees these statements at all.
function sessionUpdate(seen: SeenQuery[]): SeenQuery | undefined {
  return seen.find((q) => q.sql.startsWith("UPDATE claw_sessions SET deleted_at"));
}

test("D1 hiding a session closes the gate it may have been holding", async () => {
  const stub = stubDb();
  try {
    await commitSessionDeletion("s-del");
  } catch { /* the stub answers nothing; only the statements matter */ }
  stub.restore();
  const seen = stub.seen;

  const update = sessionUpdate(seen);
  assert.ok(update, "the session row was never hidden");
  assert.match(
    update.sql,
    /agent_status = CASE WHEN agent_status = 'running' THEN 'idle' ELSE agent_status END/,
    "a deleted session keeps claiming a turn is executing",
  );
});

test("D2 the gate is corrected without flattening how the turn ended", async () => {
  // `failed` and `interrupted` are the record of how the conversation stopped
  // and survive deletion; only the claim that something is still running is
  // false by this point.
  const stub = stubDb();
  try {
    await commitSessionDeletion("s-del");
  } catch { /* the stub answers nothing; only the statements matter */ }
  stub.restore();
  const seen = stub.seen;

  const update = sessionUpdate(seen);
  assert.ok(update);
  assert.doesNotMatch(
    update.sql,
    /agent_status = 'idle',/,
    "an unconditional assignment would erase failed / interrupted",
  );
});

test("D3 the runs are cancelled before the row is hidden", async () => {
  // The order is what makes `idle` true rather than merely tidier: the cancel
  // above is why nothing is executing by the time the gate is rewritten.
  const stub = stubDb();
  try {
    await commitSessionDeletion("s-del");
  } catch { /* the stub answers nothing; only the statements matter */ }
  stub.restore();
  const seen = stub.seen;

  // The cancel is written by `applyTaskStatusTransition`, the one status
  // writer, whose statement needs no join and so carries no table alias.
  const cancel = seen.findIndex((q) => /UPDATE claw_tasks SET status = 'cancelled'/.test(q.sql));
  const hide = seen.findIndex((q) => q.sql.startsWith("UPDATE claw_sessions SET deleted_at"));
  assert.ok(cancel >= 0, "the session's runs were not cancelled");
  assert.ok(hide >= 0, "the session row was never hidden");
  assert.ok(cancel < hide, "the gate was rewritten before the runs it describes were closed");
});

/**
 * D4 the other half of the gate: which turn is holding it.
 *
 * `agent_status` alone does not open the gate. `agent_gate_message_id` names
 * the turn that took it, and every surface that hands the gate back does so
 * only for the turn that owns it -- so a deleted session left pointing at a
 * message that is gone is a latch nobody is left to release. The three cases
 * above read the statement off a stub, which cannot tell a column named in the
 * SET list from one that reaches the row, so this one runs it against Postgres
 * and reads the row back.
 */
test("D4 a deleted session lets go of the turn it was gating, not just of running", async () => {
  const h = await startHarness();
  try {
    await seedSession(h, "s-del", { agentStatus: "running", gateOwner: "m-gone" });

    await commitSessionDeletion("s-del");

    const [row] = await h.sql(
      "SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1",
      ["s-del"],
    );
    assert.equal(row.agent_status, "idle");
    assert.equal(
      row.agent_gate_message_id, null,
      "the gate is still latched on a message the delete removed, so a sibling flow "
      + "waits behind a turn that no longer exists and nothing will ever clear it",
    );
  } finally {
    await h.close();
  }
});
