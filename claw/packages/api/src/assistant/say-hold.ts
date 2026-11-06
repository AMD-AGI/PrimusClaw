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

/** The turn handed a review over: its held says never go out. The number of deliveries dropped. */
export async function dropHeldSays(q: Querier, messageId: string): Promise<number> {
  const r = await q(
    `UPDATE claw_notification_outbox SET dropped_at = NOW(), last_status = 'dropped: the turn handed a review to the channel'
      WHERE last_status = $1 AND delivered_at IS NULL AND dropped_at IS NULL`,
    [heldStatus(messageId)],
  );
  return r.rowCount ?? 0;
}

/**
 * The turn ended without handing a review over: its held says are due now. Returns each released say once (its id and what its
 * deliveries carry), for its session event, which was held with it (`outbound.ts`, `announce`).
 */
export async function releaseHeldSays(q: Querier, messageId: string): Promise<Array<{ sayId: string; payload: AssistantSayPayload }>> {
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
 * Whether the turn that began at `since` has had an item's start told to the user in the system's words (`announceStarted` in
 * `tools.ts`: "已开始：#N 标题。…" / "Started #N title. …", a system notice about the item). Its router then says nothing more in that
 * turn: the gate found a second message ("任务已建好…") beside that notice every time (2026-11-06).
 */
export async function turnAnnouncedStart(q: Querier, userId: string, since: Date | string): Promise<boolean> {
  return (await q(
    `SELECT 1 FROM claw_assistant_says
      WHERE user_id = $1 AND fallback AND item_id IS NOT NULL AND created_at >= $2
        AND (text LIKE '已开始：#%' OR text LIKE 'Started #%') LIMIT 1`,
    [userId, since],
  )).rows.length > 0;
}
