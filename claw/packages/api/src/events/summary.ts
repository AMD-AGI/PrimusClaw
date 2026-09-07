// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { db } from "../infra/db.js";
import { estimateTokens } from "../shared/tokens.js";
import { withCompletionLock } from "./completion-lock.js";

export async function publishSummaryIfCurrent(
  sessionId: string,
  summary: string,
  splitIdx: number,
  placeholderCount: number,
): Promise<boolean> {
  const outcome = await withCompletionLock(sessionId, async () => {
    // Corrections share this lock, so validation sees their committed state
    // and cannot publish an old snapshot after they invalidate its summary.
    const result = await db.query(
      `INSERT INTO claw_session_summaries (session_id, summary, summarized_up_to, token_count)
       SELECT $1, $2, $3, $4
        WHERE (SELECT COUNT(*) FROM claw_conversation_turns
                WHERE session_id = $1 AND deleted_at IS NULL
                  AND turn_index < $3 AND is_placeholder) = $5::bigint
       ON CONFLICT (session_id) DO UPDATE
         SET summary = EXCLUDED.summary,
             summarized_up_to = EXCLUDED.summarized_up_to,
             token_count = EXCLUDED.token_count,
             updated_at = NOW()
       RETURNING session_id`,
      [sessionId, summary, splitIdx, estimateTokens(summary), placeholderCount],
    );
    return (result.rowCount ?? 0) > 0;
  });
  return outcome.ran && outcome.result;
}
