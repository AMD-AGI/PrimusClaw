// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which of a person's chat surfaces an assistant message goes to ("return to source").
 *
 * A person may have several notification subscriptions, one per chat surface they use (Teams, Slack, ...), each labelled with
 * its surface (`claw_notification_subscriptions.surface`). Sent to all of them, a person who uses two surfaces would read every
 * message twice, and a card answered on one would still wait on the other. So a delivery goes to one surface:
 *
 *  - a message that belongs to a turn started by the person's message goes back to the surface that message came from
 *    (`channel_context.channel`, recorded with the message: `recordAssistantMessage`);
 *  - a proactive one (a work item's update, a needs-you, an approval card, a reminder, a review's result, a run's end) goes to
 *    the surface the person wrote from last (`claw_assistant_surfaces`);
 *  - when the chosen surface has no subscription that takes the event, the next most recently used one is tried, and so on;
 *    when none of the surfaces the person wrote from has one (or they never wrote), every subscription that takes it gets it, as
 *    before the label existed. A person whose subscriptions all name one surface is never narrowed: they get it on each.
 *
 * The order is `preferredSurfaces`, the one place the rule lives, so that a person's own preference can later take its place.
 * Only who is handed the event changes: the outbox, its signing, retries, redelivery and the hourly caps are as they were.
 */
import { NOTIFICATION_SURFACE_DEFAULT, NOTIFICATION_SURFACE_PATTERN } from "@claw/protocol";
import { CLAW_ASSISTANT_ENABLED } from "../config.js";
import type { Querier } from "../infra/db.js";

/** A surface label as given (`NOTIFICATION_SURFACE_PATTERN`, case and surrounding space aside); null for anything else. */
export function surfaceLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim().toLowerCase();
  return NOTIFICATION_SURFACE_PATTERN.test(label) ? label : null;
}

/** The surface a message to the assistant came from: what its channel named (`channel_context.channel`), else Teams. */
export function messageSurface(channel: unknown): string {
  return surfaceLabel(channel) ?? NOTIFICATION_SURFACE_DEFAULT;
}

/** The person's message a turn answers: where a message of that turn goes back to. */
export interface SourceTurn {
  sessionId: string;
  messageId: string;
}

/**
 * Write down that the person wrote from `surface` now, in the transaction that accepts their message.
 */
export async function recordSurfaceUsed(q: Querier, userId: string, surface: string): Promise<void> {
  await q(
    `INSERT INTO claw_assistant_surfaces (user_id, surface, last_inbound_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, surface) DO UPDATE
       SET last_inbound_at = GREATEST(claw_assistant_surfaces.last_inbound_at, EXCLUDED.last_inbound_at)`,
    [userId, surface],
  );
}

/**
 * The rule: the person's surfaces in the order a message to them tries them. First the surface of the message the turn answers
 * (`turn`), when the message is still recorded; then every surface the person has written from, most recent first. Empty when
 * nothing is known: then every subscription gets it (`routeToSurface`).
 */
export async function preferredSurfaces(q: Querier, userId: string, turn?: SourceTurn | null): Promise<string[]> {
  const order: string[] = [];
  if (turn) {
    const row = (await q(
      `SELECT channel_context->>'channel' AS channel FROM claw_assistant_messages
        WHERE session_id = $1 AND message_id = $2 AND user_id = $3`,
      [turn.sessionId, turn.messageId, userId],
    )).rows[0] as { channel: string | null } | undefined;
    if (row) order.push(messageSurface(row.channel));
  }
  const used = (await q(
    "SELECT surface FROM claw_assistant_surfaces WHERE user_id = $1 ORDER BY last_inbound_at DESC, surface",
    [userId],
  )).rows as Array<{ surface: string }>;
  for (const { surface } of used) if (!order.includes(surface)) order.push(surface);
  return order;
}

/**
 * Of the subscriptions that take an event for `userId` (`subs`, each with its `surface`), the ones it goes to: those of the first
 * surface in `preferredSurfaces` that has any, else all of them. Subscriptions of a single surface are returned as they are, without
 * a read. Without the assistant (no record of which surface anyone wrote from) every one is.
 */
export async function routeToSurface<T extends { surface?: string | null }>(
  q: Querier, userId: string, subs: T[], turn?: SourceTurn | null,
): Promise<T[]> {
  if (!CLAW_ASSISTANT_ENABLED) return subs;
  const surfaceOf = (s: T) => s.surface ?? NOTIFICATION_SURFACE_DEFAULT;
  if (new Set(subs.map(surfaceOf)).size <= 1) return subs;
  for (const surface of await preferredSurfaces(q, userId, turn)) {
    const picked = subs.filter((s) => surfaceOf(s) === surface);
    if (picked.length) return picked;
  }
  return subs;
}
