// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session born gated names the turn holding it.
 *
 * `POST /v1/sessions` with a `message` pre-flips the new row to
 * `agent_status='running'` in its own INSERT rather than going through
 * `takeSessionGate`, so it is the one path that gates a session without the
 * writer that stamps the marker. It used to leave `agent_gate_message_id`
 * null, which was invisible while nothing read the column.
 *
 * It stopped being invisible when `RUN_FAT_PREPARING_RECONCILE` began
 * defaulting on: `releaseSessionGateIfLastRun` then matches
 * `agent_gate_message_id = $messageId`, and null matches nothing, so the
 * session's very first turn completes and the gate never opens. Every later
 * message parks in `claw_pending_messages` behind it until `reapStuckSessions`
 * comes past a whole `BRAIN_TASK_TIMEOUT_SEC` later. Reproduced against the
 * cluster before the fix: run `completed`, gate `running`, marker null.
 *
 * The pairing is the invariant -- gated and named, or idle and unnamed. A row
 * with one and not the other is the wedge.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { insertSessionRow, type NewSessionRow } from "../src/routes/sessions.js";
import { startHarness, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

const NO_PARENT = { parentSid: null } as unknown as Parameters<typeof insertSessionRow>[2];

function row(over: Partial<NewSessionRow> = {}): NewSessionRow {
  return {
    sessionId: "s-gate",
    name: "gated",
    userId: "u-1",
    mode: "claw",
    agentStatus: "idle",
    systemPrompt: "",
    config: {},
    parentSid: null,
    role: "",
    ...over,
  };
}

async function gateOf(sessionId: string): Promise<{ status: string; marker: string | null }> {
  const rows = await h.sql(
    "SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1",
    [sessionId],
  );
  const r = rows[0] as { agent_status: string; agent_gate_message_id: string | null };
  return { status: r.agent_status, marker: r.agent_gate_message_id };
}

test("a session created around a first message is born naming the turn that holds it", async () => {
  await insertSessionRow(
    h.db ?? (await import("../src/infra/db.js")).db,
    row({ agentStatus: "running", gateMessageId: "claw-first" }),
    NO_PARENT,
  );

  assert.deepEqual(await gateOf("s-gate"), { status: "running", marker: "claw-first" });
});

test("and the completion of that turn is one the gate release can match", async () => {
  // The consequence, through the statement that actually reads the column: an
  // unnamed gate is one no run-scoped caller can hand back.
  const { db } = await import("../src/infra/db.js");
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await insertSessionRow(db, row({ agentStatus: "running", gateMessageId: "claw-first" }), NO_PARENT);

  assert.equal(
    await releaseSessionGateIfLastRun("s-gate", "claw-first", false), true,
    "the turn that was named is the turn that may release it",
  );
  assert.deepEqual(await gateOf("s-gate"), { status: "idle", marker: null });
});

test("a session created with no message is born idle and unnamed", async () => {
  // The other half of the pairing, so the fix cannot be read as "always stamp".
  const { db } = await import("../src/infra/db.js");
  await insertSessionRow(db, row({ sessionId: "s-idle" }), NO_PARENT);

  assert.deepEqual(await gateOf("s-idle"), { status: "idle", marker: null });
});
