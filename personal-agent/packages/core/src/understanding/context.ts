// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject, JsonValue } from "../json.js";
import { CONTEXT_ITEMS_MAX, clip } from "./limits.js";
import type { NamedPerson } from "./people.js";

/** The fields of a held confirmation (a store row) that `pendingOf` reads. */
export interface HeldConfirmation {
  readonly confirmation_id: string;
  readonly repo: string;
  readonly pr: number;
  readonly kind: string;
  /** Seconds since the epoch. */
  readonly expires_at: number;
}

/** One thing waiting for the person's answer in this chat, as the channel context carries it. */
export interface PendingEntry {
  readonly kind: "confirmation";
  readonly id: string;
  readonly pr: string;
  readonly what: string;
  readonly expires_at: string;
}

/** Python's `datetime.fromtimestamp(t, timezone.utc).isoformat()`: microseconds only when there are any, and `+00:00`. */
function isoUtc(seconds: number): string {
  const whole = Math.floor(seconds);
  const micros = Math.round((seconds - whole) * 1_000_000);
  const base = new Date(whole * 1000).toISOString().slice(0, 19);
  return `${base}${micros ? `.${String(micros).padStart(6, "0")}` : ""}+00:00`;
}

/**
 * What waits for the person's answer in this chat: the held merges and reviews of their GitHub account. Claw's own
 * table is what is true; this tells the assistant what the person is looking at.
 */
export function pendingOf(rows: readonly HeldConfirmation[]): PendingEntry[] {
  return rows.slice(0, CONTEXT_ITEMS_MAX).map((r) => ({
    kind: "confirmation",
    id: clip(r.confirmation_id),
    pr: clip(`${r.repo}#${String(r.pr)}`),
    what: r.kind,
    expires_at: isoUtc(r.expires_at),
  }));
}

/** The remote agent session a chat is attached to: absent (not said), null (attached to none), or the session. */
export type Attached = undefined | null | Readonly<Record<string, unknown>>;

/** `{attached: ...}` of a channel context: the session the chat is attached to, or null; `{}` when not said. */
export function attachedContext(attached: Attached): { attached?: JsonObject | null } {
  if (attached === undefined) return {};
  if (attached === null || typeof attached !== "object" || Array.isArray(attached)) return { attached: null };
  const kept: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(attached)) {
    if (typeof v === "string") kept[k] = clip(v);
    else if (typeof v === "boolean") kept[k] = v;
  }
  return { attached: kept };
}

/** What a channel context is made of. */
export interface ChannelContextInput {
  readonly channelMessageId: string;
  readonly people: readonly NamedPerson[];
  readonly pending: readonly PendingEntry[];
  /** The actions this chat can carry out for the assistant (the capability registry's `channelActions`). */
  readonly actions: readonly JsonObject[];
  /** What this chat can be handed back to carry out itself (`review_for_other`). */
  readonly handoffs?: readonly string[];
  readonly attached?: Attached;
  /** How the message reached this chat; "typed" (the default) says nothing. */
  readonly via?: string;
}

/**
 * The `channel_context` that goes beside a message to the assistant: the people it names, the actions this chat can
 * carry out, what waits for the person here, and, when said, the handoffs, how it came and the attached session. Claw
 * only grounds with it; what may be done is decided there.
 */
export function channelContext(input: ChannelContextInput): JsonObject {
  const via = input.via ?? "typed";
  return {
    channel: "teams",
    channel_message_id: input.channelMessageId,
    people: input.people as unknown as JsonValue,
    actions: input.actions.slice(0, CONTEXT_ITEMS_MAX),
    pending: input.pending as unknown as JsonValue,
    ...(input.handoffs?.length ? { handoffs: [...input.handoffs] } : {}),
    ...(via !== "typed" ? { via } : {}),
    ...attachedContext(input.attached),
  };
}
