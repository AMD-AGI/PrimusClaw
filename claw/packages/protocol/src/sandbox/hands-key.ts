// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which registry key names a session's sandbox, and how the reserved retention
 * namespace stays separate from it.
 *
 * A container retained because it still holds live work would keep its binding
 * in this same keyspace -- anywhere else and the keepalive sweep never walks it,
 * so it is reclaimed as idle, which is the destruction the retention exists to
 * prevent. Its key's variable part is the fixed marker below followed by the
 * sandbox generation.
 *
 * A session key is the session id verbatim, deliberately and permanently.
 * Re-keying colliding ids was tried and is worse than what it fixed: old and
 * new replicas run together through a rolling upgrade, so one side moving a key
 * the other still reads by its old name produces two divergent bindings for one
 * session -- a live sandbox nothing routes to, and a second one provisioned
 * beside it. Nothing here moves a key, and no reader has to know which form to
 * look under.
 *
 * Separation is carried by the entry's **value** instead, which is where the
 * design puts it: only a retention writes the protection marker, so a
 * pre-existing session entry that happens to sit under the prefix is
 * unambiguously not one. Two rules make that sufficient rather than merely
 * legible, and both are enforced elsewhere: a retention key is only ever
 * *created*, never written over, so it can never take a session's binding; and
 * a deployment already holding such an entry is refused at startup, because
 * there the separation cannot be promised for the generation it collides with.
 */

export const HANDS_KEY_PREFIX = "hands.";

/** The variable part a retention's entry takes, which no session may hold. */
export const RETAINED_PREFIX = "retained-";

/** The registry key for one session's sandbox binding. */
export function handsSessionKey(sessionId: string): string {
  return HANDS_KEY_PREFIX + sessionId;
}

/** The session id a registry key names. */
export function sessionIdFromHandsKey(key: string): string {
  return key.slice(HANDS_KEY_PREFIX.length);
}

/** Whether a registry key sits in the namespace reserved for retentions. */
export function isReservedRetentionKey(key: string): boolean {
  return sessionIdFromHandsKey(key).startsWith(RETAINED_PREFIX);
}

/** Whether an entry's value carries the marker only a retention writes. */
export function isRetentionEntry(value: unknown): boolean {
  return !!value && typeof value === "object"
    && (value as { protected?: unknown }).protected === true;
}
