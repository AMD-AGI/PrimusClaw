// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { db } from "../infra/db.js";
import { estimateTokens } from "../shared/tokens.js";

async function readTurnTools(sessionId: string, messageId: string | null) {
  let rows: Array<{ data: Record<string, unknown> }>;
  if (messageId) {
    rows = (await db.query(
      `SELECT data FROM claw_session_events
        WHERE session_id = $1 AND deleted_at IS NULL AND data->>'message_id' = $2
        ORDER BY id`,
      [sessionId, messageId],
    )).rows;
  } else {
    const lastCompleteId = (await db.query(
      "SELECT id FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL AND event = 'exec_complete' ORDER BY id DESC LIMIT 1 OFFSET 1",
      [sessionId],
    )).rows[0]?.id || 0;
    rows = (await db.query(
      "SELECT data FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL AND id > $2 ORDER BY id",
      [sessionId, lastCompleteId],
    )).rows;
  }
  const events = rows.map((row) => row.data);
  const toolCalls = events.filter((event) => event.type === "toolUsed" && event.status === "start");
  const toolResults = events
    .filter((event) => event.type === "toolUsed" && event.status === "success")
    .map(({ full_output: _fullOutput, ...event }) => event);
  return { toolCalls, toolResults };
}

/** Persist a completion, allowing a real answer to replace only a sweeper placeholder. */
export async function recordCompletionTurns(
  sessionId: string,
  event: Record<string, unknown>,
  messageId: string | null,
): Promise<void> {
  const { final_text, failed, prompt, interrupted, failure_reason } = event as any;
  if (!final_text && !interrupted && !failed) return;

  const lastIdx = (await db.query(
    "SELECT COALESCE(MAX(turn_index), 0) as max FROM claw_conversation_turns WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  )).rows[0].max;
  if (prompt) {
    await db.query(
      "INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, token_count, message_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [sessionId, lastIdx + 1, "user", prompt, estimateTokens(prompt), messageId],
    );
  }

  const { toolCalls, toolResults } = await readTurnTools(sessionId, messageId);
  const assistantContent = final_text
    || (interrupted ? "[Interrupted by user]" : "")
    || (failed ? `[Task failed: ${failure_reason || "unknown"}]` : "");
  // Called under withCompletionLock; summary publication takes the same lock.
  await db.query(
    `WITH written AS (
       INSERT INTO claw_conversation_turns (
         session_id, turn_index, role, content, tool_calls, tool_results,
         token_count, message_id, is_placeholder
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (session_id, message_id, role)
         WHERE message_id IS NOT NULL AND deleted_at IS NULL
       DO UPDATE SET content = EXCLUDED.content,
                     tool_calls = EXCLUDED.tool_calls,
                     tool_results = EXCLUDED.tool_results,
                     token_count = EXCLUDED.token_count,
                     is_placeholder = FALSE
         WHERE claw_conversation_turns.is_placeholder AND NOT EXCLUDED.is_placeholder
       RETURNING turn_index
     ), invalidated AS (
       DELETE FROM claw_session_summaries s USING written w
        WHERE s.session_id = $1 AND s.summarized_up_to > w.turn_index
     )
     SELECT turn_index FROM written`,
    [sessionId, lastIdx + 2, "assistant", assistantContent, JSON.stringify(toolCalls),
      JSON.stringify(toolResults), estimateTokens(assistantContent), messageId,
      event.completion_source === "sweeper"],
  );
}
