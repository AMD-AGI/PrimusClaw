// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An item needs the user and nobody has said so.
 *
 * The assistant is a model: it can be slow, fail, or answer a report without saying anything, and the say it
 * did make can fail to reach anyone. A result nobody hears about is the one outcome the assistant exists to
 * prevent, so the system does not rely on it: an item that has needed the user for
 * `CLAW_ASSISTANT_SILENT_SWEEP_SEC` with no delivered message about that very need is announced in the
 * system's own words, once per need.
 *
 * "Delivered" is the receiver's 2xx (`claw_assistant_says.delivered_at`), not the say having been made: a
 * message that failed to arrive is a message nobody got. The need is `attention_seq`, which goes up each time
 * the item turns to needing the user, so a second need on the same item is a new announcement.
 */
import pino from "pino";
import { CLAW_ASSISTANT_SILENT_SWEEP_SEC } from "../config.js";
import { db } from "../infra/db.js";
import { recordNeedsYouFallback } from "./outbound.js";

const logger = pino({ name: "assistant-silent-sweep" });

const BATCH = 50;

/** The announcement, behind a seam so a test can see which items the sweep chose to announce. */
export const silentSweepPorts = { recordNeedsYouFallback };

/** Returns how many announcements were made. */
export async function tellSilentItems(thresholdSeconds: number = CLAW_ASSISTANT_SILENT_SWEEP_SEC): Promise<number> {
  const items = (await db.query(
    `SELECT w.item_id FROM claw_work_items w
      WHERE w.board_state = 'needs_you'
        AND w.updated_at < NOW() - make_interval(secs => $1::int)
        AND NOT EXISTS (
          SELECT 1 FROM claw_assistant_says s
           WHERE s.item_id = w.item_id AND s.item_attention_seq = w.attention_seq
             AND (s.delivered_at IS NOT NULL OR s.fallback)
        )
      ORDER BY w.updated_at
      LIMIT $2`,
    [thresholdSeconds, BATCH],
  )).rows as Array<{ item_id: string }>;
  let told = 0;
  for (const item of items) {
    try {
      if (await silentSweepPorts.recordNeedsYouFallback({ itemId: item.item_id })) told += 1;
    } catch (err) {
      logger.warn({ err, itemId: item.item_id }, "assistant.needs_you_fallback_failed");
    }
  }
  if (told) logger.warn({ told }, "assistant.told_silent_items");
  return told;
}
