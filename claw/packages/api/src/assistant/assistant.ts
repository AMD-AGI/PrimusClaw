// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A user's assistant: one router session that is theirs for good.
 *
 * The session is an ordinary one, so the user talks to it with the ordinary
 * message route. What makes it the assistant is the row in `claw_assistants`,
 * which is server-side and so cannot be claimed by a caller through a session
 * field.
 */
import { CLAW_ASSISTANT_ROUTER_MODEL } from "../config.js";
import { inTransaction, type StatementRunner } from "../infra/db.js";
import { insertSessionRow } from "../routes/sessions.js";

export const ASSISTANT_SESSION_NAME = "助理";

async function newRouterSession(q: StatementRunner, userId: string, sessionId: string): Promise<void> {
  await insertSessionRow(q, {
    sessionId,
    name: ASSISTANT_SESSION_NAME,
    userId,
    mode: "claw",
    agentStatus: "idle",
    systemPrompt: "",
    config: {},
    parentSid: null,
    role: "",
    model: CLAW_ASSISTANT_ROUTER_MODEL || null,
  }, { parentSid: null });
}

/**
 * The caller's assistant session, made on first use. Safe to call twice at once:
 * the row and the session it names are written in one transaction, so the loser
 * of the race finds the winner's and leaves no session of its own behind.
 *
 * A user who deleted the session from the web UI gets a new one in the same row;
 * otherwise deleting it would leave them without an assistant for good.
 */
export async function getOrCreateAssistant(userId: string): Promise<{ sessionId: string; created: boolean }> {
  return inTransaction(async (query) => {
    const q: StatementRunner = { query };
    // The row lock is what lets two replicas decide about a deleted session one at a
    // time. Whether the session is alive is a second statement, after the lock: in
    // one with the join, the waiter would see the new session id beside the old,
    // deleted session's row, and replace a session that had just been replaced.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = (await query(
        "SELECT session_id FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [userId],
      )).rows[0] as { session_id: string } | undefined;
      const live = current && (await query(
        "SELECT 1 FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL", [current.session_id],
      )).rowCount;
      if (current && live) return { sessionId: current.session_id, created: false };
      const sessionId = crypto.randomUUID();
      if (current) {
        await query("UPDATE claw_assistants SET session_id = $2, updated_at = NOW() WHERE user_id = $1", [userId, sessionId]);
        await newRouterSession(q, userId, sessionId);
        return { sessionId, created: true };
      }
      const inserted = await query(
        "INSERT INTO claw_assistants (user_id, session_id) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
        [userId, sessionId],
      );
      if (inserted.rowCount) {
        await newRouterSession(q, userId, sessionId);
        return { sessionId, created: true };
      }
      // Another transaction inserted the row between the read and the write; read it.
    }
    throw new Error("assistant.get_or_create_lost_the_race");
  });
}
