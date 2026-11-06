// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A say held until its turn ends, in a turn that may still hand a review to the person's channel.
 *
 * A turn handing a review over is answered by the channel, in one message: whether the review started, as whom, how it merges
 * (`review-tools.ts`, `turnHandedOffReview`). A say the router wrote before the handoff in the same turn went out at once and could
 * contradict that answer (2026-11-06: "交给 Wei, Lei 了" and then the channel's "Wei, Lei 还没绑定 GitHub"). So in a turn that can hand
 * off (its channel offers `review_for_other` and its message names someone with a Claw user id), a say is stored as usual but its
 * deliveries are held: not due until HOLD_SECONDS from now, marked `held_for_turn:<message id>`. When the turn hands a review over,
 * they are dropped and the channel's answer stands alone (`dropHeldSays`); when the turn ends, they are due at once
 * (`releaseHeldSays`); if neither comes, they go out at HOLD_SECONDS as any other.
 */
import { CLAW_NOTIFICATIONS_ENABLED } from "../config.js";
import type { Querier } from "../infra/db.js";
import type { TurnMessage } from "./inbound.js";
import type { AssistantSayPayload } from "../notifications/assistant-events.js";

export const HOLD_SECONDS = 120;

export function heldStatus(messageId: string): string {
  return `held_for_turn:${messageId}`;
}

/** Whether a say in this turn is held: its channel can be handed a review for another person, and the message names one. */
export function mayHandOff(message: TurnMessage | null | undefined): boolean {
  const context = message?.context;
  return !!context && context.handoffs.includes("review_for_other") && context.people.some((p) => !!p.user_id);
}

/**
 * The turn handed a review over: its held says never go out on their own. Returns their texts, each once, in the order they were said:
 * the handoff carries them (`AssistantReviewHandoff.held_says`), so the channel's one answer still tells the person what they said.
 */
export async function dropHeldSays(q: Querier, messageId: string): Promise<string[]> {
  if (!CLAW_NOTIFICATIONS_ENABLED) return [];   // (no outbox table: nothing is ever held)
  const r = await q(
    `UPDATE claw_notification_outbox SET dropped_at = NOW(), last_status = 'dropped: the turn handed a review to the channel; carried by the handoff'
      WHERE last_status = $1 AND delivered_at IS NULL AND dropped_at IS NULL
      RETURNING id, event_id, payload->>'text' AS text`,
    [heldStatus(messageId)],
  );
  const rows = (r.rows as Array<{ id: string; event_id: string; text: string | null }>).sort((a, b) => Number(a.id) - Number(b.id));
  const texts = new Map<string, string>();
  for (const row of rows) if (row.text?.trim() && !texts.has(row.event_id)) texts.set(row.event_id, row.text.trim());
  return [...texts.values()];
}

/**
 * The turn ended without handing a review over: its held says are due now. Returns each released say once (its id and what its
 * deliveries carry), for its session event, which was held with it (`outbound.ts`, `announce`).
 */
export async function releaseHeldSays(q: Querier, messageId: string): Promise<Array<{ sayId: string; payload: AssistantSayPayload }>> {
  if (!CLAW_NOTIFICATIONS_ENABLED) return [];   // (no outbox table: nothing is ever held)
  const r = await q(
    `UPDATE claw_notification_outbox SET next_attempt_at = NOW(), last_status = NULL
      WHERE last_status = $1 AND delivered_at IS NULL AND dropped_at IS NULL
      RETURNING event_id, payload`,
    [heldStatus(messageId)],
  );
  const says = new Map<string, AssistantSayPayload>();
  for (const row of r.rows as Array<{ event_id: string; payload: AssistantSayPayload }>) says.set(row.event_id, row.payload);
  return [...says].map(([sayId, payload]) => ({ sayId, payload }));
}

/**
 * The system's start notice of an item told in the turn that began at `since` (`announceStarted` in `tools.ts`: "已开始：#N 标题。…" /
 * "Started #N title. …", a system notice about the item), by its say id; null when there is none. A router say after it in the turn
 * adds to that message (`AssistantSayPayload.amends`) instead of being a second one: the gate found a second message ("任务已建好…")
 * beside that notice every time (2026-11-06), and refusing it lost what else it said.
 */
export async function turnAnnouncedStart(q: Querier, userId: string, since: Date | string, messageId: string): Promise<string | null> {
  // Without notifications there is no channel to show the notice in, and no outbox table to find it by: a say is a message of its own.
  if (!CLAW_NOTIFICATIONS_ENABLED) return null;
  // Of this very turn: the message it answers, kept on the notice's delivery. A notice no channel got has no delivery to say whose it
  // is, and turns of one user can overlap (an ended gate lets an older run speak), so it is never matched by time: a say after it is
  // then a message of its own, which loses nothing (and there is no channel that would join the two). Read from the user's recent
  // messages first (their index), then their deliveries.
  const row = (await q(
    `SELECT s.say_id::text AS say_id FROM claw_assistant_says s
      WHERE s.user_id = $1 AND s.fallback AND s.item_id IS NOT NULL AND s.created_at >= $2
        AND (s.text LIKE '已开始：#%' OR s.text LIKE 'Started #%')
        AND EXISTS (SELECT 1 FROM claw_notification_outbox o WHERE o.event_id = s.say_id::text AND o.payload->>'turn_message_id' = $3)
      ORDER BY s.created_at DESC LIMIT 1`,
    [userId, since, messageId],
  )).rows[0] as { say_id: string } | undefined;
  return row?.say_id ?? null;
}
