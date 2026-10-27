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
  /** The producer epoch: the same ids under a later epoch are different events. "0" when the message has none. */
  epoch: string;
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
  const epoch = event.epoch;
  return { appTaskId, epoch: typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0 ? String(epoch) : "0", eventId };
}

/** One string for a Set: the identity, or null for any other event. */
export function appEventKey(event: Record<string, unknown>): string | null {
  const identity = appEventIdentity(event);
  return identity ? `${identity.appTaskId}\u0000${identity.epoch}\u0000${identity.eventId}` : null;
}

/**
 * Which live app events are worth asking the database about. Ids of one run only
 * go up on first publication, so a repeat (a takeover re-reads a batch) always
 * has an id at or below one already shown. An event above the highest seen for
 * its run on this connection is new and costs no query; the first one seen for a
 * run is checked, because this connection may have missed the original.
 */
export class AppEventOrder {
  private readonly highest = new Map<string, bigint>();

  mayBeRepeat(identity: AppEventIdentity): boolean {
    let id: bigint;
    try { id = BigInt(identity.eventId); } catch { return true; }
    const key = `${identity.appTaskId}\u0000${identity.epoch}`;
    const top = this.highest.get(key);
    if (top === undefined || id <= top) {
      if (top === undefined || id > top) this.highest.set(key, id);
      return true;
    }
    this.highest.set(key, id);
    return false;
  }
}
