// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The identity of an application's forwarded event (hosting design 5.7).
 *
 * Brain publishes `{type: "appEvent", app_task_id, event}` at least once, and a
 * crash between the publish and the cursor write makes it publish a batch
 * again. The identity that is the same across those repeats is the run and the
 * CloudEvents `id` the application gave the event, so that is what the consumer
 * stores once and what the live stream shows once. Nothing else of the event is
 * read: `data` is the application's.
 */

export interface AppEventIdentity {
  appTaskId: string;
  eventId: string;
}

/** Who sent it and which event it is, or null when `event` is not an `appEvent` that carries both. */
export function appEventIdentity(event: Record<string, unknown>): AppEventIdentity | null {
  if (event.type !== "appEvent") return null;
  const appTaskId = event.app_task_id;
  const inner = event.event;
  if (typeof appTaskId !== "string" || appTaskId === "") return null;
  if (typeof inner !== "object" || inner === null) return null;
  const eventId = (inner as Record<string, unknown>).id;
  if (typeof eventId !== "string" || eventId === "") return null;
  return { appTaskId, eventId };
}

/** One string for a Set: the identity, or null for any other event. */
export function appEventKey(event: Record<string, unknown>): string | null {
  const identity = appEventIdentity(event);
  return identity ? `${identity.appTaskId}\u0000${identity.eventId}` : null;
}
