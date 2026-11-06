// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether the user has already been told of something that waits for them: a write held for their confirmation or a scheduled task's
 * card (by its ref, `批准 #a3f9c2`), or what a worker holds for them (by the item's attention). The router is shown every waiting thing
 * with every message, and without this it ended ten replies in a row with the same reminder of one card (2026-11-06). Read from the
 * messages the user was sent and can still see (`claw_assistant_says`, `visible`): a message since the thing began that names its ref,
 * or one about the item under its current attention, is the telling. A new thing, or one whose state changed (a new attention), is untold again.
 */
import { CLAW_NOTIFICATIONS_ENABLED } from "../config.js";
import type { Querier } from "../infra/db.js";
import { CARRIED_BY_HANDOFF } from "./say-hold.js";

/**
 * A stored message the user can still see: not one every delivery of which was dropped (a delivery given up; a say a handed-over turn
 * held is carried by the channel's answer instead, `dropHeldSays`, and counts), and not one a later message of its turn took the place of (`replaces`). Without notifications there are no
 * deliveries: every stored message is what the user was shown.
 */
function visible(s: string): string {
  if (!CLAW_NOTIFICATIONS_ENABLED) return "TRUE";
  // A say a handed-over turn held is dropped as a delivery, but its text goes out in the channel's one answer: that is not hidden.
  const hidden = (o: string) => `${o}.dropped_at IS NOT NULL AND ${o}.last_status IS DISTINCT FROM '${CARRIED_BY_HANDOFF.replace(/'/g, "''")}'`;
  return `NOT EXISTS (SELECT 1 FROM claw_notification_outbox o WHERE o.event_id = ${s}.say_id::text AND ${hidden("o")}
             AND NOT EXISTS (SELECT 1 FROM claw_notification_outbox k WHERE k.event_id = o.event_id AND NOT (${hidden("k")})))
    AND NOT EXISTS (SELECT 1 FROM claw_notification_outbox mine JOIN claw_notification_outbox later
                      ON later.payload->>'replaces' = COALESCE(mine.payload->>'replaces', mine.event_id)
                     AND later.event_id <> mine.event_id AND later.id > mine.id
                    WHERE mine.event_id = ${s}.say_id::text)`;
}

/** A waiting thing named by its ref, and since when it waits. */
export interface RefWaiting { ref: string; since: Date | string }

/** When the user was first told of each ref since it began; refs never told are absent. A ref is hex, so it is matched whole: `#a3f9c2` is
 * not named by `#a3f9c2ff`. */
export async function toldRefs(q: Querier, userId: string, waiting: readonly RefWaiting[]): Promise<Map<string, Date>> {
  if (!waiting.length) return new Map();
  const rows = (await q(
    `SELECT w.ref, MIN(s.created_at) AS at
       FROM unnest($2::text[], $3::timestamptz[]) AS w(ref, since)
       JOIN claw_assistant_says s ON s.user_id = $1 AND s.created_at >= w.since AND s.text ~* ('#' || w.ref || '([^0-9a-f]|$)')
      WHERE ${visible("s")}
      GROUP BY w.ref`,
    [userId, waiting.map((w) => w.ref), waiting.map((w) => new Date(w.since).toISOString())],
  )).rows as Array<{ ref: string; at: Date }>;
  return new Map(rows.map((r) => [r.ref, new Date(r.at)]));
}

/** An item's need, as a hold carries it. */
export interface ItemNeed { itemId: string; attentionSeq: number }

const needKey = (n: ItemNeed): string => `${n.itemId}/${n.attentionSeq}`;

/** When the user was first told of each item under the attention given (keyed `item_id/attention_seq`); needs never told are absent. */
export async function toldNeeds(q: Querier, userId: string, needs: readonly ItemNeed[]): Promise<Map<string, Date>> {
  if (!needs.length) return new Map();
  const rows = (await q(
    `SELECT s.item_id, s.item_attention_seq, MIN(s.created_at) AS at
       FROM unnest($2::text[], $3::int[]) AS n(item_id, seq)
       JOIN claw_assistant_says s ON s.user_id = $1 AND s.item_id = n.item_id AND s.item_attention_seq = n.seq
      WHERE ${visible("s")}
      GROUP BY s.item_id, s.item_attention_seq`,
    [userId, needs.map((n) => n.itemId), needs.map((n) => n.attentionSeq)],
  )).rows as Array<{ item_id: string; item_attention_seq: number; at: Date }>;
  return new Map(rows.map((r) => [needKey({ itemId: r.item_id, attentionSeq: Number(r.item_attention_seq) }), new Date(r.at)]));
}

export function toldNeedAt(told: ReadonlyMap<string, Date>, need: ItemNeed): Date | undefined {
  return told.get(needKey(need));
}
