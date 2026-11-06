// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An item needs the user and nobody has said so, or an item's answer (`answer`, which closes it) was never said.
 *
 * The assistant is a model: it can be slow, fail, or answer a report without saying anything, and the say it
 * did make can fail to reach anyone. A result nobody hears about is the one outcome the assistant exists to
 * prevent, so the system does not rely on it: an item that has needed the user for
 * `CLAW_ASSISTANT_SILENT_SWEEP_SEC` with no message about that very need that told them (below) is announced in the
 * system's own words, once per need.
 *
 * "Told" is a message that reached a channel, or is on its way to one: the receiver's 2xx
 * (`claw_assistant_says.delivered_at`), or an outbox row for it that is queued and has not failed. A
 * message stored while no subscription could carry it -- the model's say or the system's own fallback
 * alike -- told nobody, and does not count; nor does one whose sends failed or were dropped.
 * The need is `attention_seq`, which goes up each time the item turns to needing the user, so a second
 * need on the same item is a new announcement.
 *
 * An item whose fallback is already stored, and still reached nobody, cannot be told by storing it again
 * (one fallback per need): once a subscription takes its type, the unreached message is queued for it
 * (`resendUnreachedSays`). Until one does, the item is not picked, so it does not hold a place in the
 * batch that another item could use.
 *
 * With notifications off nothing has a channel, and a stored fallback is what the web client shows: there
 * it counts as told.
 */
import pino from "pino";
import { CLAW_ASSISTANT_SILENT_SWEEP_SEC, CLAW_NOTIFICATIONS_ENABLED } from "../config.js";
import { db } from "../infra/db.js";
import { ANSWERED_UNSAID_SQL, recordNeedsYouFallback, resendUnreachedSays, UNREACHED_SAY_SQL } from "./outbound.js";

const logger = pino({ name: "assistant-silent-sweep" });

const BATCH = 50;
const ANSWERED_UNSAID = ANSWERED_UNSAID_SQL;

/** The announcement, behind a seam so a test can see which items the sweep chose to announce. */
export const silentSweepPorts = { recordNeedsYouFallback, resendUnreachedSays };

/** Whether a say already told the user, over `claw_assistant_says s`; see the header. */
const told = (notifications: boolean): string => notifications
  ? `s.delivered_at IS NOT NULL OR EXISTS (
       SELECT 1 FROM claw_notification_outbox o
        WHERE o.event_id = s.say_id::text AND o.dropped_at IS NULL AND o.last_status IS NULL)`
  : "s.delivered_at IS NOT NULL OR s.fallback";

/** Returns how many announcements were made. */
export async function tellSilentItems(
  thresholdSeconds: number = CLAW_ASSISTANT_SILENT_SWEEP_SEC,
  notifications: boolean = CLAW_NOTIFICATIONS_ENABLED,
): Promise<number> {
  const fallbackStored = `EXISTS (
          SELECT 1 FROM claw_assistant_says f
           WHERE f.item_id = w.item_id AND f.item_attention_seq = w.attention_seq AND f.fallback)`;
  const items = (await db.query(
    `SELECT w.item_id, w.user_id, ${fallbackStored} AS fallback_stored FROM claw_work_items w
      WHERE (w.board_state = 'needs_you' OR (${ANSWERED_UNSAID}))
        -- A remote item tells the user itself, and only of what the assistant sent (\`remote-items.ts\`): what they typed into an
        -- attached chat they watched, and is not to be said again.
        AND w.kind <> 'remote'
        AND w.updated_at < NOW() - make_interval(secs => $1::int)
        AND NOT EXISTS (
          SELECT 1 FROM claw_assistant_says s
           WHERE s.item_id = w.item_id AND s.item_attention_seq = w.attention_seq
             AND (${told(notifications)})
        )${notifications ? `
        AND (NOT ${fallbackStored} OR EXISTS (${UNREACHED_SAY_SQL}))` : ""}
      ORDER BY w.updated_at
      LIMIT $2`,
    [thresholdSeconds, BATCH],
  )).rows as Array<{ item_id: string; user_id: string; fallback_stored: boolean }>;
  let toldNow = 0;
  for (const item of items) {
    try {
      if (item.fallback_stored) {
        if (await silentSweepPorts.resendUnreachedSays({ userId: item.user_id, itemId: item.item_id })) toldNow += 1;
      } else if (await silentSweepPorts.recordNeedsYouFallback({ itemId: item.item_id })) {
        toldNow += 1;
      }
    } catch (err) {
      logger.warn({ err, itemId: item.item_id }, "assistant.needs_you_fallback_failed");
    }
  }
  if (toldNow) logger.warn({ told: toldNow }, "assistant.told_silent_items");
  return toldNow;
}
